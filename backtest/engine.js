/**
 * ============================================================
 *  backtest/engine.js
 *  策略回测引擎 (与生产环境共用同一套指标 / Regime / tradePlan 算法)
 *
 *  设计:
 *   - 拉取过去 N 天的 BTCUSDT 1H K 线 (通过 axios + keep-alive agent)
 *   - 用 200 根 warmup 计算指标稳定后, 从第 201 根开始逐根模拟
 *   - 每根 K 线流程 (与线上 PENDING 模式完全对齐):
 *       1) 处理 active 仓位的 SL/TP1/TP2/TP3 (悲观假设: 同根优先看 SL)
 *       2) 处理 pending 限价 — bar.low<=entry (long) / bar.high>=entry (short) 触发 fill
 *       3) 计算最新指标 + tradePlan
 *       4) 若空闲 (无 active 无 pending 同方向) 且 plan.ok → arm pending
 *   - 杠杆 / 仓位 / TP1=50% TP2=30% TP3=20% / TP1 后保本止损 全部沿用线上规则
 *
 *  输出:
 *   - summary: 胜率 / 盈亏比 / 收益率 / 最大回撤 / 平均 R / 期望
 *   - trades : 每笔完整交易记录 (含分批平仓明细)
 *   - equityCurve: 资金曲线 (每根 K 线一点)
 * ============================================================
 */
'use strict';

const axios = require('axios');
const { httpAgent, httpsAgent } = require('../lib/httpAgents');
const { computeMACD, computeRSI } = require('../indicators/macdRsi');
const regimeMod = require('../regimeModule');

if (!regimeMod || !regimeMod._internal) {
  throw new Error(
    '[backtest] regimeModule._internal 未导出. 请确认 regimeModule.js 末尾的 module.exports 在 router.use(\'/backtest\', ...) 之前.'
  );
}

const {
  computeATR, computeADX, computeHV, computeROC, computeSlope,
  judgeRegime, enhanceRegime, buildTradePlan,
} = regimeMod._internal;

// 默认参数
const DEFAULT_PARAMS = {
  days: 30,
  initialCapital: 1000,
  leverage: null,           // null = 沿用 plan/默认; 数字 = 显式覆盖
  defaultLeverage: 100,
  feeRate: 0.0004,          // 单边 0.04% (币安 USDT 永续 maker/taker)
  slippage: 0.0003,         // 单边 0.03% 滑点
  pendingTtlBars: 6,        // 6 根 1H K 线 = 6 小时未触达自动取消
  warmupBars: 200,
};

// ============ 历史 K 线拉取 ============
async function fetchHistoricalKlines({ days, warmupBars }) {
  const totalBars = days * 24 + warmupBars;
  const url = 'https://fapi.binance.com/fapi/v1/klines';
  const limit = 1500;       // binance fapi 单次上限
  const out = [];
  let endTime = Date.now();

  while (out.length < totalBars) {
    const need = Math.min(limit, totalBars - out.length);
    const { data } = await axios.get(url, {
      params: { symbol: 'BTCUSDT', interval: '1h', limit: need, endTime },
      timeout: 15000,
      httpAgent, httpsAgent,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    const batch = data.map(k => ({
      time: k[0],
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    // batch 是按时间升序的, 我们要 prepend (因为 endTime 往前拉)
    out.unshift(...batch);
    // 去重 + 退一步
    endTime = batch[0].time - 1;
    if (data.length < need) break;   // 没更多历史
  }

  // 去重 (防 endTime 边界重叠)
  const seen = new Set();
  const uniq = [];
  for (const k of out) {
    if (!seen.has(k.time)) { seen.add(k.time); uniq.push(k); }
  }
  return uniq.slice(-totalBars);
}

// ============ 单根 K 线指标 + plan ============
function buildPlanForSlice(slice) {
  const h = slice.map(k => k.high);
  const l = slice.map(k => k.low);
  const c = slice.map(k => k.close);
  const atr = computeATR(h, l, c, 14);
  const { adx, plusDI, minusDI } = computeADX(h, l, c, 14);
  const hv = computeHV(c, 24);
  const roc = computeROC(c, 14);
  const slope = computeSlope(c, 14);
  const { macd, signal, hist } = computeMACD(c, { fast: 12, slow: 26, signal: 9 });
  const rsi = computeRSI(c, 14);
  const indicators = { atr, adx, plusDI, minusDI, hv, roc, slope, macd, signal, hist, rsi };
  const baseRegime = judgeRegime(indicators);
  const lastIdx = slice.length - 1;
  const enhanced = enhanceRegime(baseRegime, {
    adx: adx[lastIdx], plusDI: plusDI[lastIdx], minusDI: minusDI[lastIdx],
    hv: hv[lastIdx], macd: macd[lastIdx], signal: signal[lastIdx],
    hist: hist[lastIdx], rsi: rsi[lastIdx], close: c[lastIdx], histSeries: hist,
  });
  const tradePlan = buildTradePlan(indicators, enhanced, slice);
  return { indicators, regime: enhanced, tradePlan };
}

// ============ 模拟交易 ============
/** 创建一笔成交 (pending → active) */
function openTradeFromPlan(direction, plan, fillPrice, bar, capital, params) {
  const isLong = direction === 'long';
  const lev = params.leverage || params.defaultLeverage;
  const positionPct = plan.positionPct;
  const margin = capital * (positionPct / 100);
  // 滑点: 多头买入 fillPrice 上偏, 空头卖出 fillPrice 下偏
  const fillWithSlip = fillPrice * (1 + (isLong ? 1 : -1) * params.slippage);
  const units = (margin * lev) / fillWithSlip;
  const openFee = margin * lev * params.feeRate;
  return {
    direction,
    entryBar: bar,
    entryTime: bar.time,
    plannedEntry: plan.entry,
    fillPrice: fillWithSlip,
    initialSL: plan.sl,
    currentSL: plan.sl,
    tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
    positionPct,
    leverage: lev,
    margin,
    units,
    initialUnits: units,
    cumulativePnl: -openFee,
    closes: [],         // 分批平仓记录
    closed: false,
    closeReason: null,
    protectionArmed: false,
  };
}

/** 部分平仓 */
function partialClose(trade, ratio, exitPrice, bar, params, reason) {
  const isLong = trade.direction === 'long';
  const closeUnits = trade.initialUnits * ratio;
  const exitWithSlip = exitPrice * (1 + (isLong ? -1 : 1) * params.slippage);
  const pnl = (exitWithSlip - trade.fillPrice) * closeUnits * (isLong ? 1 : -1);
  const closeFee = exitWithSlip * closeUnits * params.feeRate;
  trade.cumulativePnl += pnl - closeFee;
  trade.units -= closeUnits;
  trade.closes.push({
    bar: bar.time, price: exitPrice, ratio, pnl: pnl - closeFee, reason,
  });
}

/** 完整关闭 */
function fullClose(trade, exitPrice, bar, params, reason) {
  if (trade.units > 0) partialClose(trade, trade.units / trade.initialUnits, exitPrice, bar, params, reason);
  trade.closed = true;
  trade.closeReason = reason;
  trade.exitTime = bar.time;
  trade.exitPrice = exitPrice;
  trade.totalPnl = trade.cumulativePnl;
  trade.pnlPct = (trade.totalPnl / trade.margin) * 100;  // 占本金百分比
  trade.rMultiple = computeRMultiple(trade);
}

/** R 倍数 = pnl / 初始风险 */
function computeRMultiple(trade) {
  const isLong = trade.direction === 'long';
  const riskPerUnit = isLong ? (trade.fillPrice - trade.initialSL) : (trade.initialSL - trade.fillPrice);
  if (riskPerUnit <= 0) return null;
  const initialRisk = riskPerUnit * trade.initialUnits;
  return initialRisk > 0 ? trade.totalPnl / initialRisk : null;
}

/** 同根 K 线内检查 SL/TP 触发顺序 (悲观: 先看 SL, 再依次 TP1/TP2/TP3) */
function processActiveBar(trade, bar, params) {
  if (trade.closed) return;
  const isLong = trade.direction === 'long';
  // 1) SL 检查 (含保本)
  const slHit = isLong ? bar.low <= trade.currentSL : bar.high >= trade.currentSL;
  if (slHit) {
    const reason = trade.protectionArmed ? 'sl_protection' : 'sl';
    fullClose(trade, trade.currentSL, bar, params, reason);
    return;
  }
  // 2) TP1
  if (!trade.closes.find(c => c.reason === 'tp_1')) {
    const tp1Hit = isLong ? bar.high >= trade.tp1 : bar.low <= trade.tp1;
    if (tp1Hit) {
      partialClose(trade, 0.5, trade.tp1, bar, params, 'tp_1');
      // 触发保本止损: SL → entry
      trade.currentSL = trade.fillPrice;
      trade.protectionArmed = true;
    }
  }
  // 3) TP2 (要求 TP1 已触发)
  if (trade.closes.find(c => c.reason === 'tp_1') && !trade.closes.find(c => c.reason === 'tp_2')) {
    const tp2Hit = isLong ? bar.high >= trade.tp2 : bar.low <= trade.tp2;
    if (tp2Hit) {
      partialClose(trade, 0.3, trade.tp2, bar, params, 'tp_2');
    }
  }
  // 4) TP3 (要求 TP2 已触发) - 触发后 100% 关闭
  if (trade.closes.find(c => c.reason === 'tp_2') && !trade.closes.find(c => c.reason === 'tp_3')) {
    const tp3Hit = isLong ? bar.high >= trade.tp3 : bar.low <= trade.tp3;
    if (tp3Hit) {
      fullClose(trade, trade.tp3, bar, params, 'tp_3');
    }
  }
}

// ============ 主流程 ============
async function runBacktest(userParams = {}) {
  const params = { ...DEFAULT_PARAMS, ...userParams };
  const startedAt = Date.now();

  const klines = await fetchHistoricalKlines(params);
  if (klines.length < params.warmupBars + 24) {
    throw new Error(`历史 K 线不足: 拿到 ${klines.length}, 需要至少 ${params.warmupBars + 24}`);
  }

  let capital = params.initialCapital;
  let peakCapital = capital;
  let maxDrawdown = 0;
  let maxDrawdownAt = null;
  const trades = [];
  const equityCurve = [];
  const pending = { long: null, short: null };
  const active = { long: null, short: null };

  for (let i = params.warmupBars; i < klines.length; i++) {
    const bar = klines[i];

    // ---- 1) 先处理 active 仓位 (本根 K 线触发的 SL/TP)
    for (const dir of ['long', 'short']) {
      const t = active[dir];
      if (!t) continue;
      processActiveBar(t, bar, params);
      if (t.closed) {
        capital += t.totalPnl;
        trades.push(t);
        active[dir] = null;
      }
    }

    // ---- 2) 处理 pending: 本根 K 线 entry 是否触达?
    for (const dir of ['long', 'short']) {
      const p = pending[dir];
      if (!p) continue;
      // 超时
      if (i - p.armedBar >= params.pendingTtlBars) {
        pending[dir] = null;
        continue;
      }
      const isLong = dir === 'long';
      const fillHit = isLong ? bar.low <= p.entry : bar.high >= p.entry;
      if (fillHit && !active[dir]) {
        const fillPrice = isLong
          ? Math.min(bar.open, p.entry)   // 多: 开盘已穿透 → 用 open; 否则 entry 限价
          : Math.max(bar.open, p.entry);
        active[dir] = openTradeFromPlan(dir, p, fillPrice, bar, capital, params);
        pending[dir] = null;
        // 同一根 K 线立即检查 SL/TP (开盘成交后, 本根剩余区间可能立刻触发)
        processActiveBar(active[dir], bar, params);
        if (active[dir].closed) {
          capital += active[dir].totalPnl;
          trades.push(active[dir]);
          active[dir] = null;
        }
      }
    }

    // ---- 3) 计算本根 plan
    const slice = klines.slice(0, i + 1);
    let result;
    try { result = buildPlanForSlice(slice); }
    catch (e) { continue; }
    const plan = result.tradePlan;

    // ---- 4) arm pending (防重复: 已 active 或 pending 同方向 → 跳)
    if (plan && plan.ok && plan.direction) {
      const dir = plan.direction;
      if (!active[dir] && !pending[dir]) {
        pending[dir] = {
          entry: plan.entry,
          sl: plan.stopLoss,
          tp1: plan.takeProfits[0].price,
          tp2: plan.takeProfits[1].price,
          tp3: plan.takeProfits[2].price,
          positionPct: plan.suggestedPositionPct,
          confidence: plan.confidenceLabel,
          armedBar: i,
          armedTime: bar.time,
        };
      }
    }

    // ---- 5) 资金曲线 (含浮动盈亏)
    const floatingPnl = ['long', 'short'].reduce((acc, dir) => {
      const t = active[dir];
      if (!t) return acc;
      const isLong = dir === 'long';
      const sign = isLong ? 1 : -1;
      return acc + (bar.close - t.fillPrice) * t.units * sign;
    }, 0);
    const equity = capital + floatingPnl;
    if (equity > peakCapital) peakCapital = equity;
    const dd = peakCapital > 0 ? (peakCapital - equity) / peakCapital : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownAt = bar.time;
    }
    equityCurve.push({ time: bar.time, equity, capital, floating: floatingPnl });
  }

  // 收盘前强制平仓所有未结仓位
  const lastBar = klines[klines.length - 1];
  for (const dir of ['long', 'short']) {
    const t = active[dir];
    if (!t) continue;
    fullClose(t, lastBar.close, lastBar, params, 'final_close');
    capital += t.totalPnl;
    trades.push(t);
    active[dir] = null;
  }

  const summary = computeSummary(trades, params.initialCapital, capital, maxDrawdown, maxDrawdownAt, klines);
  return {
    finishedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    params,
    range: {
      from: klines[params.warmupBars]?.time,
      to: lastBar.time,
      bars: klines.length - params.warmupBars,
    },
    summary,
    trades: trades.map(simplifyTrade),
    equityCurve,
  };
}

// ============ 统计 ============
function computeSummary(trades, initial, final, maxDD, maxDDAt, klines) {
  const wins = trades.filter(t => t.totalPnl > 0);
  const losses = trades.filter(t => t.totalPnl <= 0);
  const sumWin = wins.reduce((a, t) => a + t.totalPnl, 0);
  const sumLoss = losses.reduce((a, t) => a + t.totalPnl, 0);
  const avgWin = wins.length ? sumWin / wins.length : 0;
  const avgLoss = losses.length ? sumLoss / losses.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const profitFactor = sumLoss < 0 ? Math.abs(sumWin / sumLoss) : (sumWin > 0 ? Infinity : 0);
  const payoff = avgLoss < 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? Infinity : 0);
  const expectancy = trades.length
    ? (winRate * avgWin + (1 - winRate) * avgLoss) : 0;
  const totalReturn = ((final - initial) / initial) * 100;
  const longTrades = trades.filter(t => t.direction === 'long');
  const shortTrades = trades.filter(t => t.direction === 'short');
  const tpClosed = trades.filter(t => t.closeReason && t.closeReason.startsWith('tp_')).length;
  const slClosed = trades.filter(t => t.closeReason === 'sl').length;
  const slProtClosed = trades.filter(t => t.closeReason === 'sl_protection').length;

  return {
    initialCapital: initial,
    finalCapital: round2(final),
    totalReturnPct: round2(totalReturn),
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct: round2(winRate * 100),
    profitFactor: isFinite(profitFactor) ? round2(profitFactor) : 'inf',
    payoffRatio: isFinite(payoff) ? round2(payoff) : 'inf',
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    expectancyPerTrade: round2(expectancy),
    maxDrawdownPct: round2(maxDD * 100),
    maxDrawdownAt: maxDDAt,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longWinRatePct: longTrades.length
      ? round2(longTrades.filter(t => t.totalPnl > 0).length / longTrades.length * 100) : 0,
    shortWinRatePct: shortTrades.length
      ? round2(shortTrades.filter(t => t.totalPnl > 0).length / shortTrades.length * 100) : 0,
    tpClosed,
    slClosed,
    slProtectionClosed: slProtClosed,
  };
}

function simplifyTrade(t) {
  return {
    direction: t.direction,
    entryTime: t.entryTime,
    entryPrice: round2(t.fillPrice),
    plannedEntry: round2(t.plannedEntry),
    initialSL: round2(t.initialSL),
    tp1: round2(t.tp1), tp2: round2(t.tp2), tp3: round2(t.tp3),
    leverage: t.leverage,
    positionPct: t.positionPct,
    margin: round2(t.margin),
    closes: t.closes.map(c => ({
      time: c.bar, price: round2(c.price), ratio: c.ratio,
      pnl: round2(c.pnl), reason: c.reason,
    })),
    closed: t.closed,
    closeReason: t.closeReason,
    exitTime: t.exitTime,
    exitPrice: round2(t.exitPrice),
    totalPnl: round2(t.totalPnl),
    pnlPct: round2(t.pnlPct),
    rMultiple: t.rMultiple == null ? null : round2(t.rMultiple),
  };
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

module.exports = {
  runBacktest,
  fetchHistoricalKlines,
  buildPlanForSlice,
  DEFAULT_PARAMS,
};
