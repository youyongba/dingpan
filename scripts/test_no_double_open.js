/**
 * 防重复开仓冲烟:
 *   1. forwardOpen 在 axios 超时时 不再重试 (attempts=1)
 *   2. forwardOpen 冷却期内 (15s) 同方向重复调用直接被拒
 *   3. 不同方向 / 平仓 (TP/SL) 不受冷却影响
 *
 *   node scripts/test_no_double_open.js
 */
'use strict';

const exec = require('../trading/executor');
const tradeConfig = require('../trading/config');

let postCount = 0;
let lastUrlSent = null;
let mockMode = 'success';

const axios = require('axios');
const _origPost = axios.post;
axios.post = async (url, body, opts) => {
  postCount += 1;
  lastUrlSent = { url, body, opts };
  if (mockMode === 'timeout') {
    const e = new Error('timeout of 8000ms exceeded');
    e.code = 'ECONNABORTED';
    throw e;
  }
  if (mockMode === 'success') {
    return { status: 200, data: { ok: true, message: 'mocked' } };
  }
  if (mockMode === 'fail') {
    throw new Error('mocked failure');
  }
};

tradeConfig.patch({ enabled: true, forwardOpenOrders: true, openForwardCooldownMs: 15000 });

let testClockNow = Date.now();
exec.__setTestClock(() => testClockNow);

async function reset() {
  postCount = 0;
  lastUrlSent = null;
  exec.__resetForwardCooldown();
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

(async () => {
  // ============= Case 1: 超时不重试 =============
  console.log('\n=== Case 1: forwardOpen 在 axios 超时时, attempts 必须 = 1 (不重试) ===');
  await reset();
  mockMode = 'timeout';
  const r1 = await exec.forwardOpen({ token: 'x', action: 'open_long', symbol: 'BTCUSDT' });
  check('axios.post 仅被调用 1 次', postCount === 1, `实际 postCount=${postCount}`);
  check('返回 attempts = 1', r1.res.attempts === 1, `实际 attempts=${r1.res.attempts}`);
  check('返回 ok = false', r1.res.ok === false);
  check('payload 不带 client_order_id (接收方零改动)',
    r1.payload && r1.payload.client_order_id === undefined);

  // ============= Case 2: 同方向冷却拦截 =============
  console.log('\n=== Case 2: 同方向 15s 内再次 forwardOpen, 直接被冷却闸拦截 ===');
  await reset();
  mockMode = 'success';
  const r2a = await exec.forwardOpen({ token: 'x', action: 'open_long', symbol: 'BTCUSDT' });
  check('第 1 次 long ok', r2a.res.ok === true);
  check('第 1 次 axios.post 被调用', postCount === 1);

  testClockNow += 9_000;
  const r2b = await exec.forwardOpen({ token: 'x', action: 'open_long', symbol: 'BTCUSDT' });
  check('第 2 次 long 在 9s 内被拦截 (skipped=open_cooldown)',
    r2b.res.ok === false && r2b.res.skipped === 'open_cooldown',
    `实际 res=${JSON.stringify(r2b.res)}`);
  check('第 2 次 axios.post 没被调用 (postCount 仍为 1)', postCount === 1, `实际 postCount=${postCount}`);

  // 16s 后冷却已过, 应放行
  testClockNow += 7_000;
  const r2c = await exec.forwardOpen({ token: 'x', action: 'open_long', symbol: 'BTCUSDT' });
  check('16s 后 long 重新放行', r2c.res.ok === true);
  check('axios.post 累计 2 次', postCount === 2, `实际 postCount=${postCount}`);

  // ============= Case 3: 反方向不受冷却影响 =============
  console.log('\n=== Case 3: long 冷却中, short 仍可 forwardOpen ===');
  await reset();
  mockMode = 'success';
  await exec.forwardOpen({ token: 'x', action: 'open_long', symbol: 'BTCUSDT' });
  testClockNow += 1_000;
  const r3 = await exec.forwardOpen({ token: 'x', action: 'open_short', symbol: 'BTCUSDT' });
  check('long 冷却中, short 能通过', r3.res.ok === true);
  check('axios.post 累计 2 次', postCount === 2, `实际 postCount=${postCount}`);

  // ============= Case 4: 平仓 (TP/SL) 也走 retry=0 (跟开仓一致, 接收方非幂等) =============
  console.log('\n=== Case 4: fireTakeProfit / fireStopLoss 也走 retry=0 ===');
  await reset();
  mockMode = 'fail';
  tradeConfig.patch({ webhookRetry: 2 });    // 默认配置不变, 但 fireStopLoss 内部强制 retry=0
  const r4 = await exec.fireStopLoss('long', { trigger: 'sl' });
  check('SL 失败也仅 1 次尝试 (retry=0)', r4.res.attempts === 1, `实际 attempts=${r4.res.attempts}`);
  check('axios.post 累计 1 次', postCount === 1, `实际 postCount=${postCount}`);

  await reset();
  mockMode = 'fail';
  const r4b = await exec.fireTakeProfit('long', 'tp_1', {});
  check('TP 失败也仅 1 次尝试 (retry=0)', r4b.res.attempts === 1, `实际 attempts=${r4b.res.attempts}`);

  // ============= 总结 =============
  console.log(`\n--- 结果: ${passed} passed, ${failed} failed ---`);

  axios.post = _origPost;
  exec.__setTestClock(null);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
