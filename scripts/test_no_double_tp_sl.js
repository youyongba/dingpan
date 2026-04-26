/**
 * 防 TP/SL 多次触发冲烟:
 *   1. fireTp 在 await postWebhook 期间 (慢响应 5s), 持续注入 tick → webhook 仅发 1 次, fireTp 仅入 1 次
 *   2. fireSl 同样, webhook 仅发 1 次, 后续 tick 因 active=false 直接 return
 *   3. webhook 失败时 tpHit 仍标记成功 (不再重复触发同一 level)
 *   4. TP/SL 走 retry=0 (1/1 attempts, 不再 1/3)
 *   5. TP1 → TP2 → TP3 顺序触发不互相阻塞 (TP1 的 inFlight 释放后, TP2 能进入)
 *
 *   node scripts/test_no_double_tp_sl.js
 */
'use strict';

const exec = require('../trading/executor');
const tradeConfig = require('../trading/config');
const state = require('../trading/state');

tradeConfig.patch({ enabled: true });

// ---------- mock axios ----------
const axios = require('axios');
let postCount = 0;
let postLog = [];
let mockMode = 'success-fast';
const _origPost = axios.post;
axios.post = async (url, body, opts) => {
  const idx = ++postCount;
  postLog.push({ idx, action: body.action, trigger: body.trigger, time: Date.now() });
  if (mockMode === 'success-fast') {
    return { status: 200, data: { ok: true, idx } };
  }
  if (mockMode === 'success-slow-5s') {
    await new Promise(r => setTimeout(r, 5000));
    return { status: 200, data: { ok: true, idx } };
  }
  if (mockMode === 'fail-fast') {
    throw new Error('mocked failure');
  }
};

// ---------- 加载 riskEngine ----------
const risk = require('../trading/riskEngine');
risk._reset();

// ---------- 关闭真实 notify (只统计) ----------
let notifyCount = 0;
exec.notify = (ev) => { notifyCount++; console.log(`  [notify ${notifyCount}] ${ev.title}`); };

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function setupLong(entry, tp1, tp2, tp3, sl) {
  state.manualReset('long');
  state.openPosition('long', {
    entryPrice: entry, leverage: 100, positionSize: '10%',
    tp1, tp2, tp3, initialStopLoss: sl, currentStopLoss: sl,
    entryAt: new Date().toISOString(),
  });
}

(async () => {
  // ============= Case 1: fireTp 慢响应期间连续 tick, 仅触发 1 次 =============
  console.log('\n=== Case 1: fireTp 慢响应 5s, 期间 evaluate 50 次 → webhook 仅 1 次 ===');
  postCount = 0; postLog = []; notifyCount = 0; risk._reset();
  setupLong(78000, 78200, 78400, 78600, 77800);
  mockMode = 'success-slow-5s';

  const firePromise = (async () => { risk.evaluate('long', 78250); })(); // 触发 TP1
  // 启动后立刻不断打 tick (模拟 WS 高频)
  for (let i = 0; i < 50; i++) {
    risk.evaluate('long', 78250);
    risk.evaluate('long', 78300);
    await new Promise(r => setTimeout(r, 80));     // 50 * 80ms = 4s, 覆盖 5s 慢响应大半
  }
  await firePromise;
  await new Promise(r => setTimeout(r, 1500));     // 等 fireTp 跑完

  check('axios.post 仅被调用 1 次 (期间打了 100+ 次 tick)',
    postCount === 1, `实际 postCount=${postCount}`);
  check('postLog 都是 tp_1', postLog.every(x => x.trigger === 'tp_1'));
  check('state.tpHit.tp1 = true', state.getPosition('long').tpHit.tp1 === true);
  check('inFlight 已释放', risk.__getInFlight().long === false);

  // ============= Case 2: TP1 后继续穿 TP2, 也只触发 1 次 =============
  console.log('\n=== Case 2: TP1 完成后, 继续 evaluate TP2 应能触发 (inFlight 已释放) ===');
  postCount = 0; postLog = []; notifyCount = 0;
  mockMode = 'success-fast';
  // 此时 long.tpHit.tp1=true, 价格穿 TP2
  for (let i = 0; i < 20; i++) risk.evaluate('long', 78450);
  await new Promise(r => setTimeout(r, 200));

  check('TP2 webhook 仅 1 次', postCount === 1, `实际 postCount=${postCount}`);
  check('postLog[0].trigger = tp_2', postLog[0]?.trigger === 'tp_2');
  check('state.tpHit.tp2 = true', state.getPosition('long').tpHit.tp2 === true);

  // ============= Case 3: TP3 触发后 closeAndUnlock, 后续 tick 不再触发 =============
  console.log('\n=== Case 3: TP3 触发完 → 解锁; 再打 tick 不应再 fireTp ===');
  postCount = 0; postLog = []; notifyCount = 0;
  await new Promise(r => setTimeout(r, 1600));    // 等过 FIRE_COOLDOWN_MS=1500ms 防抖
  for (let i = 0; i < 20; i++) risk.evaluate('long', 78650);
  await new Promise(r => setTimeout(r, 200));

  check('TP3 webhook 1 次', postCount === 1);
  check('long 已 closeAndUnlock', state.getPosition('long').active === false);

  // 再打一堆 tick (价格还在上方)
  for (let i = 0; i < 30; i++) risk.evaluate('long', 78700);
  await new Promise(r => setTimeout(r, 100));
  check('解锁后 tick 不再触发 webhook (postCount 仍 = 1)', postCount === 1, `实际 postCount=${postCount}`);

  // ============= Case 4: SL 慢响应 5s 期间连续 tick, 也只触发 1 次 =============
  console.log('\n=== Case 4: SL 慢响应 5s, 期间 evaluate 100 次 → webhook 仅 1 次 ===');
  state.manualReset('long');
  setupLong(78000, 78200, 78400, 78600, 77800);
  postCount = 0; postLog = []; notifyCount = 0; risk._reset();
  mockMode = 'success-slow-5s';

  const slPromise = (async () => { risk.evaluate('long', 77790); })();
  for (let i = 0; i < 50; i++) {
    risk.evaluate('long', 77790);
    risk.evaluate('long', 77780);
    await new Promise(r => setTimeout(r, 80));
  }
  await slPromise;
  await new Promise(r => setTimeout(r, 1500));

  check('SL webhook 仅 1 次', postCount === 1, `实际 postCount=${postCount}`);
  check('postLog[0].action = stop_loss', postLog[0]?.action === 'stop_loss');
  check('long 已 closeAndUnlock', state.getPosition('long').active === false);

  // ============= Case 5: webhook 失败时 tpHit 仍标记 =============
  console.log('\n=== Case 5: TP webhook 失败 → tpHit 仍标记成功, 后续 tick 不重复触发 ===');
  state.manualReset('long');
  setupLong(78000, 78200, 78400, 78600, 77800);
  postCount = 0; postLog = []; notifyCount = 0; risk._reset();
  mockMode = 'fail-fast';

  for (let i = 0; i < 20; i++) risk.evaluate('long', 78250);
  await new Promise(r => setTimeout(r, 200));

  check('webhook 失败时 axios 仅 1 次 (retry=0)', postCount === 1, `实际 postCount=${postCount}`);
  check('tpHit.tp1 仍标记 true (虽然 webhook 失败)', state.getPosition('long').tpHit.tp1 === true);

  // 再打 tick
  for (let i = 0; i < 20; i++) risk.evaluate('long', 78250);
  await new Promise(r => setTimeout(r, 200));
  check('webhook 失败后 tick 不再重复触发 TP1', postCount === 1, `实际 postCount=${postCount}`);

  // ============= 总结 =============
  console.log(`\n--- 结果: ${passed} passed, ${failed} failed ---`);

  axios.post = _origPost;
  state.manualReset('long');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
