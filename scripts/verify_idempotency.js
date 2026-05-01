/**
 * scripts/verify_idempotency.js
 *
 * 验证 entry / TP1 / TP2 / TP3 / SL 在以下场景下都"绝对只触发一次":
 *   场景 1: 同一价位连发 100 ticks (priceFeed.emit 模拟极端高频)
 *   场景 2: riskEngine 内部 fire 与 router 外部 take_profit/stop_loss action 并发
 *   场景 3: pending → entry 触达, 100 ticks 围绕 entry 抖动, fill 仅 1 次
 *   场景 4: 全平按钮连点 5 次, 仅 1 次 SL webhook
 *
 * 通过统计 exec.fireTakeProfit / exec.fireStopLoss / exec.forwardOpen 被调用的次数,
 * 任何一个场景下次数 > 1 即视为幂等失败.
 *
 * 用法: node scripts/verify_idempotency.js
 */
'use strict';

process.env.AUTO_TRADE_WEBHOOK_URL = 'http://127.0.0.1:9/never_called';
process.env.AUTO_TRADE_WEBHOOK_TOKEN = 'test-idem-token';
process.env.MONITOR_WEBHOOK_ENABLED = '0';
process.env.FEISHU_WEBHOOK_URL = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TRADING_NOTIFY_TG = '0';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const fs = require('fs');
const TMP_STATE = path.join(__dirname, '..', 'data', 'auto_trade_state.test.json');
process.env.AUTO_TRADE_STATE_PATH = TMP_STATE;
try { fs.unlinkSync(TMP_STATE); } catch (_) {}

const priceFeed   = require('../trading/priceFeed');
const riskEngine  = require('../trading/riskEngine');
const state       = require('../trading/state');
const exec        = require('../trading/executor');
const config      = require('../trading/config');
const router      = require('../trading/router');

priceFeed.stop();
// 让 cfg.enabled=true, 覆盖 disk config 可能的关闭状态
config.patch({ enabled: true, token: 'test-idem-token' });
// priceFeed.lastPrice mock — pending fill / open_long 路径会读 priceFeed.getStatus().lastPrice
priceFeed.lastPrice = 65000;

// ============ 计数器 ============
const counters = {
  fireTakeProfit: { tp_1: 0, tp_2: 0, tp_3: 0 },
  fireStopLoss: 0,
  forwardOpen: 0,
  notify: 0,
  monitorOpen: 0,
  monitorCancel: 0,
};

const stubFireTp = async (dir, level, opts) => {
  counters.fireTakeProfit[level] = (counters.fireTakeProfit[level] || 0) + 1;
  return { res: { ok: true }, payload: { stub: true, dir, level } };
};
const stubFireSl = async (dir, opts) => {
  counters.fireStopLoss++;
  return { res: { ok: true }, payload: { stub: true, dir, trigger: opts?.trigger } };
};
const stubForwardOpen = async (sig) => {
  counters.forwardOpen++;
  return { res: { ok: true, status: 200 }, payload: { stub: true, action: sig.action } };
};

exec.fireTakeProfit  = stubFireTp;
exec.fireStopLoss    = stubFireSl;
exec.forwardOpen     = stubForwardOpen;
exec.notify          = () => { counters.notify++; };
exec.fireMonitorOpen = () => { counters.monitorOpen++; };
exec.fireMonitorCancel = () => { counters.monitorCancel++; };
exec.formatPayloadLines = () => [];

riskEngine.start();

// ============ 工具 ============
function reset(counterReset = true) {
  state.manualReset('long');
  state.manualReset('short');
  riskEngine._reset();
  if (counterReset) {
    counters.fireTakeProfit = { tp_1: 0, tp_2: 0, tp_3: 0 };
    counters.fireStopLoss = 0;
    counters.forwardOpen = 0;
    counters.notify = 0;
    counters.monitorOpen = 0;
    counters.monitorCancel = 0;
  }
}

function setupActiveLong() {
  state.openPosition('long', {
    entryPrice: 65000,
    leverage: 100,
    positionSize: '10%',
    tp1: 65500, tp2: 66000, tp3: 66500,
    initialStopLoss: 64000,
    currentStopLoss: 64000,
    raw: { test: true },
  });
}

function emitTicks(price, n, intervalMs = 0) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < n; i++) {
      priceFeed.emit('tick', { price, ts: Date.now() });
      if (intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs));
      else await new Promise(r => setImmediate(r));
    }
    // 等所有 in-flight fire await 完成
    await new Promise(r => setTimeout(r, 50));
    resolve();
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

// ============ 场景 1: 同一价位连发 100 ticks ============
test('TP1 价位连发 100 ticks → 仅 fireTakeProfit(tp_1) 一次', async () => {
  reset();
  setupActiveLong();
  // 注意 cooldown 1500ms - 在 100 ticks 内不会到达, 测的就是 _inFlight + tpHit 联防
  await emitTicks(65501, 100, 0);
  assertEq(counters.fireTakeProfit.tp_1, 1, 'fireTakeProfit(tp_1) 调用次数');
});

test('TP1 触发后, 同价位再发 100 ticks → 不会再次 fire', async () => {
  reset();
  setupActiveLong();
  await emitTicks(65501, 100, 0);                          // 第一次触发
  await new Promise(r => setTimeout(r, 1600));             // 跳过 cooldown
  await emitTicks(65501, 100, 0);                          // 同价位再发
  assertEq(counters.fireTakeProfit.tp_1, 1, 'fireTakeProfit(tp_1) 累计');
});

test('SL 价位连发 100 ticks → 仅 fireStopLoss 一次', async () => {
  reset();
  setupActiveLong();
  await emitTicks(63500, 100, 0);
  assertEq(counters.fireStopLoss, 1, 'fireStopLoss 调用次数');
  // closeAndUnlock 后仓位已清, 后续 ticks 不会再 evaluate
  await emitTicks(63500, 100, 0);
  assertEq(counters.fireStopLoss, 1, 'fireStopLoss 累计 (位置已清)');
});

test('TP3 全程: 连续穿过 tp1/tp2/tp3 价位 → 各 1 次, 共 3 次 fireTakeProfit', async () => {
  reset();
  setupActiveLong();
  // tick 流: 先穿 tp1 → cooldown → 穿 tp2 → cooldown → 穿 tp3
  await emitTicks(65501, 50, 0);
  await new Promise(r => setTimeout(r, 1600));
  await emitTicks(66001, 50, 0);
  await new Promise(r => setTimeout(r, 1600));
  await emitTicks(66501, 50, 0);
  assertEq(counters.fireTakeProfit.tp_1, 1, 'TP1 触发次数');
  assertEq(counters.fireTakeProfit.tp_2, 1, 'TP2 触发次数');
  assertEq(counters.fireTakeProfit.tp_3, 1, 'TP3 触发次数');
});

// ============ 场景 2: 内外并发 fire 同一 level ============
test('内部 fireTp(tp_1) 进行中, 外部 take_profit tp_1 → 外部被 markTpHit 拦截', async () => {
  reset();
  setupActiveLong();
  // 让 stub 放慢, 给外部请求一个机会插队
  exec.fireTakeProfit = async (dir, level, opts) => {
    counters.fireTakeProfit[level] = (counters.fireTakeProfit[level] || 0) + 1;
    await new Promise(r => setTimeout(r, 50));
    return { res: { ok: true }, payload: { stub: true } };
  };

  const t1 = emitTicks(65501, 1, 0);                       // 内部触发
  await new Promise(r => setTimeout(r, 5));                // 让内部走到 markTpHit
  // 模拟 router 外部 take_profit 请求 (与内部并发)
  const r2 = await router.processSignal({
    action: 'take_profit',
    direction: 'long',
    trigger: 'tp_1',
    token: 'test-idem-token',
  }, { source: 'http' });

  await t1;
  exec.fireTakeProfit = stubFireTp;                        // 还原 stub

  assertEq(counters.fireTakeProfit.tp_1, 1, 'fireTakeProfit(tp_1) 总调用次数 (1=内部, 0=外部)');
  if (r2.status !== 409) {
    throw new Error(`外部 take_profit 应返回 409, 实际 status=${r2.status}, body=${JSON.stringify(r2.body)}`);
  }
});

test('外部 stop_loss 完成后, 内部 evaluate 在该方向不会再 fireSl', async () => {
  reset();
  setupActiveLong();
  const r1 = await router.processSignal({
    action: 'stop_loss', direction: 'long', trigger: 'sl', token: 'test-idem-token',
  }, { source: 'http' });
  if (r1.status !== 200) throw new Error(`外部 SL 应 200, 实际 ${r1.status}`);
  assertEq(counters.fireStopLoss, 1, '外部 SL fireStopLoss 次数');

  // 仓位已 close, 内部 evaluate 应直接 return
  await emitTicks(63500, 100, 0);
  assertEq(counters.fireStopLoss, 1, '内部 evaluate 不再触发 SL');
});

test('外部 take_profit tp_1 重复 5 次 → 后 4 次都 409', async () => {
  reset();
  setupActiveLong();
  const results = [];
  for (let i = 0; i < 5; i++) {
    const r = await router.processSignal({
      action: 'take_profit', direction: 'long', trigger: 'tp_1', token: 'test-idem-token',
    }, { source: 'http' });
    results.push(r.status);
  }
  assertEq(counters.fireTakeProfit.tp_1, 1, 'fireTakeProfit(tp_1) 累计');
  if (results[0] !== 200) throw new Error(`首次应 200, 实际 ${results[0]}`);
  for (let i = 1; i < 5; i++) {
    if (results[i] !== 409) throw new Error(`第 ${i+1} 次应 409, 实际 ${results[i]}`);
  }
});

// ============ 场景 3: pending → entry 触达 仅 1 次 fill ============
test('pending 围绕 entry 抖动 100 ticks → 仅 forwardOpen 一次', async () => {
  reset();
  state.armPending('long', {
    entry: 65000, sl: 64000, tp1: 65500, tp2: 66000, tp3: 66500,
    positionSize: '10%', leverage: 100,
    source: 'manual_fallback', raw: { test: true },
  });
  // 价格抖动: 64999 → 65001 → 64998 → 65002 ...
  await emitTicks(64999, 30, 0);
  await emitTicks(65001, 30, 0);
  await emitTicks(64998, 30, 0);
  assertEq(counters.forwardOpen, 1, 'forwardOpen 调用次数 (pending → fill 仅 1 次)');
});

// ============ 场景 4: 全平按钮连点 5 次 ============
test('manual_close_all 并发 5 次 → 仅 1 次 fireStopLoss', async () => {
  reset();
  setupActiveLong();
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(router.manualCloseAllImpl({ source: 'test' }));
  }
  await Promise.all(promises);
  assertEq(counters.fireStopLoss, 1, '一键全平 fireStopLoss 次数');
});

// ============ 场景 6: 30min TTL 已被移除 — pending 过期不会自动取消 ============
test('pending 即便 expireAt 在过去, 也不会被自动取消 (30min TTL 已移除)', async () => {
  reset();
  state.armPending('long', {
    entry: 65000, sl: 64000, tp1: 65500, tp2: 66000, tp3: 66500,
    positionSize: '10%', leverage: 100,
    source: 'manual_fallback', raw: { test: true },
  });
  // 模拟"上次 arm 时还在用 TTL 模式, 把 expireAt 写成已过期" — 验证新代码不会因此取消
  const longPos = state.getPosition('long');
  longPos.pendingExpireAt = Date.now() - 60 * 1000; // 1 min ago, 完全过期
  // 大量 ticks 在远离 entry 的价位 — 旧版会触发 firePendingExpired 取消, 新版应该完全无视
  await emitTicks(70000, 100, 0);
  const after = state.getPosition('long');
  if (!after || !after.pending) {
    throw new Error('pending 被错误取消了, 30min TTL 没有完全移除');
  }
  assertEq(counters.forwardOpen, 0, '价格远离 entry, 不应 fill');
  assertEq(counters.fireStopLoss, 0, '不应 fire SL (此时无 active)');
});

// ============ 场景 5: 进程崩溃恢复 — 状态文件已标 tp1 已触发 ============
test('磁盘状态 tpHit.tp1=true 时启动, evaluate 不会再 fire tp_1', async () => {
  reset();
  // 模拟"上次进程崩溃前已经标记 tp1 触发, 但 webhook 没发出"
  state.openPosition('long', {
    entryPrice: 65000,
    leverage: 100,
    positionSize: '10%',
    tp1: 65500, tp2: 66000, tp3: 66500,
    initialStopLoss: 64000,
    currentStopLoss: 64000,
  });
  state.markTpHit('long', 'tp1');
  await emitTicks(65501, 50, 0);
  assertEq(counters.fireTakeProfit.tp_1, 0, 'tp1 已 marked, 重启后不再 fire');
});

// ============ 跑测试 ============
(async () => {
  let pass = 0, fail = 0;
  console.log(`\n[verify-idem] 共 ${tests.length} 个用例\n`);
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✅ ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`  ❌ ${t.name}\n     ${e.message}`);
      fail++;
    }
  }
  console.log(`\n[verify-idem] ${pass} passed, ${fail} failed`);
  try { fs.unlinkSync(TMP_STATE); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
