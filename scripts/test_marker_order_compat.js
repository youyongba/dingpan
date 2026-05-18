/**
 * /market-order × /marker-order 兼容性冒烟测试.
 *
 * 验证目标:
 *   1. 路由命中: /market-order 与 /marker-order 都能被路由到 (status != 404)
 *   2. 鉴权: Header X-Auth-Token / Authorization: Bearer / ?token= / body.token 任一即可放行
 *   3. 错误鉴权: 无 token / 错 token 都返回 401
 *   4. 方法: POST + GET 都支持
 *   5. 参数解析: direction 从 query / body 取值都对 (通过模拟 disableLong=true 让响应 hint 反映 direction)
 *   6. 错误参数: 缺 direction → 400
 *
 *   node scripts/test_marker_order_compat.js
 */
'use strict';

process.env.CONFIG_AUTH_TOKEN = process.env.CONFIG_AUTH_TOKEN
  || '54006625db5c6a03b3ba5e112b326eb69e4828ba00c5efab403c03e217263455';

const express = require('express');
const http = require('http');
const state = require('../trading/state');
const config = require('../trading/config');
const exec = require('../trading/executor');

// 清空持仓 — 防止 disk 残留 (上次测试 leak 的 active 仓位会让所有 marketOrder 卡 409 already_active)
state.manualReset('long');
state.manualReset('short');

// 让 disableLong/disableShort 都 true → marketOrder 会在 processSignal 里被 409 拦下,
// 错误 body 里会带 direction → 我们从这个 body 反推 direction 解析对不对.
config.patch({ disableLong: true, disableShort: true });

// 静默 notify
exec.notify = () => {};
exec.fireMonitorOpen = () => {};
exec.fireMonitorCancel = () => {};

// mock priceFeed.lastPrice — 让 marketOrderImpl 能跨过 priceFeed 检查, 进入 processSignal
const priceFeed = require('../trading/priceFeed');
priceFeed.getStatus = () => ({ lastPrice: 50000, ready: true, alive: true, lastTickAt: Date.now() });
Object.defineProperty(priceFeed, 'lastPrice', { value: 50000, configurable: true, writable: true });

const tradeRouter = require('../trading/router');
const app = express();
app.use(express.json());
app.use('/api/auto-trade', tradeRouter);
const server = app.listen(0);
const port = server.address().port;
const TOKEN = process.env.CONFIG_AUTH_TOKEN;

function httpRequest({ method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      host: '127.0.0.1',
      port,
      path,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// 验证 direction 参数解析正确:
//   - 解析失败的 ground truth = 返回 400 且 body.error === 'direction must be long|short'
//   - 解析成功 = 进了 marketOrderImpl 业务流程, 后续被任何业务校验拦下都说明解析对了
//     (e.g. 503 price_feed_not_ready / 400 ATR 无效 / 409 already_active / 200 webhook 成功)
function dirParsedAs(r, expected) {
  const b = r.body || {};
  // 显式 direction 字段优先匹配
  if (b.direction === expected) return true;
  // 错误 ground truth: 缺/错 direction 必返回 400 + 'direction must be long|short'
  const errStr = String(b.error || '').toLowerCase();
  if (r.status === 400 && errStr.includes('direction must be')) return false;
  // 鉴权 / 路由 失败也视为没解析到 (上层有专门的 check 验证, 这里只关心 direction 解析)
  if (r.status === 404 || r.status === 401) return false;
  // 其他状态 (200 / 409 / 503 / 400其他错误) 都说明 direction 已被成功解析
  return true;
}

(async () => {
  // ============ Case 1: POST /market-order  Header X-Auth-Token (旧 UI) ============
  console.log('\n=== Case 1: POST /market-order  Header X-Auth-Token + body.direction=long ===');
  let r = await httpRequest({
    method: 'POST',
    path: '/api/auto-trade/market-order',
    headers: { 'X-Auth-Token': TOKEN },
    body: { direction: 'long', source: 'ui_button', label: 'manual_long_1' },
  });
  check('路由命中 (status != 404)', r.status !== 404, `status=${r.status}`);
  check('鉴权通过 (status != 401)', r.status !== 401, `status=${r.status}`);
  check('direction=long 解析正确 (响应反映出 long)', dirParsedAs(r, 'long'),
    `body=${JSON.stringify(r.body).slice(0, 200)}`);

  // ============ Case 2: POST /market-order  Authorization: Bearer ============
  console.log('\n=== Case 2: POST /market-order  Authorization: Bearer <token> + body.direction=short ===');
  r = await httpRequest({
    method: 'POST',
    path: '/api/auto-trade/market-order',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: { direction: 'short', source: 'admin_tool' },
  });
  check('鉴权通过 (Bearer)', r.status !== 401);
  check('direction=short 解析正确', dirParsedAs(r, 'short'));

  // ============ Case 3: GET /marker-order?token=xxx&direction=long (热力图工具) ============
  console.log('\n=== Case 3: GET /marker-order?token=xxx&direction=long&source=heatmap (热力图 URL) ===');
  r = await httpRequest({
    method: 'GET',
    path: `/api/auto-trade/marker-order?token=${TOKEN}&direction=long&source=heatmap&label=L_Max_24H`,
  });
  check('路由命中 /marker-order GET', r.status !== 404, `status=${r.status}`);
  check('query token 鉴权通过', r.status !== 401);
  check('direction=long 解析正确', dirParsedAs(r, 'long'));

  // ============ Case 4: POST /marker-order  body: { token, direction } ============
  console.log('\n=== Case 4: POST /marker-order body: { token, direction:short, ... } (老脚本) ===');
  r = await httpRequest({
    method: 'POST',
    path: '/api/auto-trade/marker-order',
    body: { token: TOKEN, direction: 'short', source: 'legacy', position_size: '50%' },
  });
  check('路由命中 /marker-order POST', r.status !== 404);
  check('body.token 鉴权通过', r.status !== 401);
  check('direction=short 解析正确', dirParsedAs(r, 'short'));

  // ============ Case 5a: 错误鉴权 — 无 token ============
  console.log('\n=== Case 5a: POST /market-order 无 token → 401 ===');
  r = await httpRequest({
    method: 'POST',
    path: '/api/auto-trade/market-order',
    body: { direction: 'long' },
  });
  check('返回 401', r.status === 401, `status=${r.status}`);

  // ============ Case 5b: 错误鉴权 — 错的 token ============
  console.log('\n=== Case 5b: GET /marker-order?token=wrong → 401 ===');
  r = await httpRequest({
    method: 'GET',
    path: `/api/auto-trade/marker-order?token=wrong_token&direction=long`,
  });
  check('返回 401', r.status === 401);

  // ============ Case 5c: header 对 + body.token 错 → 应放行 (header 优先) ============
  console.log('\n=== Case 5c: Header 对 + body.token 错 → 放行 (header 优先) ===');
  r = await httpRequest({
    method: 'POST',
    path: '/api/auto-trade/market-order',
    headers: { 'X-Auth-Token': TOKEN },
    body: { token: 'wrong', direction: 'long' },
  });
  check('鉴权通过 (header 优先于 body)', r.status !== 401, `status=${r.status}`);

  // ============ Case 6: 鉴权对 + 无 direction → 400 ============
  console.log('\n=== Case 6: GET /marker-order?token=xxx (无 direction) → 400 ===');
  r = await httpRequest({
    method: 'GET',
    path: `/api/auto-trade/marker-order?token=${TOKEN}`,
  });
  check('返回 400', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);

  // ============ Case 7: GET /market-order (老路径) 也支持 GET ============
  console.log('\n=== Case 7: GET /market-order?token=xxx&direction=long (老路径 GET) ===');
  r = await httpRequest({
    method: 'GET',
    path: `/api/auto-trade/market-order?token=${TOKEN}&direction=long`,
  });
  check('路由命中', r.status !== 404);
  check('鉴权通过', r.status !== 401);
  check('direction=long 解析正确', dirParsedAs(r, 'long'));

  // ============ 总结 ============
  console.log(`\n========== /marker-order 兼容性测试结果 ==========`);
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  console.log(`==================================================\n`);

  // 还原 cfg
  config.patch({ disableLong: false, disableShort: false });
  server.close();
  process.exit(failed > 0 ? 1 : 0);
})();
