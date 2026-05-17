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
//   C) recentlyFired 防抖: 同方向**短**冷却 200ms, 应对极端情况下的同 tick 重入.
//
// ⚠️ 历史回归 (2026-05): cooldown 曾是 1500ms, 在单根 K 线急速穿过 TP1+TP2+TP3 的行情下,
//    导致 webhook(1-2s) + cooldown(1.5s) 共 2.5-3.5s 内整个方向 evaluate 全锁,
//    待 cooldown 解除时价格已回落, TP2/TP3 永久错过. 现降到 200ms — 因为 markTpHit 幂等
//    + _inFlight 闸已经挡住所有真实 race, cooldown 只是兜底防"_inFlight 异常没释放".
//    单 fireTp 完成后还会自动 _chainEvaluate (用 priceFeed.lastPrice + skipCooldown)
//    把 TP1→TP2→TP3 在同一帧内串起来, 杜绝漏跳级 TP.
const _inFlight = { long: false, short: false };
const recentlyFired = { long: 0, short: 0 };
const FIRE_COOLDOWN_MS = 200;

// ---------------- near-miss 遥测 (排障可观测) ----------------
// 价格已 hit 但被 _inFlight / cooldown 暂时拦下的事件计数 + 最近一次详情.
// 用户在 UI 看到"TP2 没触发"时, 可以直接看这两个计数判断是不是被节流拦了.
let _tpSkippedByInFlight = 0;
let _tpSkippedByCooldown = 0;
let _lastNearMiss = null;        // 最近一次 near-miss 的详情, 给 UI 红字提示
const _NEAR_MISS_LOG_INTERVAL_MS = 1000;   // 同方向 near-miss 日志 1s 内最多一条 (rate limit)
const _lastNearMissLogAt = { long: 0, short: 0 };

/**
 * 探测"价格当前已 hit 某个 TP/SL, 但 evaluate 被 _inFlight / cooldown 挡下"的事件.
 * 不抛错, 仅 log + 累计计数, 给 UI 提供"为啥没触发"的可观测线索.
 *
 * 仅在 active 持仓且 reason 命中时计数, 避免对 pending 仓位误报 (pending fill 不算 near-miss).
 */
function _nearMissCheck(direction, price, reason) {
  if (!Number.isFinite(price)) return;
  const p = state.getPosition(direction);
  if (!p || !p.active) return;
  const isLong = direction === 'long';
  // 找到当前价命中的"应该 fire 但被挡"的 level — 取优先级最高的一级 (SL > TP3 > TP2 > TP1)
  if (p.currentStopLoss != null) {
    const slHit = isLong ? price <= p.currentStopLoss : price >= p.currentStopLoss;
    if (slHit) return _recordNearMiss(direction, p.protectionArmed ? 'sl_protection' : 'sl', price, reason);
  }
  if (!p.tpHit.tp3 && p.tp3 != null && p.tpHit.tp2) {
    if (isLong ? price >= p.tp3 : price <= p.tp3) return _recordNearMiss(direction, 'tp_3', price, reason);
  }
  if (!p.tpHit.tp2 && p.tp2 != null && p.tpHit.tp1) {
    if (isLong ? price >= p.tp2 : price <= p.tp2) return _recordNearMiss(direction, 'tp_2', price, reason);
  }
  if (!p.tpHit.tp1 && p.tp1 != null) {
    if (isLong ? price >= p.tp1 : price <= p.tp1) return _recordNearMiss(direction, 'tp_1', price, reason);
  }
}

function _recordNearMiss(direction, level, price, reason) {
  if (reason === 'in_flight') _tpSkippedByInFlight++;
  else if (reason === 'cooldown') _tpSkippedByCooldown++;
  _lastNearMiss = {
    direction, level, price,
    reason,
    at: new Date().toISOString(),
  };
  const now = Date.now();
  if (now - _lastNearMissLogAt[direction] >= _NEAR_MISS_LOG_INTERVAL_MS) {
    _lastNearMissLogAt[direction] = now;
    console.warn(`[trade.risk] ⚠️ near-miss: ${direction} ${level} 价格已 hit (${price}) 但被 ${reason} 拦下 — 等待解除`);
  }
}

// 价格触发器 (PriceTrigger) 独立的 in-flight 锁: 与 _inFlight (TP/SL/pending) 分离,
// 因为 trigger 命中 → 调 processSignal 这一步可能很慢 (forwardOpen webhook 出站),
// 期间不能阻塞 TP/SL 的 evaluate, 但同方向的 trigger 自己必须挡住重入.
const _ptInFlight = { long: false, short: false };

// 注: 早期版本曾保留 _processSignal 懒加载作为 fire 兜底, 现在 firePriceTrigger
// 一律走 manualOpenImpl / manualFollowImpl (与 HTTP 端点同源), 已移除. 见下方 _getRouterManualOpen / Follow.

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

  // ⭐ Regime 守卫定时器: 与 priceFeed tick 解耦 (regime 数据本身 5min 才更新一次,
  // 高频评估无意义; 跟着 tick 跑反而会因为 require 绕圈拖慢风控热路径).
  // 30s 一轮 + 守卫内部 60s 最小切换间隔 = 趋势变化能在 30~90s 内反映到拦截开关.
  if (_regimeGuardTimer) clearInterval(_regimeGuardTimer);
  _regimeGuardTimer = setInterval(() => {
    try { evaluateRegimeGuard(); }
    catch (e) { console.error('[trade.risk] evaluateRegimeGuard error:', e?.message || e); }
  }, 30000);
  // 启动后立即评估一次 (regimeModule 需要先暖机, 第一次大概率拿不到 snapshot, 静默)
  setTimeout(() => {
    try { evaluateRegimeGuard(); } catch (_) {}
  }, 5000);
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
    // near-miss: 价格 hit 但被节流拦下的累计计数, 帮助快速排障"TP2/TP3 价格到了没触发"
    tpSkippedByInFlight: _tpSkippedByInFlight,
    tpSkippedByCooldown: _tpSkippedByCooldown,
    lastNearMiss: _lastNearMiss,
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
  // ⭐ 价格围栏评估 — 自动方向开关 (autoDisableLong/Short).
  // 与一次性 priceTriggers 完全独立: 围栏是"长期监控、来回切换", 触发器是"命中即消费".
  try { evaluateDirectionGuard(price); }
  catch (e) { console.error('[trade.risk] evaluateDirectionGuard error:', e.message); }
}

// ---------------- 价格围栏 (自动方向开关) ----------------
//
// 设计:
//   - long.threshold  (做多基准): 市价 < threshold → 自动禁多;
//                                   市价 ≥ threshold * (1 + hysteresisPct/100) → 自动解除
//   - short.threshold (做空基准): 市价 > threshold → 自动禁空;
//                                   市价 ≤ threshold * (1 - hysteresisPct/100) → 自动解除
//   - 严格不含边界: long  market < threshold 才拦  / market ≥ threshold*(1+h) 才解
//                   short market > threshold 才拦  / market ≤ threshold*(1-h) 才解
//   - 防抖: 最小切换间隔 (上次切换后 N ms 内不再换状态), 与滞后区间共同生效
//   - 通知: 切换时推一条飞书 + console.log; 不切换时静默
//   - 持久化: cfg.autoDisableLong/Short 通过 config.patch 写盘 (30s 切一次的频率, 写盘 IO 完全不是瓶颈)
//
// 与 cfg.disableLong/Short 是独立位 — processSignal 取或后判断是否拦截.
const _lastGuardSwitchAt = { long: 0, short: 0 };

function evaluateDirectionGuard(price) {
  if (!Number.isFinite(price) || price <= 0) return;
  const cfg = config.get();
  const dg = cfg.directionGuard;
  if (!dg) return;
  const hpct = Number.isFinite(dg.hysteresisPct) ? dg.hysteresisPct : 0;
  const minInterval = Number.isFinite(dg.minSwitchIntervalMs) ? dg.minSwitchIntervalMs : 0;
  const now = Date.now();
  const patches = {};

  // ===== 做多基准 (low floor): price < threshold → 拦多; price ≥ threshold*(1+h) → 解 =====
  const lg = dg.long;
  if (lg && lg.enabled && Number.isFinite(lg.threshold) && lg.threshold > 0) {
    const releaseAbove = lg.threshold * (1 + hpct / 100);
    const currently = !!cfg.autoDisableLong;
    let next = currently;
    if (!currently && price < lg.threshold) next = true;        // 触发拦截
    else if (currently && price >= releaseAbove) next = false;  // 解除
    if (next !== currently && now - _lastGuardSwitchAt.long >= minInterval) {
      patches.autoDisableLong = next;
      _lastGuardSwitchAt.long = now;
      _notifyGuardSwitch('long', next, price, lg.threshold, releaseAbove, hpct);
    }
  } else if (cfg.autoDisableLong) {
    // 围栏被关掉了 (用户 disable enabled 或 threshold 清空) → 立即把 autoDisable 复位为 false,
    // 否则会出现"围栏关了但仍在拦截"的诡异状态.
    patches.autoDisableLong = false;
    console.log('[trade.risk] 🔓 价格围栏(long)已禁用, autoDisableLong 自动复位 false');
  }

  // ===== 做空基准 (high cap): price > threshold → 拦空; price ≤ threshold*(1-h) → 解 =====
  const sg = dg.short;
  if (sg && sg.enabled && Number.isFinite(sg.threshold) && sg.threshold > 0) {
    const releaseBelow = sg.threshold * (1 - hpct / 100);
    const currently = !!cfg.autoDisableShort;
    let next = currently;
    if (!currently && price > sg.threshold) next = true;
    else if (currently && price <= releaseBelow) next = false;
    if (next !== currently && now - _lastGuardSwitchAt.short >= minInterval) {
      patches.autoDisableShort = next;
      _lastGuardSwitchAt.short = now;
      _notifyGuardSwitch('short', next, price, sg.threshold, releaseBelow, hpct);
    }
  } else if (cfg.autoDisableShort) {
    patches.autoDisableShort = false;
    console.log('[trade.risk] 🔓 价格围栏(short)已禁用, autoDisableShort 自动复位 false');
  }

  if (Object.keys(patches).length > 0) {
    config.patch(patches);
  }
}

// ---------------- Regime 守卫 (基于 1H Regime/subRegime 自动控制方向开关) ----------------
//
// 与价格围栏并行的第二个"自动方向开关":
//   - 价格围栏 → 看市价 vs 用户配的基准价 (短期纯价格逻辑)
//   - Regime 守卫 → 看 regimeModule 的 subRegime (中期趋势状态)
// 两者写入不同的 cfg 字段, 由 router.processSignal 三重取或决定是否拦截:
//   manual disableLong/Short || priceGuard autoDisableLong/Short || regimeGuard regimeAutoDisableLong/Short
//
// 评估频率: 每 30s 一次 (regime 数据本身 5min 才更新一次, 高频评估无意义).
// 切换防抖: minSwitchIntervalMs 默认 60s — Regime 偶尔抖动也不要立即翻转开关.
//
// 数据来源: regimeModule.getLatestPlan() 返回 { regime: { subRegime, confidence, ... } }
// 置信度门槛: minConfidence='low'/'medium'/'high', 低于门槛时不应用 Regime 决策.

const _confidenceLevels = { low: 1, medium: 2, high: 3 };
const _lastRegimeGuardSwitchAt = { long: 0, short: 0 };
let _regimeGuardTimer = null;

function evaluateRegimeGuard() {
  const cfg = config.get();
  const rg = cfg.regimeGuard;
  // 守卫总开关关闭 → 把 regimeAutoDisable* 复位为 false (避免幽灵状态)
  if (!rg || !rg.enabled) {
    if (cfg.regimeAutoDisableLong || cfg.regimeAutoDisableShort) {
      console.log('[trade.risk] 🔓 Regime 守卫已禁用, regimeAutoDisable* 自动复位 false');
      config.patch({
        regimeAutoDisableLong: false,
        regimeAutoDisableShort: false,
        regimeAutoLastSubRegime: null,
        regimeAutoLastConfidence: null,
        regimeAutoLastEvalAt: Date.now(),
      });
    }
    return;
  }

  // 拉 regime 快照 (regimeModule 可能还没暖机完, 此时 regime 为空 — 跳过本轮)
  let snapshot;
  try {
    const mod = require('../regimeModule');
    snapshot = mod.getLatestPlan && mod.getLatestPlan();
  } catch (e) {
    console.warn('[trade.risk] regimeGuard: 拉取 regimeModule 失败 (可能未启动):', e?.message || e);
    return;
  }
  const regime = snapshot && snapshot.regime;
  if (!regime || !regime.subRegime) {
    // 还没暖机完 — 静默, 等下一轮
    return;
  }

  // 置信度门槛检查 (regime.confidence 是 'low'/'medium'/'high', 与 cfg.minConfidence 同枚举)
  const minConfNum = _confidenceLevels[rg.minConfidence] || 1;
  const curConfNum = _confidenceLevels[regime.confidence] || 1;
  const confidenceOk = curConfNum >= minConfNum;

  // 根据 subRegime 决定本轮的"应该拦截"标志:
  //   STRONG_BULL  → 拦空  (强多头中前高做空必死)
  //   STRONG_BEAR  → 拦多  (强空头中接刀子必死)
  //   PANIC        → 双向拦 (高 HV 低 ADX, 不开新仓最安全)
  //   UNCLEAR      → 双向拦 (信号互相冲突, 默认 off)
  //   其他状态     → 不拦 (WEAK_BULL/BEAR/RANGE 等, Regime 守卫不干涉)
  const sub = regime.subRegime;
  let shouldBlockLong = false;
  let shouldBlockShort = false;
  let reason = null;
  if (confidenceOk) {
    if (sub === 'STRONG_BULL' && rg.blockShortOnStrongBull) {
      shouldBlockShort = true;
      reason = 'STRONG_BULL → 拦空';
    } else if (sub === 'STRONG_BEAR' && rg.blockLongOnStrongBear) {
      shouldBlockLong = true;
      reason = 'STRONG_BEAR → 拦多';
    } else if (sub === 'PANIC' && rg.blockBothOnPanic) {
      shouldBlockLong = true;
      shouldBlockShort = true;
      reason = 'PANIC → 双向禁';
    } else if (sub === 'UNCLEAR' && rg.blockBothOnUnclear) {
      shouldBlockLong = true;
      shouldBlockShort = true;
      reason = 'UNCLEAR → 双向禁';
    }
  }

  // 切换 + 防抖 + 通知 (long / short 各自独立判断与切换)
  const now = Date.now();
  const minInterval = Number.isFinite(rg.minSwitchIntervalMs) ? rg.minSwitchIntervalMs : 0;
  const patches = { regimeAutoLastSubRegime: sub, regimeAutoLastConfidence: regime.confidence || null, regimeAutoLastEvalAt: now };
  let changed = false;

  ['long', 'short'].forEach(dir => {
    const key = dir === 'long' ? 'regimeAutoDisableLong' : 'regimeAutoDisableShort';
    const currently = !!cfg[key];
    const next = dir === 'long' ? shouldBlockLong : shouldBlockShort;
    if (next !== currently && now - _lastRegimeGuardSwitchAt[dir] >= minInterval) {
      patches[key] = next;
      _lastRegimeGuardSwitchAt[dir] = now;
      _notifyRegimeGuardSwitch(dir, next, sub, regime, reason);
      changed = true;
    }
  });

  if (changed || patches.regimeAutoLastSubRegime !== cfg.regimeAutoLastSubRegime) {
    config.patch(patches);
  }
}

function _notifyRegimeGuardSwitch(direction, willBeDisabled, subRegime, regime, reason) {
  const dirZh = direction === 'long' ? '做多' : '做空';
  const dirEn = direction.toUpperCase();
  const titleEmoji = willBeDisabled ? '📊🚫' : '📊✅';
  console.log(`[trade.risk] ${titleEmoji} Regime 守卫自动${willBeDisabled ? '禁止' : '恢复'}${dirZh}: subRegime=${subRegime} reason=${reason || '状态变化'}`);
  exec.notify({
    type: willBeDisabled ? 'open_blocked' : 'unlock',
    title: `${titleEmoji} Regime 守卫自动${willBeDisabled ? '禁止' : '恢复'}${dirZh} (${dirEn})`,
    lines: [
      `symbol: ${config.get().symbol}`,
      `Regime 状态: ${regime.label || '?'} / ${regime.subLabel || subRegime} (置信度 ${regime.confidenceLabel || regime.confidence || '?'})`,
      willBeDisabled
        ? `触发逻辑: ${reason} — 拦截该方向所有新信号 (仅拦 processSignal, 不影响已有持仓)`
        : `解除原因: Regime 离开了"应禁止"区间, 该方向恢复接收新信号`,
      `cfg.regimeAutoDisable${direction === 'long' ? 'Long' : 'Short'}=${willBeDisabled}; 与手动 disable* + 价格围栏 取或后决定是否拦`,
      willBeDisabled
        ? `已有 ${dirEn} 持仓的 TP/SL 不受影响; 已有 pending 仍会触达 entry fill`
        : '提醒: Regime 是 1H 级别, 状态切换通常意味着趋势反转, 留意确认',
    ],
  });
}

function _notifyGuardSwitch(direction, willBeDisabled, price, threshold, releaseLevel, hpct) {
  const dirZh = direction === 'long' ? '做多' : '做空';
  const dirEn = direction.toUpperCase();
  const titleEmoji = willBeDisabled ? '🤖🚫' : '🤖✅';
  const triggerExp = direction === 'long'
    ? `市价 ${price.toFixed(2)} < 做多基准 ${threshold.toFixed(2)}`
    : `市价 ${price.toFixed(2)} > 做空基准 ${threshold.toFixed(2)}`;
  const releaseExp = direction === 'long'
    ? `市价回升至 ${releaseLevel.toFixed(2)} 以上 (含 ${hpct}% 滞后缓冲)`
    : `市价回落至 ${releaseLevel.toFixed(2)} 以下 (含 ${hpct}% 滞后缓冲)`;
  console.log(`[trade.risk] ${titleEmoji} 价格围栏自动${willBeDisabled ? '禁止' : '恢复'}${dirZh}: ${triggerExp}`);
  exec.notify({
    type: willBeDisabled ? 'open_blocked' : 'unlock',
    title: `${titleEmoji} 价格围栏自动${willBeDisabled ? '禁止' : '恢复'}${dirZh} (${dirEn})`,
    lines: [
      `symbol: ${config.get().symbol}`,
      willBeDisabled
        ? `触发条件: ${triggerExp} — 已涨/跌出围栏外, 自动拦截该方向新信号`
        : `解除条件: ${releaseExp} — 已回到围栏内, 该方向恢复接收新信号`,
      willBeDisabled
        ? `cfg.autoDisable${direction === 'long' ? 'Long' : 'Short'}=true; 与手动 disable* 取或后决定是否拦`
        : `cfg.autoDisable${direction === 'long' ? 'Long' : 'Short'}=false; 若手动 disable* 仍为 true, 仍会被拦`,
      willBeDisabled
        ? `已有 ${dirEn} 持仓的 TP/SL 不受影响; 已有 pending 仍会触达 entry fill`
        : '提醒: 价格再次跨过基准会再次触发, 注意滞后缓冲',
    ],
  });
}

function onTick({ price, ts }) {
  if (!Number.isFinite(price)) return;
  // 每一帧都立即评估, 零延迟. ts 透传给 evaluate, 由 fireTp/fireSl 计算 tick→fire 延迟.
  _runEval(price, ts || Date.now());
}

/**
 * 评估一个方向当前是否需要触发 SL / TP / pending fill.
 *
 * @param {'long'|'short'} direction
 * @param {number} price        当前 tick 价 (or 链式接力时的 priceFeed.lastPrice)
 * @param {number} tickTs       tick 时间戳 (用于 fire 延迟遥测)
 * @param {{skipCooldown?:boolean}} [opts]
 *   skipCooldown=true: 跳过 200ms 冷却 — 仅 fireTp 内部链式接力使用,
 *   因为 markTpHit 幂等 + _inFlight 仍生效, 不存在重复 fire 风险, 但能保证
 *   单帧内 TP1→TP2→TP3 能连续触发, 杜绝行情急涨时的跳级漏触发.
 */
function evaluate(direction, price, tickTs, opts = {}) {
  if (_inFlight[direction]) {
    // 闸 A: webhook 还没发完, 直接拒绝再入. 但记一笔 near-miss 计数, 帮助排障.
    _nearMissCheck(direction, price, 'in_flight');
    return;
  }
  const p = state.getPosition(direction);
  if (!p) return;
  if (!opts.skipCooldown && Date.now() - recentlyFired[direction] < FIRE_COOLDOWN_MS) {
    // 闸 C: 200ms 防抖. near-miss 时记录, 让 UI 能展示"刚被冷却挡了 1 帧, 即将解除"
    _nearMissCheck(direction, price, 'cooldown');
    return;
  }

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
 * 多触发器 + 成交锁语义:
 *   - 每方向有 items[] 多条触发器, 任意一条命中即 fire
 *   - 同方向 _ptInFlight 锁: 上一条 fire 还没完成 → 跳过同方向所有 evaluate
 *   - 同方向 slot.locked=true (上一次 fire 成功) → 整个方向跳过, 即便 items[] 被填回也不再 fire
 *   - 同帧只挑第一条 hit → break (避免一次性触发多条; 后续依靠 fire 成功后的 lock 拦)
 *
 * @param {number} price
 * @param {number} tickTs   原始 tick 时间戳 (用于触发延迟统计)
 */
function evaluatePriceTriggers(price, tickTs) {
  if (!Number.isFinite(price) || price <= 0) return;
  const triggers = state.getPriceTriggers();
  for (const dir of ['long', 'short']) {
    if (_ptInFlight[dir]) continue;                  // 闸 A: 同方向 fire 中
    const slot = triggers[dir];
    if (!slot || slot.locked) continue;              // 闸 D: 成交锁
    if (!Array.isArray(slot.items) || slot.items.length === 0) continue;
    for (const t of slot.items) {
      if (!t || !t.id) continue;
      const trigger = Number(t.triggerPrice);
      if (!Number.isFinite(trigger)) continue;
      const hit = (t.side === 'above' && price >= trigger)
                || (t.side === 'below' && price <= trigger);
      if (!hit) continue;
      _ptInFlight[dir] = true;
      // firePriceTrigger 内部: 先 consumePriceTrigger 原子按 id 删, 再走 manualOpenImpl/FollowImpl.
      // 即便 _ptInFlight 异常没释放, items[] 已没这条 id, 后续 evaluate 也匹配不到.
      firePriceTrigger(dir, t.id, price, tickTs).catch((e) => {
        console.error(`[trade.risk] firePriceTrigger ${dir} 抛出:`, e?.message || e);
      });
      break;   // 同方向同帧只处理第一条 hit, 等 fire 完根据 lock 决定是否继续
    }
  }
}

/**
 * 真正执行价格触发器: 按 id 原子消费 → 调 manualOpenImpl/FollowImpl → fire 成功后锁方向.
 *
 * action='open'   → manualOpenImpl   (regime plan 优先 / ATR 动态回退, 走 pending 限价)
 * action='follow' → manualFollowImpl (ATR 动态计算 / 立即市价 forwardOpen)
 *
 * fire 成功后调用 state.markPriceTriggerFiredLock(direction, prev):
 *   - 清空该方向 items[] 剩余所有触发器
 *   - 设 locked=true, 后续 tick 直接跳过该方向
 *   - 推一条"已锁定 + 清除 N 条剩余触发器"飞书 (用户能看见成交锁生效)
 *
 * fire 失败 → 不锁, 不清, 只 recordPriceTriggerError 把原因写盘供 UI 红字提示.
 */
async function firePriceTrigger(direction, triggerId, hitPrice, tickTs) {
  _recordFireLatency(tickTs);
  try {
    // ⚠️ 关键: 先按 id 原子 consume (写盘把这条从 items[] 删掉), 再走 manualOpenImpl/FollowImpl.
    //         consumePriceTrigger 是幂等的, 第二次返回 null → 直接放弃, 防止重复触发.
    const prev = state.consumePriceTrigger(direction, triggerId, hitPrice);
    if (!prev) {
      console.warn(`[trade.risk] ⚠️ ${direction} priceTrigger id=${triggerId} 已被消费/已锁/不存在, 拒绝重复 fire`);
      return;
    }
    const action = prev.action === 'follow' ? 'follow' : 'open';
    const cfg = config.get();
    const titleEmoji = direction === 'long' ? '📈' : '📉';
    const triggerStr = Number(prev.triggerPrice).toFixed(2);
    const hitStr = Number(hitPrice).toFixed(2);
    const sideStr = prev.side === 'above' ? '≥' : '≤';

    // ⭐ 覆盖式语义 (用户硬性要求, 2026-05 修复"触发到了没按方案挂单"事故):
    //   同方向若已有 pending 计划 → 自动取消, 让新 plan 能 arm 上去.
    //   不影响 active 真实持仓 (active+pending 互斥, cancelPending 内部 !prev.pending 也会
    //   返回 null; 这里再加一道 !beforePos.active 显式防御, 双保险防误清真实仓位).
    //   监控通道同步推 fireMonitorCancel, 让独立监控端时间线对齐 (紧接着 manualOpenImpl/Follow
    //   内部会 fireMonitorOpen 推新点位); 飞书通知里明示"已覆盖原 pending"让用户感知.
    //   ⚠️ fire 后续若失败, 旧 pending 也不再回滚 — 触发器命中的语义就是"我要换计划",
    //   用户在 fire 失败的飞书告警里能看到原 pending 信息, 自行决定是否重 arm.
    let overridden = null;
    const beforePos = state.getPosition(direction);
    if (beforePos && beforePos.pending && !beforePos.active) {
      overridden = state.cancelPending(direction, 'price_trigger_override');
      if (overridden) {
        console.log(`[trade.risk] 🔄 priceTrigger ${direction} 覆盖式生效: 取消旧 pending entry=${overridden.pendingPlan?.entry} armed=${overridden.pendingArmedAt}`);
        try { exec.fireMonitorCancel({ direction }); } catch (_) {}
      }
    }

    console.log(`[trade.risk] 🎯 priceTrigger HIT direction=${direction} id=${triggerId} side=${prev.side} trigger=${triggerStr} hit=${hitStr} action=${action}${overridden ? ' (覆盖旧 pending)' : ''}`);

    // 命中即时推一条飞书 (用户能看见"触发器命中, 即将下单"). 失败的话后面 catch 还会推一条.
    const overrideLine = overridden
      ? `🔄 已自动覆盖原 pending: entry=${Number(overridden.pendingPlan?.entry).toFixed(2)} · armed=${cnTime(overridden.pendingArmedAt)}`
      : null;
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
        overrideLine,
      ].filter(Boolean),
    });

    // 执行 fire — 复用 router 暴露的 manualOpenImpl / manualFollowImpl (与 HTTP 端点同一实现)
    let r;
    if (action === 'follow') {
      const fireFn = _getRouterManualFollow();
      if (typeof fireFn !== 'function') {
        state.recordPriceTriggerError(direction, 'manualFollowImpl_not_ready');
        return;
      }
      r = await fireFn({ direction, source: 'price_trigger_follow', position_size: null });
    } else {
      const fireFn = _getRouterManualOpen();
      if (typeof fireFn !== 'function') {
        state.recordPriceTriggerError(direction, 'manualOpenImpl_not_ready');
        return;
      }
      r = await fireFn({ direction, source: 'price_trigger_open' });
    }

    return _finalizePriceTriggerResult(direction, prev, hitPrice, r, action, overridden);
  } finally {
    _ptInFlight[direction] = false;
  }
}

/**
 * fire 返回值统一收尾:
 *   - 成功: markPriceTriggerFiredLock(direction, prev) → 清空剩余 items[] + locked=true,
 *           推一条"同方向 N 条剩余触发器已被成交锁清除"
 *   - 失败: recordPriceTriggerError + 飞书告警, 不锁不清 (其他触发器继续监听)
 */
function _finalizePriceTriggerResult(direction, prev, hitPrice, r, action, overridden) {
  const cfg = config.get();
  const titleEmoji = direction === 'long' ? '📈' : '📉';
  const triggerStr = Number(prev.triggerPrice).toFixed(2);
  const hitStr = Number(hitPrice).toFixed(2);
  const ok = r && r.status >= 200 && r.status < 300 && r.body && r.body.ok !== false;

  if (!ok) {
    const reason = r?.body?.error || r?.body?.hint || `http_${r?.status || 'unknown'}`;
    state.recordPriceTriggerError(direction, reason);
    // fire 失败时的飞书告警: 把"已覆盖旧 pending"的关键信息带上, 否则用户在 lastError
    // 红字里只看到 reason, 不知道触发器命中前已经把旧 pending 一起干掉了 (双输状态).
    const overrideLine = overridden
      ? `⚠️ 命中前已自动取消旧 pending: entry=${Number(overridden.pendingPlan?.entry).toFixed(2)} · armed=${cnTime(overridden.pendingArmedAt)} (此次未恢复, 如需重新挂请手动操作)`
      : null;
    exec.notify({
      type: 'open_blocked',
      title: `❌ ${direction.toUpperCase()} 价格触发器命中但 ${action === 'follow' ? '追单' : '挂单'} 失败`,
      lines: [
        `symbol: ${cfg.symbol}`,
        `触发价/命中价: ${triggerStr} / ${hitStr}`,
        `失败原因: ${reason}`,
        `状态码: ${r?.status || '--'}`,
        `该触发器已消费, 同方向其余触发器仍在监听; 如需重试请重新添加`,
        overrideLine,
      ].filter(Boolean),
      isAlert: true,
    });
    console.error(`[trade.risk] ❌ priceTrigger ${direction} fire 失败: ${reason}${overridden ? ' (覆盖旧 pending 后未补回)' : ''}`);
    return;
  }

  // ⭐ 成交锁: fire 成功 → 清空该方向所有剩余触发器 + locked=true
  const { cleared, lockedItems } = state.markPriceTriggerFiredLock(direction, prev);
  console.log(`[trade.risk] ✅ priceTrigger ${direction} fire 成功 action=${action} status=${r.status}; 成交锁清除剩余 ${cleared} 条触发器`);

  if (cleared > 0) {
    const lines = [
      `symbol: ${cfg.symbol}`,
      `已成交触发价: ${triggerStr} (${prev.side === 'above' ? '上穿' : '下穿'}) → ${action === 'follow' ? '🚀 追单' : '📋 挂单'}`,
      `自动清除剩余 ${cleared} 条触发器 (同方向不再触发, 直到重新启用):`,
      ...lockedItems.map(t => `  · 触发价 ${Number(t.triggerPrice).toFixed(2)} (${t.side}) · ${t.action === 'follow' ? '追单' : '挂单'}`),
      `🔓 解锁方式: 重新添加任意触发器即可重置监听`,
    ];
    exec.notify({
      type: 'unlock',
      title: `🔒 ${titleEmoji} ${direction.toUpperCase()} 成交锁生效 — 清除 ${cleared} 条剩余触发器`,
      lines,
    });
  }
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

  // ⭐ 链式接力 (修复"单根 K 线穿过 TP1+TP2+TP3 时 TP2/TP3 漏触发"的 bug):
  //   - fire 完成 → _inFlight 已释放, recentlyFired=now
  //   - 立刻读取最新价 (priceFeed.lastPrice), 跳过 200ms cooldown 重 evaluate 一次
  //   - 如果价格仍在下一级 TP 之外, 立即接力 fireTp → 再链式 → 直到价格回落或所有 TP 都 fire
  //   - 安全性: markTpHit 幂等 (同 level 二次返回 null) + _inFlight 闸仍在每个 fire 入口生效,
  //     skipCooldown 只跳过 200ms 冷却, 不会破坏任何幂等语义
  //   - level === 'tp_3' 后仓位已 closeAndUnlock, evaluate 内部 p.active=false 自动跳出, 无副作用
  if (level !== 'tp_3') {
    _chainEvaluate(direction);
  }
}

/**
 * fire 完成后, 用最新价立即重 evaluate 同方向, 单帧内串起多级 TP.
 * 跳过 cooldown — 因为 _inFlight + markTpHit 幂等已经挡住所有 race.
 */
function _chainEvaluate(direction) {
  try {
    const lastPrice = priceFeed.lastPrice;
    if (!Number.isFinite(lastPrice)) return;
    evaluate(direction, lastPrice, Date.now(), { skipCooldown: true });
  } catch (e) {
    console.error(`[trade.risk] _chainEvaluate ${direction} 失败:`, e?.message || e);
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
  // ⭐ 价格围栏: 暴露给 router /direction-guard 端点用 — 用户改了阈值/启停后,
  // 路由立即用 priceFeed.lastPrice 调一次 evaluateDirectionGuard, 不必等下一帧 tick.
  evaluateDirectionGuard,
  // ⭐ Regime 守卫: 暴露给 router /regime-guard 端点 — 用户改了规则/启停后,
  // 路由立即评估一次, 不必等下一轮 30s 定时器.
  evaluateRegimeGuard,
  _reset: () => {
    recentlyFired.long = 0;
    recentlyFired.short = 0;
    _inFlight.long = false;
    _inFlight.short = false;
    _lastFireLatencyMs = null;
    _maxFireLatencyMs = 0;
    _evalCount = 0;
    _tpSkippedByInFlight = 0;
    _tpSkippedByCooldown = 0;
    _lastNearMiss = null;
    _lastNearMissLogAt.long = 0;
    _lastNearMissLogAt.short = 0;
    _lastGuardSwitchAt.long = 0;
    _lastGuardSwitchAt.short = 0;
    _lastRegimeGuardSwitchAt.long = 0;
    _lastRegimeGuardSwitchAt.short = 0;
    if (_regimeGuardTimer) { clearInterval(_regimeGuardTimer); _regimeGuardTimer = null; }
  },
  __getInFlight: () => ({ ..._inFlight }),       // 仅测试用
};
