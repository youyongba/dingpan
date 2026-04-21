/**
 * ============================================================
 *  regimeModule.js
 *  宏观市场状态（Regime）独立判定模块
 *  - 拉取 Binance USDT 永续合约 BTCUSDT 1h K线
 *  - 计算 ATR / ADX / +DI / -DI / HV / ROC / Slope
 *  - 输出 Regime：趋势 / 震荡 / 恐慌 / 中性
 *  - 与原有业务完全解耦：只对外暴露一个 Express Router
 * ============================================================
 */
const express = require('express');
const axios = require('axios');
const path = require('path');

const router = express.Router();

// ---------------------- 配置 ----------------------
const BINANCE_FAPI = 'https://fapi.binance.com';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const LIMIT = 500;                 // 拉取 500 根K线
const REFRESH_MS = 5 * 60 * 1000;  // 5 分钟刷新一次
const TIMEOUT = Number(process.env.BINANCE_TIMEOUT_MS || 10000);

// 飞书通知配置
const NOTIFY = {
  enabled: process.env.REGIME_FEISHU_ENABLED !== '0',
  notifyOnStartup: true,
  failuresBeforeAlert: Number(process.env.REGIME_FAIL_ALERT_THRESHOLD) || 3,
};

// 内存缓存
let cache = {
  updatedAt: 0,
  klines: [],
  indicators: null,
  regime: null,
  tradePlan: null,
  error: null,
};

// ---------------------- 飞书通知（依赖注入）----------------------
let notifier = null;
function setNotifier(fn) {
  if (typeof fn === 'function') notifier = fn;
}
function notify(title, text, isAlert = false) {
  if (!NOTIFY.enabled) return;
  if (notifier) {
    try { notifier(title, text, isAlert); }
    catch (e) { console.error('[regime] notifier 抛错:', e.message); }
  } else {
    console.log(`[regime/notify] ${isAlert ? '⚠️ ' : ''}${title}\n${text}`);
  }
}

// 通知状态机：用于"变化才告警"的去重
const notifyState = {
  lastRegime: null,
  startupSent: false,
  consecutiveFailures: 0,
  failureAlerted: false,
};

function regimeEmoji(r) {
  return ({ TREND: '📈', RANGE: '🔁', PANIC: '🚨', NEUTRAL: '➖' })[r] || '🟢';
}
function fmt(n, d = 2) {
  return n == null || !isFinite(n) ? '--' : Number(n).toFixed(d);
}
function buildIndicatorsText(reg, lastClose) {
  const m = reg.metrics || {};
  return [
    `判定依据: ${reg.desc || '--'}`,
    `Close: ${fmt(lastClose)}`,
    `ADX: ${fmt(m.adx)}   +DI: ${fmt(m.plusDI)}   -DI: ${fmt(m.minusDI)}`,
    `HV(年化): ${fmt(m.hv)}%   分位带: [${fmt(m.hvLow)}%, ${fmt(m.hvHigh)}%]`,
  ].join('\n');
}

// ---------------------- 工具函数 ----------------------
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * Wilder 平滑（RMA）：TR/ATR/ADX 常用平滑
 */
function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

// ---------------------- 指标计算 ----------------------
/**
 * 计算 ATR(14)
 */
function computeATR(h, l, c, period = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  return wilderSmooth(tr, period);
}

/**
 * 计算 ADX / +DI / -DI (14)
 */
function computeADX(h, l, c, period = 14) {
  const len = c.length;
  const tr = [0], plusDM = [0], minusDM = [0];
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  const atr = wilderSmooth(tr, period);
  const pDM = wilderSmooth(plusDM, period);
  const mDM = wilderSmooth(minusDM, period);

  const plusDI = atr.map((a, i) => a ? 100 * pDM[i] / a : null);
  const minusDI = atr.map((a, i) => a ? 100 * mDM[i] / a : null);
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || (p + m) === 0) return null;
    return 100 * Math.abs(p - m) / (p + m);
  });

  // ADX = Wilder 平滑 dx
  const validDX = dx.map(v => v == null ? 0 : v);
  const adx = wilderSmooth(validDX, period).map((v, i) => dx[i] == null ? null : v);

  return { adx, plusDI, minusDI };
}

/**
 * 历史波动率 HV (替代 VIX)
 * 标准：sqrt(252) * std(log return) * 100，窗口默认 24（1 天，1h K线）
 */
function computeHV(close, window = 24) {
  const logRet = [null];
  for (let i = 1; i < close.length; i++) {
    logRet.push(Math.log(close[i] / close[i - 1]));
  }
  const out = new Array(close.length).fill(null);
  for (let i = window; i < close.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1);
    const m = mean(slice);
    const variance = mean(slice.map(x => (x - m) ** 2));
    // 年化：1h K线，一年约 24*365 根
    out[i] = Math.sqrt(variance) * Math.sqrt(24 * 365) * 100;
  }
  return out;
}

/**
 * ROC(14) 价格变化率
 */
function computeROC(close, period = 14) {
  const out = new Array(close.length).fill(null);
  for (let i = period; i < close.length; i++) {
    out[i] = ((close[i] - close[i - period]) / close[i - period]) * 100;
  }
  return out;
}

/**
 * Slope 斜率（最近 N 根的最小二乘回归斜率，反映加速度）
 */
function computeSlope(close, window = 14) {
  const out = new Array(close.length).fill(null);
  for (let i = window - 1; i < close.length; i++) {
    const ys = close.slice(i - window + 1, i + 1);
    const n = ys.length;
    const xs = Array.from({ length: n }, (_, k) => k);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) {
      num += (xs[k] - mx) * (ys[k] - my);
      den += (xs[k] - mx) ** 2;
    }
    out[i] = den === 0 ? 0 : num / den;
  }
  return out;
}

// ---------------------- Regime 判定 ----------------------
/**
 * 规则：
 *  - 趋势市：ADX > 25 且 HV 处于中高分位
 *  - 震荡市：ADX < 20 且 HV 处于中低分位
 *  - 恐慌市：HV 处于高位 且 ADX < 25（强波动但无方向）
 *  - 中性市：其余
 */
function judgeRegime(ind) {
  const lastIdx = ind.adx.length - 1;
  const adx = ind.adx[lastIdx];
  const plusDI = ind.plusDI[lastIdx];
  const minusDI = ind.minusDI[lastIdx];
  const hv = ind.hv[lastIdx];

  // 以最近 100 根 HV 的分位数判断高低波
  const hvSlice = ind.hv.slice(-100).filter(v => v != null).sort((a, b) => a - b);
  const q = p => hvSlice[Math.floor(hvSlice.length * p)] ?? hv;
  const hvHigh = q(0.7);
  const hvLow = q(0.3);

  let regime = 'NEUTRAL';
  let label = '中性市';
  let color = '#999';
  let desc = '市场无明显特征';

  if (hv >= hvHigh && adx < 25) {
    regime = 'PANIC'; label = '恐慌市'; color = '#e74c3c';
    desc = '高波动 + 弱趋势：注意风险，谨慎交易';
  } else if (adx > 25 && hv >= hvLow) {
    regime = 'TREND'; label = '趋势市'; color = '#27ae60';
    desc = `趋势强劲（${plusDI > minusDI ? '多头' : '空头'}），可顺势`;
  } else if (adx < 20 && hv <= hvHigh) {
    regime = 'RANGE'; label = '震荡市'; color = '#3498db';
    desc = '低波动 + 弱趋势：适合区间/网格策略';
  }

  return {
    regime, label, color, desc,
    metrics: {
      adx: +adx?.toFixed(2),
      plusDI: +plusDI?.toFixed(2),
      minusDI: +minusDI?.toFixed(2),
      hv: +hv?.toFixed(2),
      hvHigh: +hvHigh?.toFixed(2),
      hvLow: +hvLow?.toFixed(2),
    }
  };
}

// ---------------------- 交易计划生成 ----------------------
/**
 * 基于当前指标输出结构化交易计划（仅作建议，纯盯盘模式不会自动下单）。
 *
 * 方法：
 *   方向 — 由 regime + DI 决定
 *     · TREND  + +DI > -DI  → 做多（顺势）
 *     · TREND  + -DI > +DI  → 做空（顺势）
 *     · NEUTRAL 且 |+DI - -DI| > 8  → 小仓位试单
 *     · RANGE / PANIC / DI 模糊      → 观望
 *   入场 — 当前价回踩 0.5 × ATR（避免追高/杀跌，提高 R:R）
 *   止损 — 1.5 × ATR (Wilder 经典)
 *   止盈 — TP1 = 1R, TP2 = 2R, TP3 = 3R 分批离场（R = 风险距离）
 *   仓位 — ADX 越强、信号置信度越高，建议仓位越大（10% / 20% / 30%）
 */
function buildTradePlan(ind, regime, klines) {
  const close = klines.length ? klines[klines.length - 1].close : null;
  const lastIdx = klines.length - 1;
  const atr = ind.atr[lastIdx];
  const m = regime?.metrics || {};
  const adx = m.adx;
  const plusDI = m.plusDI;
  const minusDI = m.minusDI;

  // 数据完整性检查
  if (close == null || atr == null || atr <= 0 || adx == null) {
    return { ok: false, action: 'wait', reason: '指标数据不足，无法生成交易计划' };
  }

  // 方向 + 置信度
  let direction = null;       // 'long' | 'short'
  let confidence = 'low';     // 'high' | 'medium' | 'low'
  let basis = '';

  const diSpread = Math.abs(plusDI - minusDI);

  if (regime.regime === 'TREND' && adx > 25) {
    direction = plusDI > minusDI ? 'long' : 'short';
    confidence = adx > 35 ? 'high' : 'medium';
    basis = `趋势市 ADX=${adx.toFixed(1)} ${direction === 'long' ? '+DI' : '-DI'} 主导 (差值 ${diSpread.toFixed(1)})`;
  } else if (regime.regime === 'NEUTRAL' && diSpread > 8 && adx > 20) {
    direction = plusDI > minusDI ? 'long' : 'short';
    confidence = 'low';
    basis = `中性市但 DI 差值 ${diSpread.toFixed(1)} 偏 ${direction === 'long' ? '多' : '空'}，小仓位试单`;
  } else if (regime.regime === 'RANGE') {
    return {
      ok: false, action: 'wait',
      reason: '震荡市建议等待区间突破或使用网格策略，不开方向单',
      currentPrice: close,
    };
  } else if (regime.regime === 'PANIC') {
    return {
      ok: false, action: 'wait',
      reason: '恐慌市波动剧烈但无明确方向，建议观望',
      currentPrice: close,
    };
  } else {
    return {
      ok: false, action: 'wait',
      reason: `当前 regime=${regime.label || '未知'} 信号不足以开仓`,
      currentPrice: close,
    };
  }

  // 入场点：回踩 0.5 ATR
  const entry = direction === 'long' ? close - 0.5 * atr : close + 0.5 * atr;
  // 止损：1.5 ATR
  const stop = direction === 'long' ? entry - 1.5 * atr : entry + 1.5 * atr;
  const risk = Math.abs(entry - stop); // = 1.5 * ATR
  // 止盈分级（R 倍数）
  const dirSign = direction === 'long' ? 1 : -1;
  const tp1 = entry + dirSign * 1 * risk;
  const tp2 = entry + dirSign * 2 * risk;
  const tp3 = entry + dirSign * 3 * risk;

  // 仓位建议
  const positionPct = ({ high: 30, medium: 20, low: 10 })[confidence];

  // 数值精度
  const round2 = (n) => Math.round(n * 100) / 100;
  const round3 = (n) => Math.round(n * 1000) / 1000;

  return {
    ok: true,
    action: direction === 'long' ? '做多 (LONG)' : '做空 (SHORT)',
    direction,
    confidence,
    confidenceLabel: { high: '高', medium: '中', low: '低' }[confidence],
    suggestedPositionPct: positionPct,

    currentPrice: round2(close),
    entry: round2(entry),
    stopLoss: round2(stop),
    riskPerUnit: round2(risk),
    riskPct: round3((risk / entry) * 100),

    takeProfits: [
      { level: 'TP1', price: round2(tp1), rr: '1R',
        closePct: 50, gainPct: round3(((dirSign * (tp1 - entry)) / entry) * 100),
        note: '平 50%；将止损上移到入场价（保本）' },
      { level: 'TP2', price: round2(tp2), rr: '2R',
        closePct: 30, gainPct: round3(((dirSign * (tp2 - entry)) / entry) * 100),
        note: '平 30%' },
      { level: 'TP3', price: round2(tp3), rr: '3R',
        closePct: 20, gainPct: round3(((dirSign * (tp3 - entry)) / entry) * 100),
        note: '平剩余 20%；趋势继续可改为移动止损 (1.5 ATR trailing)' },
    ],

    basis,
    notes: [
      `ATR(14) = ${atr.toFixed(2)}`,
      `ADX(14) = ${adx.toFixed(2)}（${confidence === 'high' ? '强' : confidence === 'medium' ? '中' : '弱'}趋势）`,
      `止损距离 = 1.5 × ATR = ${risk.toFixed(2)} (${(risk / entry * 100).toFixed(2)}%)`,
      `R:R = 1 : 3，期望盈亏比正向`,
      `仓位建议 ${positionPct}% 仓位（按账户资金计算）`,
      '⚠️ 建议价位仅供参考，系统为纯盯盘模式不会自动下单',
    ],
  };
}

function buildTradePlanText(plan) {
  if (!plan || !plan.ok) {
    return `📋 交易计划: ${plan?.action === 'wait' ? '🟡 观望' : '— 暂无'}\n${plan?.reason || ''}`;
  }
  const tpLines = plan.takeProfits
    .map((t) => `  ${t.level} @ ${t.price}  (${t.rr}, +${t.gainPct}%, 平${t.closePct}%)`)
    .join('\n');
  return [
    `📋 交易计划: ${plan.action}  [置信度: ${plan.confidenceLabel}]`,
    `当前价: ${plan.currentPrice}`,
    `入场:   ${plan.entry}   (回踩 0.5 ATR)`,
    `止损:   ${plan.stopLoss}   (-${plan.riskPct}%)`,
    `止盈分批:`,
    tpLines,
    `仓位:   ${plan.suggestedPositionPct}% 仓`,
    `依据:   ${plan.basis}`,
  ].join('\n');
}

// ---------------------- 数据拉取 ----------------------
async function fetchKlines() {
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: SYMBOL, interval: INTERVAL, limit: LIMIT },
    timeout: TIMEOUT,
  });
  return data.map(k => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

async function refresh() {
  try {
    const klines = await fetchKlines();
    const h = klines.map(k => k.high);
    const l = klines.map(k => k.low);
    const c = klines.map(k => k.close);

    const atr = computeATR(h, l, c, 14);
    const { adx, plusDI, minusDI } = computeADX(h, l, c, 14);
    const hv = computeHV(c, 24);
    const roc = computeROC(c, 14);
    const slope = computeSlope(c, 14);

    const indicators = { atr, adx, plusDI, minusDI, hv, roc, slope };
    const regime = judgeRegime(indicators);
    const tradePlan = buildTradePlan(indicators, regime, klines);

    const prevRegime = cache.regime;
    cache = {
      updatedAt: Date.now(),
      klines,
      indicators,
      regime,
      tradePlan,
      error: null,
    };
    console.log(`[regime] refreshed @ ${new Date().toISOString()} -> ${regime.label} | plan: ${tradePlan.action}`);
    handleNotificationsOnSuccess(prevRegime, regime, klines, tradePlan);
  } catch (err) {
    cache.error = err.message;
    console.error('[regime] refresh failed:', err.message);
    handleNotificationsOnFailure(err.message);
  }
}

function handleNotificationsOnSuccess(prevRegime, currentRegime, klines, tradePlan) {
  const lastClose = klines.length ? klines[klines.length - 1].close : null;

  // 1) 失败恢复
  if (notifyState.failureAlerted) {
    notify(
      '✅ Regime 监控已恢复',
      `Binance 行情拉取已恢复, 连续失败 ${notifyState.consecutiveFailures} 次后恢复正常。\n` +
        `当前 Regime: ${currentRegime.label}`,
      false,
    );
    notifyState.failureAlerted = false;
  }
  notifyState.consecutiveFailures = 0;

  // 2) 启动首次成功
  if (!notifyState.startupSent && NOTIFY.notifyOnStartup) {
    notifyState.startupSent = true;
    notifyState.lastRegime = currentRegime.regime;
    notify(
      `${regimeEmoji(currentRegime.regime)} Regime 监控已启动 (${currentRegime.label})`,
      `BTC/USDT 1H 宏观状态监控就绪。\n${buildIndicatorsText(currentRegime, lastClose)}\n\n${buildTradePlanText(tradePlan)}`,
      false,
    );
    return;
  }

  // 3) regime 切换通知（核心）
  if (currentRegime.regime && currentRegime.regime !== notifyState.lastRegime) {
    const fromLabel = notifyState.lastRegime
      ? `${regimeLabel(notifyState.lastRegime)} → `
      : '';
    notify(
      `${regimeEmoji(currentRegime.regime)} 市场状态切换: ${fromLabel}${currentRegime.label}`,
      `${buildIndicatorsText(currentRegime, lastClose)}\n\n${buildTradePlanText(tradePlan)}`,
      currentRegime.regime === 'PANIC',
    );
    notifyState.lastRegime = currentRegime.regime;
  }
}

function regimeLabel(r) {
  return ({ TREND: '趋势市', RANGE: '震荡市', PANIC: '恐慌市', NEUTRAL: '中性市' })[r] || r;
}

function handleNotificationsOnFailure(errMsg) {
  notifyState.consecutiveFailures += 1;
  if (
    !notifyState.failureAlerted &&
    notifyState.consecutiveFailures >= NOTIFY.failuresBeforeAlert
  ) {
    notifyState.failureAlerted = true;
    notify(
      '⚠️ Regime 监控连续拉取失败',
      `已连续 ${notifyState.consecutiveFailures} 次从 Binance 拉取数据失败:\n${errMsg}\n` +
        `恢复后将自动通知。`,
      true,
    );
  }
}

// 启动即拉取，并定时刷新
refresh();
setInterval(refresh, REFRESH_MS);

// ---------------------- 路由 ----------------------
router.get('/status', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    updatedAt: cache.updatedAt,
    regime: cache.regime,
    tradePlan: cache.tradePlan,
  });
});

router.get('/data', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    updatedAt: cache.updatedAt,
    regime: cache.regime,
    klines: cache.klines,
    indicators: cache.indicators,
  });
});

// 前端面板专用接口：裁剪到最近 N 根, 字段名按图表习惯压缩
router.get('/snapshot', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  const tail = Math.min(parseInt(req.query.tail, 10) || 168, cache.klines.length);
  const start = cache.klines.length - tail;
  const slice = (a) => a.slice(start);
  const klines = slice(cache.klines);
  const ind = cache.indicators;
  const last = klines.length - 1;
  const lastFullIdx = cache.klines.length - 1;

  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    refreshMs: REFRESH_MS,
    updatedAt: cache.updatedAt,
    error: cache.error,
    regime: cache.regime,
    tradePlan: cache.tradePlan,
    latest: {
      time: klines[last]?.time,
      close: klines[last]?.close,
      atr: ind.atr[lastFullIdx],
      adx: ind.adx[lastFullIdx],
      plusDI: ind.plusDI[lastFullIdx],
      minusDI: ind.minusDI[lastFullIdx],
      hv: ind.hv[lastFullIdx],
      roc: ind.roc[lastFullIdx],
      slope: ind.slope[lastFullIdx],
    },
    candles: klines.map((k) => ({
      t: k.time, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
    })),
    series: {
      atr: slice(ind.atr),
      adx: slice(ind.adx),
      plusDI: slice(ind.plusDI),
      minusDI: slice(ind.minusDI),
      hv: slice(ind.hv),
      roc: slice(ind.roc),
      slope: slice(ind.slope),
    },
  });
});

// 手动触发刷新（调试用）
router.post('/refresh', async (req, res) => {
  await refresh();
  res.json({ ok: !cache.error, error: cache.error, updatedAt: cache.updatedAt });
});

// 静态页面：访问 /api/regime/page 即可看到 Chart.js 面板
router.get('/page', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'regime.html'));
});

module.exports = { router, setNotifier };