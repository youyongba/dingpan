/**
 * ============================================================
 *  backtest/router.js
 *  策略回测 - Express 路由 + 飞书推送 + 历史持久化
 *
 *  对外接口:
 *    POST /run           触发一次回测 (body: {days, initialCapital, leverage, push})
 *    GET  /last          上一次结果 (含 trades + equityCurve, 文件较大慎用)
 *    GET  /summary       上一次摘要 (轻量, 不含明细)
 *    GET  /history       最近 50 次回测的摘要列表
 *
 *  并发控制: 同时只允许一个回测在跑 (重 IO + CPU 的拉数据 + 计算)
 *  飞书推送: 复用 notifier/feishuWebhook.sendRich (eventKey='backtest_run', 强制 force=true)
 * ============================================================
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const engine = require('./engine');
const webhook = require('../notifier/feishuWebhook');

const router = express.Router();

const HISTORY_FILE = process.env.BACKTEST_HISTORY_PATH
  || path.join(__dirname, '..', 'data', 'backtest_history.json');
// 完整 last result (含 trades + equityCurve) 落盘文件 — 用于进程重启后恢复,
// 避免每次重启用户进页面就 GET /last → 404. 文件几百 KB ~ 几 MB, 写一次读一次, 影响可控.
const LAST_RESULT_FILE = process.env.BACKTEST_LAST_RESULT_PATH
  || path.join(__dirname, '..', 'data', 'backtest_last_result.json');
const HISTORY_MAX = 50;

let _running = false;
let _lastResult = null;

// 启动时尝试从磁盘加载上次完整结果, 让用户进页面就能看到 (即便服务刚重启)
function loadLastResult() {
  try {
    if (!fs.existsSync(LAST_RESULT_FILE)) return null;
    const raw = fs.readFileSync(LAST_RESULT_FILE, 'utf8');
    const r = JSON.parse(raw);
    // 最低限度结构校验, 防止旧版本 schema 进来污染
    if (r && r.summary && Array.isArray(r.trades) && Array.isArray(r.equityCurve)) {
      console.log(`[backtest] ✅ 已恢复上次回测结果: ${r.finishedAt}, ${r.trades.length} 笔交易`);
      return r;
    }
    console.warn('[backtest] last_result.json schema 不匹配, 忽略');
    return null;
  } catch (e) {
    console.error('[backtest] 加载上次结果失败, 忽略:', e.message);
    return null;
  }
}
function saveLastResult(result) {
  try {
    const dir = path.dirname(LAST_RESULT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LAST_RESULT_FILE, JSON.stringify(result));
  } catch (e) {
    console.error('[backtest] 保存 last_result 失败 (内存版仍可用):', e.message);
  }
}
_lastResult = loadLastResult();

// ---------------- 历史持久化 ----------------
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[backtest] 历史文件读取失败:', e.message);
    return [];
  }
}
function saveHistory(arr) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(-HISTORY_MAX), null, 2));
  } catch (e) {
    console.error('[backtest] 历史文件保存失败:', e.message);
  }
}

// ---------------- 飞书推送 ----------------
function pushFeishuSummary(result) {
  const s = result.summary;
  const p = result.params;
  const fromStr = result.range.from ? new Date(result.range.from).toLocaleString() : '--';
  const toStr = result.range.to ? new Date(result.range.to).toLocaleString() : '--';
  const totalReturnLabel = (s.totalReturnPct >= 0 ? '+' : '') + s.totalReturnPct + '%';
  const profitFactorStr = String(s.profitFactor);
  const titleEmoji = s.totalReturnPct >= 0 ? '📈' : '📉';

  const lines = [
    [{ text: '⏰ 回测时间：' }, { text: new Date().toLocaleString() }],
    [{ text: `📅 数据区间：${fromStr} → ${toStr}` }],
    [{ text: `📊 K 线数：${result.range.bars} 根 (1H, 约 ${Math.round(result.range.bars / 24)} 天)` }],
    [{ text: '━━━━━ 资金概况 ━━━━━' }],
    [{ text: `💰 初始资金：${s.initialCapital} USDT` }],
    [{ text: `💼 最终资金：${s.finalCapital} USDT  (${totalReturnLabel})` }],
    [{ text: `📉 最大回撤：${s.maxDrawdownPct}%` }],
    [{ text: '━━━━━ 交易统计 ━━━━━' }],
    [{ text: `🎯 总交易：${s.totalTrades} 笔  (多 ${s.longTrades} / 空 ${s.shortTrades})` }],
    [{ text: `✅ 胜率：${s.winRatePct}%  (盈 ${s.winningTrades} / 亏 ${s.losingTrades})` }],
    [{ text: `⚖️ 盈亏比 (avgW/avgL)：${s.payoffRatio}` }],
    [{ text: `🚀 利润因子 (PF)：${profitFactorStr}` }],
    [{ text: `📊 单笔期望：${s.expectancyPerTrade} USDT` }],
    [{ text: `📈 平均盈利：${s.avgWin}   📉 平均亏损：${s.avgLoss}` }],
    [{ text: `🔓 平多胜率：${s.longWinRatePct}%   🔒 平空胜率：${s.shortWinRatePct}%` }],
    [{ text: '━━━━━ 平仓分布 ━━━━━' }],
    [{ text: `🎯 TP 触发：${s.tpClosed} 笔` }],
    [{ text: `🛑 SL 触发：${s.slClosed} 笔` }],
    [{ text: `🛡️ 保本止损：${s.slProtectionClosed} 笔` }],
    [{ text: '━━━━━ 反向信号取消 ━━━━━' }],
    [{ text: `🔄 总取消挂单：${s.cancelTotal ?? 0} 次  (MACD ${s.cancelByMacdCross ?? 0} / RSI ${s.cancelByRsiZone ?? 0} / FVG ${s.cancelByFvg ?? 0})` }],
    [{ text: '━━━━━ 参数 ━━━━━' }],
    [{ text: `杠杆 ${p.leverage || p.defaultLeverage}x · 单边费率 ${(p.feeRate * 100).toFixed(3)}% · 滑点 ${(p.slippage * 100).toFixed(3)}%` }],
    [{ text: `TP1 保本止损：${p.tp1Protection !== false ? '✅ 开启' : '❌ 关闭'} · 反向信号取消：${p.cancelOnReverseSignal !== false ? '✅ 开启' : '❌ 关闭'}` }],
  ];

  return webhook.sendRich(
    `${titleEmoji} ${p.days} 天策略回测结果 · 胜率 ${s.winRatePct}%`,
    lines,
    { eventKey: 'backtest_run', force: true }
  );
}

// ---------------- 路由 ----------------
router.post('/run', async (req, res) => {
  if (_running) {
    return res.status(409).json({ ok: false, error: 'already_running' });
  }
  const body = req.body || {};
  const userParams = {};
  if (body.days != null) userParams.days = Math.max(1, Math.min(180, parseInt(body.days, 10) || 30));
  if (body.initialCapital != null) userParams.initialCapital = Math.max(10, parseFloat(body.initialCapital) || 1000);
  if (body.leverage != null) userParams.leverage = Math.max(1, Math.min(125, parseInt(body.leverage, 10) || 100));
  if (body.feeRate != null) userParams.feeRate = parseFloat(body.feeRate);
  if (body.slippage != null) userParams.slippage = parseFloat(body.slippage);
  if (body.pendingTtlBars != null) userParams.pendingTtlBars = parseInt(body.pendingTtlBars, 10);
  // TP1 后是否启用保本止损 (默认沿用 engine.DEFAULT_PARAMS = true)
  if (body.tp1Protection != null) userParams.tp1Protection = !!body.tp1Protection;
  // 反向信号 (MACD 金/死叉 + RSI 超买/超卖 + FVG) 是否取消挂单
  if (body.cancelOnReverseSignal != null) userParams.cancelOnReverseSignal = !!body.cancelOnReverseSignal;
  const wantPush = body.push !== false;     // 默认推飞书; 显式传 false 不推

  _running = true;
  const startedAt = Date.now();
  try {
    const result = await engine.runBacktest(userParams);
    _lastResult = result;
    // 完整结果落盘 — 进程重启后能直接恢复, 不再 404
    saveLastResult(result);

    // 落盘 (只存摘要 + 参数, trades/equity 太大不进 history)
    const hist = loadHistory();
    hist.push({
      finishedAt: result.finishedAt,
      elapsedMs: result.elapsedMs,
      params: result.params,
      range: result.range,
      summary: result.summary,
    });
    saveHistory(hist);

    // 飞书推送
    let pushResult = null;
    if (wantPush) {
      try {
        pushResult = await pushFeishuSummary(result);
      } catch (e) {
        console.error('[backtest] 飞书推送失败:', e.message);
        pushResult = { ok: false, error: e.message };
      }
    }

    res.json({
      ok: true,
      params: result.params,
      range: result.range,
      summary: result.summary,
      tradeCount: result.trades.length,
      equityPoints: result.equityCurve.length,
      pushed: !!pushResult?.ok,
      pushDetail: pushResult,
      elapsedMs: result.elapsedMs,
    });
  } catch (e) {
    console.error('[backtest] 回测失败:', e);
    res.status(500).json({ ok: false, error: e.message, elapsedMs: Date.now() - startedAt });
  } finally {
    _running = false;
  }
});

router.get('/last', (req, res) => {
  if (!_lastResult) return res.status(404).json({ ok: false, error: 'no_result_yet' });
  res.json({ ok: true, ...filterResultByQuery(_lastResult, req.query) });
});

router.get('/summary', (req, res) => {
  if (!_lastResult) return res.status(404).json({ ok: false, error: 'no_result_yet' });
  const r = _lastResult;
  res.json({
    ok: true,
    finishedAt: r.finishedAt,
    elapsedMs: r.elapsedMs,
    params: r.params,
    range: r.range,
    summary: r.summary,
    tradeCount: r.trades.length,
  });
});

router.get('/history', (req, res) => {
  res.json({ ok: true, history: loadHistory() });
});

router.get('/status', (req, res) => {
  res.json({ ok: true, running: _running, hasLast: !!_lastResult });
});

// 限制返回字段大小: ?max_trades=20&equity_step=4
function filterResultByQuery(result, q) {
  const out = {
    finishedAt: result.finishedAt,
    elapsedMs: result.elapsedMs,
    params: result.params,
    range: result.range,
    summary: result.summary,
  };
  const maxTrades = Math.max(0, parseInt(q.max_trades, 10) || result.trades.length);
  out.trades = result.trades.slice(-maxTrades);
  const equityStep = Math.max(1, parseInt(q.equity_step, 10) || 1);
  out.equityCurve = result.equityCurve.filter((_, i) => i % equityStep === 0);
  return out;
}

module.exports = router;
