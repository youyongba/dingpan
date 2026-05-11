/**
 * ============================================================
 *  trading/riskEngine.js
 *  自动平仓风控引擎
 *
 *  - 监听 priceFeed 'tick' 事件, 对 long/short 两个方向独立检查
 *  - 触发条件后调用 executor 推送平仓 webhook + 通知, 然后改写状态
 *
 *  触发优先级（每个方向独立）：
 *    1. SL  → 全平 + 解锁
 *    2. TP3 → 平 20% + 解锁（按需求, 隐含 TP1/TP2 已触发）
 *    3. TP2 → 平 30%
 *    4. TP1 → 平 50% + 设置保本止损 + armProtection
 *    5. 保本止损（armProtection 后, 价格回到 entryPrice 且 TP2/TP3 未触发）→ 全平 + 解锁
 *
 *  注意：每个 tick 内一个方向最多触发一个动作, 防止抖动重复触发
 * ============================================================
 */
'use strict';

const state = require('./state');
const exec = require('./executor');
const config = require('./config');
const priceFeed = require('./priceFeed');
// TG 渠道仅用于"实际开仓成交"通知 — 与 regime 喊单 (sendTradeSignal) 区分:
// 喊单是建议价位, 这条是真的把 webhook 发出去之后的实际入场.
const tg = require('../notifier/telegram');
const { cnTime } = require('../lib/timeFmt');

// ---------------- 防重复触发 ----------------
//
// 三道闸 (优先级从严到松):
//   A) _inFlight: 进入 fireTp/fireSl 立即 set true, finally 释放. 同方向 evaluate 直接 return,
//      解决 "await postWebhook 期间事件循环切回处理新 tick" 的核心 race condition.
//   B) 状态前置写盘: fireTp 进入第一时间调 state.markTpHit (写 disk), fireSl 进入第一时间
//      调 state.closeAndUnlock (active=false). 即便 _inFlight 因异常路径漏释放, 后续 tick
//      也会被 active=false / tpHit.tpN=true 拦下来.
//   C) recentlyFired 防抖: 同方向 1.5s 冷却, 应对极端情况下的同 tick 重入.
const _inFlight = { long: false, short: false };
const recentlyFired = { long: 0, short: 0 };
const FIRE_COOLDOWN_MS = 1500;

// 价格触发器 (PriceTrigger) 独立的 in-flight 锁: 与 _inFlight (TP/SL/pending) 分离,
// 因为 trigger 命中 → 调 processSignal 这一步可能很慢 (forwardOpen webhook 出站),
// 期间不能阻塞 TP/SL 的 evaluate, 但同方向的 trigger 自己必须挡住重入.
const _ptInFlight = { long: false, short: false };

// processSignal 懒加载 (避免与 router 循环依赖):
// router 现在不 require riskEngine, 但 riskEngine 需要 router.processSignal,
// 用 lazy require 在第一次 fire 时取一次, 缓存 (require 本身是幂等的, 也可直接 require)
let _processSignalCache = null;
function _processSignal() {
  if (!_processSignalCache) {
    try { _processSignalCache = require('./router').processSignal; }
    catch (e) { console.error('[trade.risk] 无法加载 router.processSignal:', e.message); return null; }
  }
  return _processSignalCache;
}

// WS 状态通知冷却 (避免重连失败刷屏)
const WS_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
let lastWsErrorNotifyAt = 0;
let lastWsOpenNotifyAt = 0;
let wsHasBeenConnected = false;

/**
 * 根据当前网络环境(是否已设代理) + 错误类型, 动态生成排障提示.
 * 直连模式 (如海外云主机) 不再误导用户去配置代理.
 */
function buildWsErrorHint(err) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY    || process.env.all_proxy
    || process.env.HTTP_PROXY   || process.env.http_proxy;
  const msg = String(err?.message || err || '');

  if (proxy) {
    if (msg === 'no_first_tick') {
      return `提示: 已走代理 ${proxy}, 握手成功但无 tick 数据, 多半是代理节点不支持 wss 持续连接, 建议换节点`;
    }
    if (msg === 'stale_no_tick') {
      return `提示: 已走代理 ${proxy}, 收过 tick 后断流, 网络抖动或节点限速, 自动重连中`;
    }
    return `提示: 已走代理 ${proxy}, 请确认代理可达 fstream.binance.com:443 且支持 wss`;
  }

  // 直连
  if (msg === 'no_first_tick') {
    return '提示: 直连握手成功但无 tick 数据, 检查机房出网/防火墙/Binance 是否屏蔽该 IP';
  }
  if (msg === 'stale_no_tick') {
    return '提示: 直连收过 tick 后断流, 网络抖动, 自动重连中';
  }
  return '提示: 直连模式, 请确认本机能访问 fstream.binance.com:443 (海外机房通常无需代理)';
}

function start() {
  // 启动时一次性提示: 当前是"零节流安全模式", 旧 evalThrottleMs 已失效
  const cfg = config.get();
  const stream = cfg.priceFeed?.stream || '';
  const legacyThrottle = cfg.priceFeed?.evalThrottleMs || 0;
  console.log(
    `[trade.risk] 🛡 安全模式启动: stream=${stream}, 风控路径**零节流**(每帧 evaluate)` +
    (legacyThrottle > 0 ? ` · ⚠️ 检测到旧 AUTO_TRADE_EVAL_THROTTLE_MS=${legacyThrottle} 已失效, 风控不再节流` : '') +
    (stream === 'btcusdt@markPrice@1s'
      ? ' · ⚠️ 当前价格流为 markPrice@1s (1帧/秒), 想毫秒级触发请改 .env: AUTO_TRADE_STREAM=btcusdt@aggTrade'
      : '')
  );

  priceFeed.on('tick', onTick);
  priceFeed.on('open', () => {
    wsHasBeenConnected = true;
    const now = Date.now();
    // 仅首连 + 冷却外的"重连成功"才通知
    if (now - lastWsOpenNotifyAt > WS_NOTIFY_COOLDOWN_MS) {
      lastWsOpenNotifyAt = now;
      exec.notify({ type: 'ws_ok', title: '🟢 WebSocket 价格源已连接', lines: ['symbol: ' + config.get().symbol] });
    }
  });
  priceFeed.on('close', ({ code, reason }) => {
    console.warn('[trade.risk] WS 关闭:', code, reason);
  });
  priceFeed.on('error', (err) => {
    const now = Date.now();
    if (now - lastWsErrorNotifyAt < WS_NOTIFY_COOLDOWN_MS) return; // 冷却内静默
    lastWsErrorNotifyAt = now;
    exec.notify({
      type: 'error',
      title: '🚨 WebSocket 价格源异常',
      lines: [
        String(err?.message || err),
        buildWsErrorHint(err),
        '后续 5 分钟内同类错误将静默, 不再刷屏',
      ],
      isAlert: true,
    });
  });
  console.log('[trade.risk] 风控引擎已挂载');
}

// ⚠️ 安全核心: onTick 不做任何节流. 每一帧 priceFeed tick 都立即 evaluate.
//
// 历史上为 CPU 顾虑加过 evalThrottleMs (200ms 取最新价), 但这会丢极端行情:
// 200ms 内价格 spike 经过 TP/SL 又回落, 节流后 evaluate 看到的是回落后的价格 → 错过触发.
//
// 现在彻底拿掉节流, 每帧立即 evaluate. evaluate() 是纯内存 + 浮点比较, 即便
// aggTrade 500tps × 双方向 = 1000 次/秒 仍然跑不满 1% vCPU. webhook 重复触发由
// _inFlight + 状态前置写盘 (markTpHit / closeAndUnlock) 兜底, 不会重复下单.
//
// evalThrottleMs 配置项保留但已失效, 仅为兼容旧 .env 不报错; 启动时会日志告警.
let _evalCount = 0;                  // 累计 evaluate 调用次数, 仅用作健康检查
let _lastFireLatencyMs = null;       // 最近一次 tick→fire 触发延迟 (毫秒), 用于 UI 展示
let _maxFireLatencyMs = 0;            // 进程内最大延迟, 帮助发现偶发卡顿

function _recordFireLatency(tickTs) {
  if (!Number.isFinite(tickTs) || tickTs <= 0) return;
  const lat = Date.now() - tickTs;
  _lastFireLatencyMs = lat;
  if (lat > _maxFireLatencyMs) _maxFireLatencyMs = lat;
}

function getRiskTelemetry() {
  return {
    evalCount: _evalCount,
    lastFireLatencyMs: _lastFireLatencyMs,
    maxFireLatencyMs: _maxFireLatencyMs,
  };
}

function _runEval(price, ts) {
  _evalCount++;
  ['long', 'short'].forEach(dir => {
    try { evaluate(dir, price, ts); }
    catch (e) { console.error('[trade.risk] evaluate error:', e.message); }
  });
  // ⭐ 价格触发器评估 — 与 TP/SL/pending 同步在每帧 tick 上做,
  // 触发后内部调 processSignal 走 manual-open / manual-follow 的所有现有幂等链路.
  try { evaluatePriceTriggers(price, ts); }
  catch (e) { console.error('[trade.risk] evaluatePriceTriggers error:', e.message); }
}

function onTick({ price, ts }) {
  if (!Number.isFinite(price)) return;
  // 每一帧都立即评估, 零延迟. ts 透传给 evaluate, 由 fireTp/fireSl 计算 tick→fire 延迟.
  _runEval(price, ts || Date.now());
}

function evaluate(direction, price, tickTs) {
  if (_inFlight[direction]) return;          // 闸 A: webhook 还没发完, 直接拒绝再入
  const p = state.getPosition(direction);
  if (!p) return;
  if (Date.now() - recentlyFired[direction] < FIRE_COOLDOWN_MS) return;  // 闸 C: 防抖

  const isLong = direction === 'long';
  const above = (a, b) => a >= b;   // 多: 价格上穿 TP
  const below = (a, b) => a <= b;   // 多: 价格下穿 SL

  // ============ 优先处理 active 持仓的 TP / SL ============
  if (p.active) {
    if (p.currentStopLoss != null) {
      const slHit = isLong ? below(price, p.currentStopLoss) : above(price, p.currentStopLoss);
      if (slHit) {
        const trigger = p.protectionArmed ? 'sl_protection' : 'sl';
        return fireSl(direction, price, trigger, tickTs);
      }
    }
    if (!p.tpHit.tp3 && p.tp3 != null && p.tpHit.tp2) {
      const hit = isLong ? above(price, p.tp3) : below(price, p.tp3);
      if (hit) return fireTp(direction, 'tp_3', price, tickTs);
    }
    if (!p.tpHit.tp2 && p.tp2 != null && p.tpHit.tp1) {
      const hit = isLong ? above(price, p.tp2) : below(price, p.tp2);
      if (hit) return fireTp(direction, 'tp_2', price, tickTs);
    }
    if (!p.tpHit.tp1 && p.tp1 != null) {
      const hit = isLong ? above(price, p.tp1) : below(price, p.tp1);
      if (hit) return fireTp(direction, 'tp_1', price, tickTs);
    }
    return;
  }

  // ============ 处理 pending (限价待触发) 计划 ============
  // 注意: pending **不再有 TTL 自动过期**. 只有以下三种途径才会清掉:
  //   a) 价格触达 entry → firePendingFill 转 active
  //   b) 反向信号 → cancelPendingByReverseSignal
  //   c) 用户手动 POST /cancel-pending
  if (p.pending && p.pendingPlan) {
    // entry 触达: 多头价格回踩到 entry 以下, 空头反弹到 entry 以上
    const entry = p.pendingPlan.entry;
    if (entry == null || !Number.isFinite(entry)) return;
    const hit = isLong ? price <= entry : price >= entry;
    if (hit) return firePendingFill(direction, price, tickTs);
  }
}

/**
 * 价格触发器评估 — 每帧 tick 都跑.
 *
 * 与 TP/SL/pending evaluate 独立: trigger 命中 → 调 processSignal (有 await 出站 webhook),
 * 不能让它阻塞同方向的 SL/TP. 所以使用单独的 _ptInFlight, 不复用 _inFlight.
 *
 * 触发条件 (与原前端 evaluatePriceTriggers 完全等价):
 *   side='above' : 价格 >= triggerPrice
 *   side='below' : 价格 <= triggerPrice
 *
 * @param {number} price
 * @param {number} tickTs   原始 tick 时间戳 (用于触发延迟统计)
 */
function evaluatePriceTriggers(price, tickTs) {
  if (!Number.isFinite(price) || price <= 0) return;
  const triggers = state.getPriceTriggers();
  for (const dir of ['long', 'short']) {
    if (_ptInFlight[dir]) continue;            // 闸 A: 上一次还没 fire 完
    const t = triggers[dir];
    if (!t || !t.enabled) continue;
    const trigger = Number(t.triggerPrice);
    if (!Number.isFinite(trigger)) continue;
    const hit = (t.side === 'above' && price >= trigger)
              || (t.side === 'below' && price <= trigger);
    if (!hit) continue;
    _ptInFlight[dir] = true;
    // 注意: firePriceTrigger 内部第一步就 state.consumePriceTrigger (写盘 enabled=false),
    // 后续 tick 看到 enabled=false 直接 continue, 即便 _ptInFlight 因异常没释放也兜得住.
    firePriceTrigger(dir, price, tickTs).catch((e) => {
      console.error(`[trade.risk] firePriceTrigger ${dir} 抛出:`, e?.message || e);
    });
  }
}

/**
 * 真正执行价格触发器: 消费 state → 调 processSignal → 通知 → 落审计.
 *
 * action='open'   → /manual-open  的 in-process 版本: 复用 processSignal({action:'open_*'}),
 *                   走 pending 限价分支 (与 regime auto 同一通道)
 * action='follow' → /manual-follow 的 in-process 版本: 设 sig.market=immediate=true,
 *                   skipRegimePlan=true (与手动追单语义完全一致, ATR 动态计算 / 动态仓位)
 */
async function firePriceTrigger(direction, hitPrice, tickTs) {
  _recordFireLatency(tickTs);
  try {
    // ⚠️ 关键: 先 consume 写盘 (enabled=false 立即生效), 再走后续 processSignal.
    //         consumePriceTrigger 是幂等的, 第二次返回 null → 直接放弃, 防止重复触发.
    const prev = state.consumePriceTrigger(direction, hitPrice);
    if (!prev) {
      console.warn(`[trade.risk] ⚠️ ${direction} priceTrigger 已被消费, 拒绝重复 fire`);
      return;
    }
    const action = prev.action === 'follow' ? 'follow' : 'open';
    const cfg = config.get();
    const titleEmoji = direction === 'long' ? '📈' : '📉';
    const triggerStr = Number(prev.triggerPrice).toFixed(2);
    const hitStr = Number(hitPrice).toFixed(2);
    const sideStr = prev.side === 'above' ? '≥' : '≤';

    console.log(`[trade.risk] 🎯 priceTrigger HIT direction=${direction} side=${prev.side} trigger=${triggerStr} hit=${hitStr} action=${action}`);

    // 命中即时推一条飞书 (用户能看见"触发器命中, 即将下单"). 失败的话后面 catch 还会推一条.
    exec.notify({
      type: 'wait',
      title: `${titleEmoji} ${direction.toUpperCase()} 价格触发器命中 → ${action === 'follow' ? '🚀 立即追单' : '📋 挂单'}`,
      lines: [
        `symbol: ${cfg.symbol}`,
        `触发方向: ${direction}`,
        `触发价: ${triggerStr} (${prev.side})`,
        `命中价: ${hitStr} ${sideStr} ${triggerStr}`,
        `启用时间: ${cnTime(prev.armedAt)}`,
        `动作: ${action === 'follow' ? '🚀 立即市价追单 (ATR动态计算)' : '📋 挂单 (优先 regime plan, 无则 ATR 回退)'}`,
      ],
    });

    // 构造 sig, 复用 processSignal 的所有现有 幂等/校验/通知 逻辑 (与 /manual-open / /manual-follow 同源)
    const sig = {
      token: cfg.token,
      action: direction === 'long' ? 'open_long' : 'open_short',
      symbol: cfg.symbol,
    };
    let processOpts;
    if (action === 'follow') {
      // 手动追单逻辑: 一律 ATR 动态计算 + 立即市价 (与 router 的 /manual-follow 完全一致)
      // ATR / 仓位 的计算放在 router 内部 (processSignal 看到 _priceSource='manual_follow_atr' 走对应分支),
      // 这里直接通过 'price_trigger_follow' source 触发, router 会根据 skipRegimePlan + market=true 处理.
      // 简单起见, 我们直接复用 router 内部已有的"手动追单"路径 — 通过暴露的 fireManualFollow.
      sig.market = true;
      sig.immediate = true;
      processOpts = { source: 'price_trigger_follow', skipRegimePlan: true };
      // 注意: 这里没有显式 entry/sl/tp, processSignal 会走 calcLevels 模板回退.
      // 用户硬性要求"追单 = ATR 动态回退方案", router.js 的 /manual-follow 端点会先 computeManualFallbackLevels.
      // 为完全一致, 我们让 router 暴露 fireManualFollowImpl, 这里调它. 见 router.js 改动.
      const fireFn = _getRouterManualFollow();
      if (typeof fireFn === 'function') {
        const r = await fireFn({ direction, source: 'price_trigger_follow', position_size: null });
        return _finalizePriceTriggerResult(direction, prev, hitPrice, r, action);
      }
      // 兜底: 万一拿不到 fireManualFollowImpl 就走 processSignal (模板回退)
    } else {
      // 手动挂单逻辑: 复用 router 的 /manual-open 实现 (regime plan 优先, 无则 ATR 动态计算)
      const fireFn = _getRouterManualOpen();
      if (typeof fireFn === 'function') {
        const r = await fireFn({ direction, source: 'price_trigger_open' });
        return _finalizePriceTriggerResult(direction, prev, hitPrice, r, action);
      }
      // 兜底: 模板回退
      processOpts = { source: 'price_trigger_open' };
    }
    // 兜底路径: 走通用 processSignal (template/regime plan, 不走 ATR 动态)
    const fn = _processSignal();
    if (!fn) {
      state.recordPriceTriggerError(direction, 'router_not_ready');
      return;
    }
    const r = await fn(sig, processOpts);
    return _finalizePriceTriggerResult(direction, prev, hitPrice, r, action);
  } finally {
    _ptInFlight[direction] = false;
  }
}

/** processSignal / manualOpen / manualFollow 返回值统一收尾: 推飞书 + 落 lastError */
function _finalizePriceTriggerResult(direction, prev, hitPrice, r, action) {
  const cfg = config.get();
  const titleEmoji = direction === 'long' ? '📈' : '📉';
  const triggerStr = Number(prev.triggerPrice).toFixed(2);
  const hitStr = Number(hitPrice).toFixed(2);
  // r 形态:
  //   - processSignal 直接返回: { status, body }
  //   - manualOpenImpl / manualFollowImpl 返回: { status, body }  (统一)
  const ok = r && r.status >= 200 && r.status < 300 && r.body && r.body.ok !== false;
  if (!ok) {
    const reason = r?.body?.error || r?.body?.hint || `http_${r?.status || 'unknown'}`;
    state.recordPriceTriggerError(direction, reason);
    exec.notify({
      type: 'open_blocked',
      title: `❌ ${direction.toUpperCase()} 价格触发器命中但 ${action === 'follow' ? '追单' : '挂单'} 失败`,
      lines: [
        `symbol: ${cfg.symbol}`,
        `触发价/命中价: ${triggerStr} / ${hitStr}`,
        `失败原因: ${reason}`,
        `状态码: ${r?.status || '--'}`,
        `触发器已自动消费, 如需重试请重新启用`,
      ],
      isAlert: true,
    });
    console.error(`[trade.risk] ❌ priceTrigger ${direction} fire 失败: ${reason}`);
    return;
  }
  // 成功 — 这里不再推额外飞书, 因为 processSignal/manualOpenImpl/manualFollowImpl 内部
  // 已经推过 "pending_armed" / "open_ok" / forwardOpen 等通知, 不重复刷屏.
  console.log(`[trade.risk] ✅ priceTrigger ${direction} fire 成功 action=${action} status=${r.status}`);
}

// 懒加载 router 暴露的内部函数, 与 _processSignal 同一思路, 避免循环依赖
let _manualOpenImplCache = null;
let _manualFollowImplCache = null;
function _getRouterManualOpen() {
  if (_manualOpenImplCache === null) {
    try { _manualOpenImplCache = require('./router').manualOpenImpl || false; }
    catch (_) { _manualOpenImplCache = false; }
  }
  return _manualOpenImplCache || null;
}
function _getRouterManualFollow() {
  if (_manualFollowImplCache === null) {
    try { _manualFollowImplCache = require('./router').manualFollowImpl || false; }
    catch (_) { _manualFollowImplCache = false; }
  }
  return _manualFollowImplCache || null;
}

async function fireTp(direction, level, triggerPrice, tickTs) {
  if (_inFlight[direction]) return;                    // 双保险: evaluate 已拦, 再兜一道
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  // 触发延迟遥测: 从 tick 到达到此处真正进入 fire 链路的耗时, 衡量"实时性"是否达标
  _recordFireLatency(tickTs);
  try {
    // TP1 保本止损: 由 cfg.tp1Protection 决定 (默认 true).
    //   关掉后 webhook payload 不携带 set_protection_sl/protection_sl_price/protection_sl_order_type
    //   接收方就不会改 SL, 我们也不会把 currentStopLoss 改成 entry.
    const cfg = config.get();
    const tp1ProtectionOn = cfg.tp1Protection !== false;
    const setProtection = (level === 'tp_1') && tp1ProtectionOn;
    const tpKey = level === 'tp_1' ? 'tp1' : level === 'tp_2' ? 'tp2' : 'tp3';
    const pBefore = state.getPosition(direction);
    if (!pBefore || !pBefore.active) {
      // 防御: 仓位已被外部 close (manual_close_all / external SL), 此次 fire 应直接放弃
      console.log(`[trade.risk] fireTp 取消: ${direction} 仓位已不在 active 状态`);
      return;
    }
    const newSl = setProtection ? pBefore.entryPrice : undefined;

    // ⚠️ 关键: 先写 disk (tpHit.tpN=true) 再发 webhook. state.markTpHit 已是幂等的:
    //   - 仓位非 active   → null
    //   - 该 level 已触发 → null  (last-line-of-defense, 防 _inFlight/cooldown 都漏的极端 race)
    // null 时直接退出, 不发 webhook / 不发通知 / 不推监控, 保证"绝对一次"语义.
    const marked = state.markTpHit(direction, tpKey, { newStopLoss: newSl, armProtection: setProtection });
    if (!marked) {
      console.warn(`[trade.risk] ⚠️ ${direction} ${level} markTpHit 返回 null (已触发或非 active), 拒绝重复 fire`);
      return;
    }

    const { res, payload } = await exec.fireTakeProfit(direction, level, { setProtectionSl: setProtection });

    const closePct = ({ tp_1: '50%', tp_2: '30%', tp_3: '20%' })[level];
    const titleEmoji = direction === 'long' ? '📈' : '📉';
    exec.notify({
      type: 'tp',
      title: `${titleEmoji} ${direction.toUpperCase()} ${level.toUpperCase()} 触发 (${closePct} 平仓)`,
      lines: [
        `symbol: ${config.get().symbol}`,
        `方向: ${direction}`,
        `触发价: ${triggerPrice}`,
        `入场价: ${pBefore.entryPrice}`,
        `平仓比例: ${closePct}`,
        `平仓 webhook: ${res.ok ? '✅ 已发送' : '❌ 失败 ' + (res.error || '')}`,
        ...exec.formatPayloadLines(level, payload),
      ],
      isAlert: !res.ok,
    });

    if (setProtection) {
      exec.notify({
        type: 'tp',
        title: `🛡️ ${direction.toUpperCase()} 已成功设置保本止损`,
        lines: [
          `保本止损价 = 入场价 = ${pBefore.entryPrice}`,
          `若价格回踩入场价将触发 100% 平仓 + 自动解锁`,
        ],
      });
    }

    // 推送「交易点位监控系统」: TP 触发 = 完整 payload, comment 标识级别
    // 注意 newSl 是触发后的当前止损 (TP1 保本时 = entry; 否则保持原样)
    const slForMonitor = setProtection ? pBefore.entryPrice : pBefore.currentStopLoss;
    exec.fireMonitorOpen({
      direction,
      entry: pBefore.entryPrice,
      tp1: pBefore.tp1, tp2: pBefore.tp2, tp3: pBefore.tp3,
      sl: slForMonitor,
      comment: `${level.toUpperCase()} 触发 · auto · 平${closePct}` + (setProtection ? ' · 保本止损已上移' : ''),
    });

    if (level === 'tp_3') {
      // closeAndUnlock 已是幂等的, 第二次调用返回 null. 此处必然第一次, 走通知.
      const closed = state.closeAndUnlock(direction, 'tp_3');
      if (closed) {
        exec.notify({
          type: 'unlock',
          title: `🔓 ${direction.toUpperCase()} 已自动解锁 (TP3 全部止盈)`,
          lines: [`方向 ${direction} 现可重新接收开仓信号`],
        });
      }
    }
  } finally {
    _inFlight[direction] = false;
  }
}

/**
 * pending 限价计划触达 entry → 真正发出 forwardOpen webhook + 转 active 仓位.
 *
 * ⚠️ 关键顺序 (与 fireTp/fireSl 一致): **先写盘后发 webhook**.
 *   markPendingFilled 把 pending=false / active=true 落盘后, 后续 tick 看到 pending=false 立即不再 fill,
 *   即便 _inFlight 异常没释放也兜得住. webhook 失败时飞书会告警, 已 active 仓位等待人工处理或下次 SL.
 *
 * @param {'long'|'short'} direction
 * @param {number} fillPrice  当前 tick 的市价
 */
async function firePendingFill(direction, fillPrice, tickTs) {
  if (_inFlight[direction]) return;
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  _recordFireLatency(tickTs);
  try {
    const before = state.getPosition(direction);
    if (!before || !before.pending || !before.pendingPlan) return;
    const plan = before.pendingPlan;
    const cfg = config.get();

    // 先写盘: pending → active. plan.entry 作为 entryPrice (限价语义),
    // fillPrice 仅供审计 (滑点 = fillPrice - plan.entry).
    // markPendingFilled 内部检查 prev.pending, 已 fill 或已 cancel 时返回 null —
    // 此时直接退出, 不重复推 forwardOpen webhook, 防止"同一 entry 限价被填 N 次".
    const filled = state.markPendingFilled(direction, fillPrice);
    if (!filled) {
      console.warn(`[trade.risk] ⚠️ ${direction} markPendingFilled 返回 null (已 fill / 已取消), 拒绝重复 forwardOpen`);
      return;
    }

    // 再推 forwardOpen webhook (与 immediate 模式同一接口, 接收方无感)
    const sig = {
      ...(plan.raw || {}),
      token: cfg.token,
      action: direction === 'long' ? 'open_long' : 'open_short',
      symbol: cfg.symbol,
      stop_loss: plan.sl,
      tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
      position_size: plan.positionSize,
      leverage: plan.leverage ?? cfg.defaultLeverage,
    };
    const r = await exec.forwardOpen(sig);

    const isLong = direction === 'long';
    const slipPct = plan.entry
      ? (((fillPrice - plan.entry) / plan.entry * 100) * (isLong ? 1 : -1)).toFixed(3)
      : null;

    exec.notify({
      type: 'pending_filled',
      title: `${isLong ? '🟢' : '🔴'} ${direction.toUpperCase()} 限价触达 → 已下单`,
      lines: [
        `symbol: ${cfg.symbol}`,
        `arm 时间: ${cnTime(before.pendingArmedAt)}`,
        `计划 entry: ${Number(plan.entry).toFixed(2)}`,
        `实际触发价: ${Number(fillPrice).toFixed(2)} (滑点 ${slipPct ?? '--'}%)`,
        `仓位: ${filled.positionSize} / 杠杆: ${filled.leverage}x`,
        `TP1: ${plan.tp1?.toFixed?.(2)} (50%) · TP2: ${plan.tp2?.toFixed?.(2)} (30%) · TP3: ${plan.tp3?.toFixed?.(2)} (20%)`,
        `SL : ${plan.sl?.toFixed?.(2)} (100%)`,
        `转发开仓 webhook: ${r.res.ok ? '✅ 已发送' : '❌ ' + (r.res.error || r.res.skipped || '')}`,
        ...exec.formatPayloadLines(direction === 'long' ? 'open_long' : 'open_short', r.payload),
      ],
      isAlert: !r.res.ok,
    });

    // 推送「交易点位监控系统」: 限价挂单触达成交 = 完整 payload
    exec.fireMonitorOpen({
      direction,
      entry: plan.entry,
      tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
      sl: plan.sl,
      comment: `限价触达成交 · auto · fill ${Number(fillPrice).toFixed(2)} · 滑点 ${slipPct ?? '--'}%`,
    });

    // 实际开仓 → 同步推送 TG (与 regime 喊单 sendTradeSignal 区分: 这条是真成交了)
    tg.fireAndForget(tg.sendOpenFilled({
      direction,
      symbol: cfg.symbol,
      mode: 'pending_fill',
      entryPrice: filled.entryPrice,        // 与限价语义一致 = plan.entry
      plannedEntry: plan.entry,
      fillPrice,                             // 实际触达瞬间的 WS lastPrice
      tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
      stopLoss: plan.sl,
      positionSize: filled.positionSize,
      leverage: filled.leverage,
      tp1Protection: cfg.tp1Protection !== false,
      priceSource: plan.source || 'regime_plan',
      webhookOk: r.res.ok,
    }));
  } catch (e) {
    console.error('[trade.risk] firePendingFill error:', e?.message || e);
  } finally {
    _inFlight[direction] = false;
  }
}

async function fireSl(direction, triggerPrice, triggerTag = 'sl', tickTs) {
  if (_inFlight[direction]) return;
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  _recordFireLatency(tickTs);
  try {
    // 先快照 entryPrice / currentStopLoss / TP 等位 (closeAndUnlock 后 state 会清空)
    const pBefore = state.getPosition(direction);
    const snapshot = {
      entryPrice: pBefore?.entryPrice,
      currentStopLoss: pBefore?.currentStopLoss,
      tp1: pBefore?.tp1,
      tp2: pBefore?.tp2,
      tp3: pBefore?.tp3,
    };

    // ⚠️ 关键: 先写 disk (active=false, locked=false) 再发 webhook.
    // closeAndUnlock 已是幂等的, 仓位非 active 时返回 null —
    // 用于挡住"内部 fireSl 与外部 stop_loss action 同时进入"的极端 race, 仅一方真正发 SL webhook.
    const closed = state.closeAndUnlock(direction, triggerTag);
    if (!closed) {
      console.warn(`[trade.risk] ⚠️ ${direction} closeAndUnlock 返回 null (已 closed), 拒绝重复 SL fire`);
      return;
    }

    const { res, payload } = await exec.fireStopLoss(direction, { trigger: triggerTag });

    const titleEmoji = triggerTag === 'sl_protection' ? '🛡️' : '🔻';
    const titleText = triggerTag === 'sl_protection'
      ? `${direction.toUpperCase()} 保本止损触发 (100% 全平)`
      : `${direction.toUpperCase()} 止损触发 (100% 全平)`;
    exec.notify({
      type: 'sl',
      title: `${titleEmoji} ${titleText}`,
      lines: [
        `symbol: ${config.get().symbol}`,
        `方向: ${direction}`,
        `触发价: ${triggerPrice}`,
        `入场价: ${snapshot.entryPrice}`,
        `止损价: ${snapshot.currentStopLoss}`,
        `平仓 webhook: ${res.ok ? '✅ 已发送' : '❌ 失败 ' + (res.error || '')}`,
        ...exec.formatPayloadLines(triggerTag, payload),
      ],
      isAlert: true,
    });
    exec.notify({
      type: 'unlock',
      title: `🔓 ${direction.toUpperCase()} 已自动解锁 (止损/保本止损)`,
      lines: [`方向 ${direction} 现可重新接收开仓信号`],
    });

    // 推送「交易点位监控系统」: SL 触发 = 完整 payload, comment 标识
    if (Number.isFinite(snapshot.entryPrice)) {
      exec.fireMonitorOpen({
        direction,
        entry: snapshot.entryPrice,
        tp1: snapshot.tp1,
        tp2: snapshot.tp2,
        tp3: snapshot.tp3,
        sl: snapshot.currentStopLoss,
        comment: `${triggerTag === 'sl_protection' ? '保本止损' : '止损'} 触发 · auto · 100% 全平`,
      });
    }
  } finally {
    _inFlight[direction] = false;
  }
}

module.exports = {
  start,
  evaluate,
  // ============ 实时性遥测 ============
  // tick → fire 触发延迟 (ms): 用户能看到"风控真正以多快的速度响应价格触发"
  // evalCount: 累计 evaluate 调用次数, 用于健康检查 (与 priceFeed.tickRateTps 对照)
  getRiskTelemetry,
  _reset: () => {
    recentlyFired.long = 0;
    recentlyFired.short = 0;
    _inFlight.long = false;
    _inFlight.short = false;
    _lastFireLatencyMs = null;
    _maxFireLatencyMs = 0;
    _evalCount = 0;
  },
  __getInFlight: () => ({ ..._inFlight }),       // 仅测试用
};
