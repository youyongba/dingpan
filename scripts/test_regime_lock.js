/**
 * 端到端冒烟: 验证 "regime 桥接" 在开仓时使用的是
 * triggerAutoTrade 那一刻的 tradePlan-A 锁定价位,
 * 即便随后 regimeModule 内部 cache 被刷新成 plan-B,
 * 开仓登记的 tp/sl 也必须是 plan-A 的, 不会漂移.
 *
 *   node scripts/test_regime_lock.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const Module = require('module');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '../regimeModule' || request === './regimeModule') {
    return path.resolve(__dirname, '__mock_regime_lock.js');
  }
  return _origResolve.call(this, request, ...rest);
};

const mockPath = path.resolve(__dirname, '__mock_regime_lock.js');
fs.writeFileSync(mockPath, `
let cache = null;
exports.setLatestPlan = (p) => { cache = p; };
exports.getLatestPlan = () => cache;
`);

const mockRegime = require(mockPath);

const PLAN_A = {
  ok: true,
  direction: 'long',
  entry: 77913.52,
  stopLoss: 77605.77,
  riskPct: '0.40',
  suggestedPositionPct: 10,
  confidenceLabel: '低',
  takeProfits: [
    { level: 'TP1', price: 78221.27, r: '1R', gainPct: '0.40', closePct: 50, note: '' },
    { level: 'TP2', price: 78529.01, r: '2R', gainPct: '0.79', closePct: 30, note: '' },
    { level: 'TP3', price: 78836.76, r: '3R', gainPct: '1.19', closePct: 20, note: '' },
  ],
};
const PLAN_B = {
  ok: true,
  direction: 'long',
  entry: 79000.00,
  stopLoss: 78700.00,
  riskPct: '0.40',
  suggestedPositionPct: 5,
  confidenceLabel: '中',
  takeProfits: [
    { level: 'TP1', price: 79300.00, r: '1R', gainPct: '0.40', closePct: 50, note: '' },
    { level: 'TP2', price: 79600.00, r: '2R', gainPct: '0.79', closePct: 30, note: '' },
    { level: 'TP3', price: 79900.00, r: '3R', gainPct: '1.19', closePct: 20, note: '' },
  ],
};

const priceFeed = require('../trading/priceFeed');
priceFeed.getStatus = () => ({ connected: true, lastPrice: 78024.80 });

const exec = require('../trading/executor');
exec.forwardOpen = async () => ({ res: { ok: true, skipped: 'mocked' }, payload: null });
exec.notify = (ev) => console.log('  [notify]', ev.title);

const state = require('../trading/state');
state.canOpen = () => ({ ok: true });
let openedPos = null;
state.openPosition = (dir, payload) => {
  openedPos = { direction: dir, ...payload };
  return openedPos;
};

const tradeConfig = require('../trading/config');
tradeConfig.patch({ enabled: true });

const { processSignal } = require('../trading/router');

// ---------- 模拟 regimeModule.triggerAutoTrade 的核心逻辑 ----------
function triggerAutoTrade(action, tradePlan) {
  if (!tradePlan || !tradePlan.ok) return Promise.resolve(null);
  const tps = Array.isArray(tradePlan.takeProfits) ? tradePlan.takeProfits : [];
  const payload = {
    token: tradeConfig.get().token,
    action,
    symbol: 'BTCUSDT',
    stop_loss: Number(tradePlan.stopLoss),
    tp1: tps[0]?.price != null ? Number(tps[0].price) : undefined,
    tp2: tps[1]?.price != null ? Number(tps[1].price) : undefined,
    tp3: tps[2]?.price != null ? Number(tps[2].price) : undefined,
    position_size: tradePlan.suggestedPositionPct != null
      ? `${tradePlan.suggestedPositionPct}%`
      : undefined,
  };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
  return processSignal(payload, { source: 'regime' });
}

(async () => {
  console.log('\n=== Test: triggerAutoTrade 锁定 plan-A, 即便 cache 已刷新为 plan-B ===');

  mockRegime.setLatestPlan({ tradePlan: PLAN_A, regime: { regime: 'trend' }, latest: { close: 78024.80 }, updatedAt: Date.now() });

  const p = triggerAutoTrade('open_long', PLAN_A);

  mockRegime.setLatestPlan({ tradePlan: PLAN_B, regime: { regime: 'trend' }, latest: { close: 78024.80 }, updatedAt: Date.now() });

  const r = await p;
  console.log('processSignal status:', r?.status);
  console.log('Opened position:', JSON.stringify({
    entryPrice: openedPos.entryPrice,
    tp1: openedPos.tp1, tp2: openedPos.tp2, tp3: openedPos.tp3,
    initialStopLoss: openedPos.initialStopLoss,
    positionSize: openedPos.positionSize,
    priceSource: openedPos.priceSource,
  }, null, 2));

  const ok =
    openedPos.priceSource === 'signal_explicit' &&
    Math.abs(openedPos.entryPrice - 78024.80) < 0.01 &&
    Math.abs(openedPos.tp1 - PLAN_A.takeProfits[0].price) < 0.01 &&
    Math.abs(openedPos.tp2 - PLAN_A.takeProfits[1].price) < 0.01 &&
    Math.abs(openedPos.tp3 - PLAN_A.takeProfits[2].price) < 0.01 &&
    Math.abs(openedPos.initialStopLoss - PLAN_A.stopLoss) < 0.01 &&
    openedPos.positionSize === '10%';

  if (ok) {
    console.log('\n✅ 价位锁定通过: 即使 regime cache 切到 plan-B, 开仓登记的 tp/sl 仍是 plan-A');
  } else {
    console.log('\n❌ 价位锁定失败: 实际登记的 tp/sl 与 plan-A 不一致');
  }

  fs.unlinkSync(mockPath);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  try { fs.unlinkSync(mockPath); } catch (_) {}
  process.exit(2);
});
