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

// 防抖：刚触发的动作 1.5s 内同方向不再触发
const recentlyFired = { long: 0, short: 0 };
const FIRE_COOLDOWN_MS = 1500;

// WS 状态通知冷却 (避免重连失败刷屏)
const WS_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
let lastWsErrorNotifyAt = 0;
let lastWsOpenNotifyAt = 0;
let wsHasBeenConnected = false;

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
        '提示: 中国大陆需配置 HTTPS_PROXY=http://host:port 才能直连 Binance',
        '后续 5 分钟内同类错误将静默, 不再刷屏',
      ],
      isAlert: true,
    });
  });
  console.log('[trade.risk] 风控引擎已挂载');
}

function onTick({ price }) {
  if (!Number.isFinite(price)) return;
  ['long', 'short'].forEach(dir => {
    try { evaluate(dir, price); }
    catch (e) { console.error('[trade.risk] evaluate error:', e.message); }
  });
}

function evaluate(direction, price) {
  const p = state.getPosition(direction);
  if (!p || !p.active) return;
  if (Date.now() - recentlyFired[direction] < FIRE_COOLDOWN_MS) return;

  const isLong = direction === 'long';
  const above = (a, b) => a >= b;   // 多: 价格上穿 TP
  const below = (a, b) => a <= b;   // 多: 价格下穿 SL

  // ---- 1) 止损 (initial 或 protection 都走这条)
  if (p.currentStopLoss != null) {
    const slHit = isLong ? below(price, p.currentStopLoss) : above(price, p.currentStopLoss);
    if (slHit) {
      const trigger = p.protectionArmed ? 'sl_protection' : 'sl';
      return fireSl(direction, price, trigger);
    }
  }

  // ---- 2) TP3 (要求 TP2 已触发)
  if (!p.tpHit.tp3 && p.tp3 != null && p.tpHit.tp2) {
    const hit = isLong ? above(price, p.tp3) : below(price, p.tp3);
    if (hit) return fireTp(direction, 'tp_3', price);
  }
  // ---- 3) TP2 (要求 TP1 已触发)
  if (!p.tpHit.tp2 && p.tp2 != null && p.tpHit.tp1) {
    const hit = isLong ? above(price, p.tp2) : below(price, p.tp2);
    if (hit) return fireTp(direction, 'tp_2', price);
  }
  // ---- 4) TP1
  if (!p.tpHit.tp1 && p.tp1 != null) {
    const hit = isLong ? above(price, p.tp1) : below(price, p.tp1);
    if (hit) return fireTp(direction, 'tp_1', price);
  }
}

async function fireTp(direction, level, triggerPrice) {
  recentlyFired[direction] = Date.now();
  const setProtection = (level === 'tp_1');
  const { res, payload } = await exec.fireTakeProfit(direction, level, { setProtectionSl: setProtection });

  const p = state.getPosition(direction);
  const newSl = setProtection ? p.entryPrice : undefined;
  state.markTpHit(direction, level === 'tp_1' ? 'tp1' : level === 'tp_2' ? 'tp2' : 'tp3',
    { newStopLoss: newSl, armProtection: setProtection });

  const closePct = ({ tp_1: '50%', tp_2: '30%', tp_3: '20%' })[level];
  const titleEmoji = direction === 'long' ? '📈' : '📉';
  exec.notify({
    type: 'tp',
    title: `${titleEmoji} ${direction.toUpperCase()} ${level.toUpperCase()} 触发 (${closePct} 平仓)`,
    lines: [
      `symbol: ${config.get().symbol}`,
      `方向: ${direction}`,
      `触发价: ${triggerPrice}`,
      `入场价: ${p.entryPrice}`,
      `平仓比例: ${closePct}`,
      `平仓 webhook: ${res.ok ? '✅ 已发送' : '❌ 失败 ' + (res.error || '')}`,
      ...exec.formatPayloadLines(level, payload),
    ],
  });

  if (setProtection) {
    exec.notify({
      type: 'tp',
      title: `🛡️ ${direction.toUpperCase()} 已成功设置保本止损`,
      lines: [
        `保本止损价 = 入场价 = ${p.entryPrice}`,
        `若价格回踩入场价将触发 100% 平仓 + 自动解锁`,
      ],
    });
  }

  // TP3 触发即解锁
  if (level === 'tp_3') {
    state.closeAndUnlock(direction, 'tp_3');
    exec.notify({
      type: 'unlock',
      title: `🔓 ${direction.toUpperCase()} 已自动解锁 (TP3 全部止盈)`,
      lines: [`方向 ${direction} 现可重新接收开仓信号`],
    });
  }
}

async function fireSl(direction, triggerPrice, triggerTag = 'sl') {
  recentlyFired[direction] = Date.now();
  const { res, payload } = await exec.fireStopLoss(direction, { trigger: triggerTag });
  const p = state.getPosition(direction);
  state.closeAndUnlock(direction, triggerTag);

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
      `入场价: ${p.entryPrice}`,
      `止损价: ${p.currentStopLoss}`,
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
}

module.exports = { start, evaluate, _reset: () => { recentlyFired.long = 0; recentlyFired.short = 0; } };
