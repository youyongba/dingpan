/**
 * 端到端冒烟：验证 trading/router.js 在 open_long 时
 * 优先使用 regimeModule 的 tradePlan, 否则回退 template
 *
 *   node scripts/test_plan_routing.js
 */
'use strict';

// 1) Mock regimeModule.getLatestPlan
const Module = require('module');
const path = require('path');
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '../regimeModule' || request === './regimeModule') {
    return path.resolve(__dirname, '__mock_regime.js');
  }
  return _origResolve.call(this, request, ...rest);
};

require('fs').writeFileSync(path.resolve(__dirname, '__mock_regime.js'), `
exports.getLatestPlan = () => ({
  tradePlan: {
    ok: true,
    direction: 'short',
    entry: 77895.42,
    stopLoss: 78588.77,
    riskPct: '0.89',
    suggestedPositionPct: 10,
    confidenceLabel: '低',
    takeProfits: [
      { level: 'TP1', price: 77202.06, r: '1R', gainPct: '0.89', closePct: 50, note: '' },
      { level: 'TP2', price: 76508.71, r: '2R', gainPct: '1.78', closePct: 30, note: '' },
      { level: 'TP3', price: 75815.36, r: '3R', gainPct: '2.67', closePct: 20, note: '' },
    ],
  },
  regime: { regime: 'trend' },
  latest: { close: 77664 },
  updatedAt: Date.now(),  // 新鲜
});
`);

// 2) Mock priceFeed
const priceFeed = require('../trading/priceFeed');
priceFeed.getStatus = () => ({ connected: true, lastPrice: 77664.30 });

// 3) 关掉真实出站 webhook 和 通知
const exec = require('../trading/executor');
exec.forwardOpen = async () => ({ res: { ok: true, skipped: 'mocked' }, payload: null });
exec.notify = (ev) => console.log('  [notify]', ev.title, '\n    ', (ev.lines || []).join('\n     '));

// 4) Mock state
const state = require('../trading/state');
state.canOpen = () => ({ ok: true });
let openedPos = null;
state.openPosition = (dir, payload) => {
  openedPos = { direction: dir, ...payload };
  return openedPos;
};

// 5) 加载 router 并模拟 POST /signal
const router = require('../trading/router');
const cfg = require('../trading/config').get();

function fakeReq(body) { return { body, headers: {} }; }
function fakeRes() {
  const r = {};
  r.statusCode = 200;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (j) => { r._body = j; return r; };
  return r;
}

// 找到 signal 路由
const layer = router.stack.find(l => l.route && l.route.path === '/signal');
const handler = layer.route.stack[0].handle;

(async () => {
  console.log('\n=== Test 1: open_short with valid regime plan (should use regime_plan) ===');
  const req = fakeReq({
    token: cfg.token, action: 'open_short', symbol: 'BTCUSDT',
  });
  const res = fakeRes();
  await handler(req, res);
  await new Promise(r => setTimeout(r, 50)); // 等 forwardOpen 通知打印
  console.log('Response status:', res.statusCode);
  console.log('Response body:', JSON.stringify(res._body, null, 2));
  console.log('Opened position:', JSON.stringify({
    entryPrice: openedPos.entryPrice,
    tp1: openedPos.tp1, tp2: openedPos.tp2, tp3: openedPos.tp3,
    initialStopLoss: openedPos.initialStopLoss,
    positionSize: openedPos.positionSize,
    priceSource: openedPos.priceSource,
  }, null, 2));

  // 期望：
  //   priceSource = 'regime_plan'
  //   entryPrice = WS 实时价 77664.30 (市价)
  //   planEntry  = 77895.42 (plan 理想价, 仅记录)
  //   tp1=77202.06 / tp2=76508.71 / tp3=75815.36 (与 plan 完全一致)
  //   sl = 78588.77
  //   positionSize = '10%'
  const ok =
    openedPos.priceSource === 'regime_plan' &&
    Math.abs(openedPos.entryPrice - 77664.30) < 0.01 &&     // ← 市价
    Math.abs(openedPos.planEntry - 77895.42) < 0.01 &&      // ← plan 理想价
    Math.abs(openedPos.tp1 - 77202.06) < 0.01 &&
    Math.abs(openedPos.tp2 - 76508.71) < 0.01 &&
    Math.abs(openedPos.tp3 - 75815.36) < 0.01 &&
    Math.abs(openedPos.initialStopLoss - 78588.77) < 0.01 &&
    openedPos.positionSize === '10%';
  console.log(ok ? '\n✅ Test 1 通过：市价入场 + plan TP/SL/仓位完全一致' : '\n❌ Test 1 失败');

  // -- Test 2: regime plan 方向和信号方向不一致, 应回退 template --
  console.log('\n=== Test 2: open_long but plan is short (should fallback to template) ===');
  openedPos = null;
  const req2 = fakeReq({
    token: cfg.token, action: 'open_long', symbol: 'BTCUSDT',
  });
  const res2 = fakeRes();
  await handler(req2, res2);
  await new Promise(r => setTimeout(r, 50));
  console.log('Opened position:', JSON.stringify({
    entryPrice: openedPos.entryPrice,
    tp1: openedPos.tp1, tp2: openedPos.tp2, tp3: openedPos.tp3,
    initialStopLoss: openedPos.initialStopLoss,
    priceSource: openedPos.priceSource,
  }, null, 2));
  const ok2 = openedPos.priceSource === 'template_fallback' &&
              Math.abs(openedPos.entryPrice - 77664.30) < 0.01;
  console.log(ok2 ? '✅ Test 2 通过：方向不匹配, 已回退 template_fallback' : '❌ Test 2 失败');

  // 清理 mock 文件
  require('fs').unlinkSync(path.resolve(__dirname, '__mock_regime.js'));
  process.exit(ok && ok2 ? 0 : 1);
})();
