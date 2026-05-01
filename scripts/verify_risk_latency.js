/**
 * scripts/verify_risk_latency.js
 *
 * 验证"零节流"风控路径下, tick → fire 触发的延迟是否 < 5ms.
 *
 * 设计:
 *   1. monkey-patch executor 全部出站 webhook → no-op, 不真下单.
 *   2. monkey-patch state.getPosition → 内存里的 fake long 仓位.
 *   3. priceFeed.stop() 后, 由我们 emit('tick') 注入模拟价.
 *   4. 每帧前 _reset() 清掉 _inFlight + recentlyFired, 保证每次 tick 都真触发,
 *      避免 cooldown/inFlight 把"应有的 fire"屏蔽掉, 失去测量意义.
 *   5. 用 process.hrtime.bigint() 纳秒级时间戳同时测两段:
 *      a. tick → evaluate 入口 (我们最关心的"真零节流"是这一段)
 *      b. tick → fire 触发链路 (_recordFireLatency 时刻)
 *
 *   p99 < 5ms 即视为"实时" 达标.
 *
 * 用法: node scripts/verify_risk_latency.js
 */
'use strict';

process.env.AUTO_TRADE_ENABLED = '0';
process.env.AUTO_TRADE_WEBHOOK_URL = 'http://127.0.0.1:9/never_called';
process.env.MONITOR_WEBHOOK_ENABLED = '0';
process.env.FEISHU_WEBHOOK_URL = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TRADING_NOTIFY_TG = '0';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const priceFeed   = require('../trading/priceFeed');
const riskEngine  = require('../trading/riskEngine');
const state       = require('../trading/state');
const exec        = require('../trading/executor');

priceFeed.stop();

const N = 1000;
const fakePos = () => ({
  active: true,
  locked: true,
  direction: 'long',
  entryPrice: 65000,
  initialStopLoss: 64000,
  currentStopLoss: 64000,
  tp1: 65500, tp2: 66000, tp3: 66500,
  tpHit: { tp1: false, tp2: false, tp3: false },
  protectionArmed: false,
  pending: false, pendingPlan: null,
});
let _pos = fakePos();
state.getPosition = (dir) => (dir === 'long' ? _pos : null);
state.markTpHit = (dir, lvl) => { _pos.tpHit[lvl] = true; return _pos; };
state.closeAndUnlock = () => { _pos = fakePos(); return _pos; };
state.markPendingFilled = () => null;

exec.fireTakeProfit  = async () => ({ ok: true, res: { ok: true }, payload: { stub: true } });
exec.fireStopLoss    = async () => ({ ok: true, res: { ok: true }, payload: { stub: true } });
exec.forwardOpen     = async () => ({ ok: true, status: 200, body: 'stubbed' });
exec.notify          = () => {};
exec.fireMonitorOpen = () => {};
exec.fireMonitorCancel = () => {};
exec.formatPayloadLines = () => [];

riskEngine.start();

const tickToFireNs = [];
const trapTickTs = new Map();

console.log(`[verify] 注入 ${N} 帧模拟 tick, fakePos long entry=65000 tp1=65500 sl=64000`);
console.log('[verify] 每帧 _reset() 清状态, 让每次 tick 都真触发 fire');

(async () => {
  for (let i = 0; i < N; i++) {
    riskEngine._reset();
    _pos = fakePos();
    const before = riskEngine.getRiskTelemetry();
    const baseFire = before.lastFireLatencyMs;

    const ts = Date.now();
    const t0 = process.hrtime.bigint();
    trapTickTs.set(ts, t0);
    priceFeed.emit('tick', { price: 65501, ts });
    await new Promise(r => setImmediate(r));

    const after = riskEngine.getRiskTelemetry();
    const fired = after.lastFireLatencyMs != null && after.lastFireLatencyMs !== baseFire || (i === 0 && after.lastFireLatencyMs != null);
    if (fired) {
      tickToFireNs.push(Number(process.hrtime.bigint() - t0));
    }
    trapTickTs.delete(ts);
  }

  await new Promise(r => setTimeout(r, 100));

  const stats = (arr, label, unit = 'µs') => {
    if (!arr.length) {
      console.log(`\n[${label}] 0 个样本`);
      return;
    }
    const conv = (ns) => unit === 'ms' ? ns / 1e6 : ns / 1e3;
    const sorted = arr.slice().sort((a, b) => a - b);
    const q = (p) => conv(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
    const sum = sorted.reduce((a, b) => a + b, 0);
    console.log(`\n=== ${label} (单位 ${unit}) ===`);
    console.log(`  样本数: ${sorted.length}`);
    console.log(`  min   : ${conv(sorted[0]).toFixed(3)}`);
    console.log(`  p50   : ${q(0.5).toFixed(3)}`);
    console.log(`  p90   : ${q(0.9).toFixed(3)}`);
    console.log(`  p99   : ${q(0.99).toFixed(3)}`);
    console.log(`  max   : ${conv(sorted[sorted.length - 1]).toFixed(3)}`);
    console.log(`  avg   : ${conv(sum / sorted.length).toFixed(3)}`);
    return q(0.99);
  };

  const fireP99ms = stats(tickToFireNs, 'tick → fire 完成 (含 _recordFireLatency)', 'ms');

  console.log('\n========================================');
  if (fireP99ms != null && fireP99ms < 5) {
    console.log(`✅ tick → fire    p99 = ${fireP99ms.toFixed(2)}ms  < 5ms — 实时触发达标`);
    process.exit(0);
  } else if (fireP99ms != null) {
    console.log(`❌ tick → fire    p99 = ${fireP99ms.toFixed(2)}ms  ≥ 5ms — 不达标`);
    process.exit(2);
  } else {
    console.log('❌ 没有 fire 样本, 检查 stub 是否生效');
    process.exit(2);
  }
})();
