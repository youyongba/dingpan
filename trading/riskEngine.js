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

// onTick 节流: 高频 tick 流(如 aggTrade)下避免每帧都跑 evaluate.
// 策略是"取最新价"——_pendingPrice 一直更新, 到节流间隔后跑一次 evaluate,
// 既不丢 tick 也不会错过 TP/SL: TP/SL 容忍度本就远大于 200ms.
let _lastEvalAt = 0;
let _pendingPrice = null;
let _pendingTimer = null;

function _runEval(price) {
  _lastEvalAt = Date.now();
  _pendingTimer = null;
  ['long', 'short'].forEach(dir => {
    try { evaluate(dir, price); }
    catch (e) { console.error('[trade.risk] evaluate error:', e.message); }
  });
}

function onTick({ price }) {
  if (!Number.isFinite(price)) return;

  const throttle = config.get().priceFeed?.evalThrottleMs || 0;
  if (throttle <= 0) return _runEval(price);

  _pendingPrice = price;
  const now = Date.now();
  const since = now - _lastEvalAt;
  if (since >= throttle) {
    _runEval(_pendingPrice);
  } else if (!_pendingTimer) {
    _pendingTimer = setTimeout(() => _runEval(_pendingPrice), throttle - since);
  }
}

function evaluate(direction, price) {
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
        return fireSl(direction, price, trigger);
      }
    }
    if (!p.tpHit.tp3 && p.tp3 != null && p.tpHit.tp2) {
      const hit = isLong ? above(price, p.tp3) : below(price, p.tp3);
      if (hit) return fireTp(direction, 'tp_3', price);
    }
    if (!p.tpHit.tp2 && p.tp2 != null && p.tpHit.tp1) {
      const hit = isLong ? above(price, p.tp2) : below(price, p.tp2);
      if (hit) return fireTp(direction, 'tp_2', price);
    }
    if (!p.tpHit.tp1 && p.tp1 != null) {
      const hit = isLong ? above(price, p.tp1) : below(price, p.tp1);
      if (hit) return fireTp(direction, 'tp_1', price);
    }
    return;
  }

  // ============ 处理 pending (限价待触发) 计划 ============
  if (p.pending && p.pendingPlan) {
    // 超时 expire
    if (p.pendingExpireAt && Date.now() > p.pendingExpireAt) {
      return firePendingExpired(direction);
    }
    // entry 触达: 多头价格回踩到 entry 以下, 空头反弹到 entry 以上
    const entry = p.pendingPlan.entry;
    if (entry == null || !Number.isFinite(entry)) return;
    const hit = isLong ? price <= entry : price >= entry;
    if (hit) return firePendingFill(direction, price);
  }
}

async function fireTp(direction, level, triggerPrice) {
  if (_inFlight[direction]) return;                    // 双保险: evaluate 已拦, 再兜一道
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  try {
    const setProtection = (level === 'tp_1');
    const tpKey = level === 'tp_1' ? 'tp1' : level === 'tp_2' ? 'tp2' : 'tp3';
    const pBefore = state.getPosition(direction);
    const newSl = setProtection ? pBefore.entryPrice : undefined;

    // ⚠️ 关键: 先写 disk (tpHit.tpN=true) 再发 webhook.
    // 即便后续 webhook 失败, 这个 TP 也已经标记 "已触发", 后续 tick 不会再 fireTp 同 level.
    // 比起 "重复平仓 N 次但每次都成功", 用户更愿意 "可能漏发 1 次平仓 (飞书会告警去人工补)".
    state.markTpHit(direction, tpKey, { newStopLoss: newSl, armProtection: setProtection });

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

    if (level === 'tp_3') {
      state.closeAndUnlock(direction, 'tp_3');
      exec.notify({
        type: 'unlock',
        title: `🔓 ${direction.toUpperCase()} 已自动解锁 (TP3 全部止盈)`,
        lines: [`方向 ${direction} 现可重新接收开仓信号`],
      });
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
async function firePendingFill(direction, fillPrice) {
  if (_inFlight[direction]) return;
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  try {
    const before = state.getPosition(direction);
    if (!before || !before.pending || !before.pendingPlan) return;
    const plan = before.pendingPlan;
    const cfg = config.get();

    // 先写盘: pending → active. plan.entry 作为 entryPrice (限价语义),
    // fillPrice 仅供审计 (滑点 = fillPrice - plan.entry)
    const filled = state.markPendingFilled(direction, fillPrice);

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
        `arm 时间: ${before.pendingArmedAt}`,
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
  } catch (e) {
    console.error('[trade.risk] firePendingFill error:', e?.message || e);
  } finally {
    _inFlight[direction] = false;
  }
}

/**
 * pending 计划超时未触达, 自动取消 — 不发 webhook, 仅清状态 + 通知.
 */
function firePendingExpired(direction) {
  if (_inFlight[direction]) return;
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  try {
    const prev = state.cancelPending(direction, 'ttl_expired');
    if (!prev) return;
    exec.notify({
      type: 'pending_expired',
      title: `⏳ ${direction.toUpperCase()} pending 计划超时未触达, 已自动取消`,
      lines: [
        `symbol: ${config.get().symbol}`,
        `arm 时间: ${prev.pendingArmedAt}`,
        `过期时间: ${new Date(prev.pendingExpireAt).toLocaleString()}`,
        `原 entry: ${prev.pendingPlan?.entry}`,
        `原 SL/TP1: ${prev.pendingPlan?.sl} / ${prev.pendingPlan?.tp1}`,
        `方向 ${direction} 已解锁, 可接收新信号`,
      ],
    });
  } finally {
    _inFlight[direction] = false;
  }
}

async function fireSl(direction, triggerPrice, triggerTag = 'sl') {
  if (_inFlight[direction]) return;
  _inFlight[direction] = true;
  recentlyFired[direction] = Date.now();
  try {
    // 先快照 entryPrice / currentStopLoss 用于通知 (closeAndUnlock 后 state 会清空)
    const pBefore = state.getPosition(direction);
    const snapshot = {
      entryPrice: pBefore?.entryPrice,
      currentStopLoss: pBefore?.currentStopLoss,
    };

    // ⚠️ 关键: 先写 disk (active=false, locked=false) 再发 webhook.
    // 之后 evaluate 看到 active=false 立即 return, 即便 _inFlight 异常没释放也兜得住.
    state.closeAndUnlock(direction, triggerTag);

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
  } finally {
    _inFlight[direction] = false;
  }
}

module.exports = {
  start,
  evaluate,
  _reset: () => {
    recentlyFired.long = 0;
    recentlyFired.short = 0;
    _inFlight.long = false;
    _inFlight.short = false;
    if (_pendingTimer) { clearTimeout(_pendingTimer); _pendingTimer = null; }
    _lastEvalAt = 0;
    _pendingPrice = null;
  },
  __getInFlight: () => ({ ..._inFlight }),       // 仅测试用
};
