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
const fs = require('fs');

const { computeMACD, computeRSI, detectMacdCross, classifyRSI } = require('./indicators/macdRsi');
const { enhance: enhanceRegime, SUB_LABELS } = require('./regime/enhancedJudge');
const webhook = require('./notifier/feishuWebhook');
const tg = require('./notifier/telegram'); // ← 新增：Telegram VIP 群推送（独立通道）

const router = express.Router();

// 前端图表尾部切片：近 50 根
const CHART_TAIL = 50;

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
// notifier 签名: (title, body, opts)
//   opts.rich: Array<Array<Segment>>  富文本行（每行段数组），Segment={ text, bold?, italic? }
//   opts.isAlert: 旧式 alert（退化为 text/post 简单格式）
let notifier = null;
function setNotifier(fn) {
  if (typeof fn === 'function') notifier = fn;
}
function notifyText(title, text, isAlert = false) {
  if (!NOTIFY.enabled) return;
  if (notifier) {
    try { notifier(title, text, { isAlert }); }
    catch (e) { console.error('[regime] notifier 抛错:', e.message); }
  } else {
    console.log(`[regime/notify] ${isAlert ? '⚠️ ' : ''}${title}\n${text}`);
  }
}
function notifyRich(title, lines) {
  if (!NOTIFY.enabled) return;
  if (notifier) {
    try { notifier(title, null, { rich: lines }); }
    catch (e) { console.error('[regime] notifier(rich) 抛错:', e.message); }
  } else {
    console.log(`[regime/notify-rich] ${title}`);
    lines.forEach(line => console.log('  ' + line.map(s => (s.bold ? `**${s.text}**` : s.text)).join('')));
  }
}

// ---------------------- 资金费率数据注入（可选）----------------------
let fundingProvider = null;
function setFundingProvider(fn) {
  if (typeof fn === 'function') fundingProvider = fn;
}
function safeFunding() {
  if (!fundingProvider) return null;
  try { return fundingProvider(); } catch (e) { return null; }
}

// ---------------------- 通知状态机（含磁盘持久化）----------------------
// 交易动作三态：LONG / NEUTRAL / SHORT
// 相同动作连续不重复推送；进程重启后恢复，避免冗余推送
const notifyState = {
  lastTradeAction: null,   // null / 'LONG' / 'NEUTRAL' / 'SHORT'
  startupSent: false,
  consecutiveFailures: 0,
  failureAlerted: false,
  // 新增：Webhook 信号跟踪（防止同一信号重复推送）
  lastSubRegime: null,     // 上一次增强 Regime 的 subRegime
  lastRsiZone: null,       // 'OVERBOUGHT' / 'OVERSOLD' / 'NEUTRAL'
  lastMacdSide: null,      // 'BULL' / 'BEAR' / 'FLAT'
};

// 配置项: 状态持久化文件路径
const NOTIFY_STATE_FILE = process.env.REGIME_NOTIFY_STATE_PATH
  || path.join(__dirname, 'data', 'regime_notify_state.json');

function loadNotifyState() {
  try {
    const raw = fs.readFileSync(NOTIFY_STATE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && ['LONG', 'NEUTRAL', 'SHORT'].includes(obj.lastTradeAction)) {
      notifyState.lastTradeAction = obj.lastTradeAction;
    }
    if (obj && obj.startupSent === true) {
      notifyState.startupSent = true;
    }
    if (obj && typeof obj.lastSubRegime === 'string') notifyState.lastSubRegime = obj.lastSubRegime;
    if (obj && typeof obj.lastRsiZone === 'string') notifyState.lastRsiZone = obj.lastRsiZone;
    if (obj && typeof obj.lastMacdSide === 'string') notifyState.lastMacdSide = obj.lastMacdSide;
    console.log(`[regime] 通知状态已恢复: lastTradeAction=${notifyState.lastTradeAction}, startupSent=${notifyState.startupSent}, lastSubRegime=${notifyState.lastSubRegime}`);
  } catch (e) { /* 文件不存在则忽略 */ }
}
function saveNotifyState() {
  try {
    const dir = path.dirname(NOTIFY_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NOTIFY_STATE_FILE, JSON.stringify({
      lastTradeAction: notifyState.lastTradeAction,
      startupSent: notifyState.startupSent,
      lastSubRegime: notifyState.lastSubRegime,
      lastRsiZone: notifyState.lastRsiZone,
      lastMacdSide: notifyState.lastMacdSide,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.error('[regime] saveNotifyState 失败:', e.message); }
}
loadNotifyState();

/** 从 tradePlan 派生三态动作 */
function getTradeAction(plan) {
  if (!plan) return null;
  if (plan.ok && plan.direction === 'long')  return 'LONG';
  if (plan.ok && plan.direction === 'short') return 'SHORT';
  return 'NEUTRAL';
}

function regimeEmoji(r) {
  return ({ TREND: '📈', RANGE: '🔁', PANIC: '🚨', NEUTRAL: '➖' })[r] || '🟢';
}
function fmt(n, d = 2) {
  return n == null || !isFinite(n) ? '--' : Number(n).toFixed(d);
}
function fmtPct(n) {
  return n == null || !isFinite(n) ? '--' : (n * 100).toFixed(4) + '%';
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

function _legacy_buildTradePlanText_unused(plan) {
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

    // 新增：MACD(12,26,9) 与 RSI(14)
    const { macd, signal, hist } = computeMACD(c, { fast: 12, slow: 26, signal: 9 });
    const rsi = computeRSI(c, 14);

    const indicators = { atr, adx, plusDI, minusDI, hv, roc, slope, macd, signal, hist, rsi };
    const baseRegime = judgeRegime(indicators);

    // 增强 Regime：融合 MACD/RSI，产出细分状态 + 方向 + 置信度 + 风险提示
    const lastIdx = klines.length - 1;
    const enhanced = enhanceRegime(baseRegime, {
      adx: adx[lastIdx],
      plusDI: plusDI[lastIdx],
      minusDI: minusDI[lastIdx],
      hv: hv[lastIdx],
      macd: macd[lastIdx],
      signal: signal[lastIdx],
      hist: hist[lastIdx],
      rsi: rsi[lastIdx],
      close: c[lastIdx],
      histSeries: hist,
    });

    const tradePlan = buildTradePlan(indicators, enhanced, klines);

    const prevRegime = cache.regime;
    cache = {
      updatedAt: Date.now(),
      klines,
      indicators,
      regime: enhanced,
      tradePlan,
      error: null,
    };
    console.log(
      `[regime] refreshed @ ${new Date().toISOString()} -> ${enhanced.label}/${enhanced.subLabel} ` +
      `(dir=${enhanced.direction}, conf=${enhanced.confidenceLabel}) | plan: ${tradePlan.action}`
    );
    handleNotificationsOnSuccess(prevRegime, enhanced, klines, tradePlan);
    // 关键信号 → 飞书 Webhook（独立于 IM API 通道）
    dispatchWebhookSignals(prevRegime, enhanced, tradePlan, klines);
  } catch (err) {
    cache.error = err.message;
    console.error('[regime] refresh failed:', err.message);
    handleNotificationsOnFailure(err.message);
  }
}

// ---------------------- 富文本消息构造器 ----------------------
function buildPlanRichLines(plan, regime, klines) {
  const lastClose = klines.length ? klines[klines.length - 1].close : null;
  const m = regime?.metrics || {};
  const lines = [];
  lines.push([{ text: '⏰ 推送时间：', bold: true }, { text: new Date().toLocaleString() }]);
  lines.push([{ text: '📊 当前状态：', bold: true }, {
    text: plan.direction === 'long' ? '做多 (LONG)' : '做空 (SHORT)',
    bold: true,
  }]);
  lines.push([{ text: '🎯 当前价：', bold: true }, { text: String(plan.currentPrice) }]);
  lines.push([{ text: '━━━━━ 交易参数 ━━━━━' }]);
  lines.push([{ text: '🚪 入场价：', bold: true }, { text: String(plan.entry), bold: true }, { text: '   (回踩 0.5×ATR)' }]);
  lines.push([{ text: '🛡️ 止损价：', bold: true }, { text: String(plan.stopLoss), bold: true }, { text: `   (-${plan.riskPct}%，1.5×ATR)` }]);
  lines.push([{ text: '🎯 TP1：', bold: true }, { text: String(plan.takeProfits[0].price), bold: true },
    { text: `   (+${plan.takeProfits[0].gainPct}% · 1R · 平 ${plan.takeProfits[0].closePct}%)` }]);
  lines.push([{ text: '🎯 TP2：', bold: true }, { text: String(plan.takeProfits[1].price), bold: true },
    { text: `   (+${plan.takeProfits[1].gainPct}% · 2R · 平 ${plan.takeProfits[1].closePct}%)` }]);
  lines.push([{ text: '🎯 TP3：', bold: true }, { text: String(plan.takeProfits[2].price), bold: true },
    { text: `   (+${plan.takeProfits[2].gainPct}% · 3R · 平 ${plan.takeProfits[2].closePct}%)` }]);
  lines.push([{ text: '💼 仓位建议：', bold: true }, { text: plan.suggestedPositionPct + '%', bold: true }]);
  lines.push([{ text: '🎖️ 置信度：', bold: true }, { text: plan.confidenceLabel, bold: true }]);
  lines.push([{ text: '━━━━━ 指标依据 ━━━━━' }]);
  lines.push([{ text: '判定依据：', bold: true }, { text: plan.basis }]);
  const em = regime.enhancedMetrics || {};
  const subTag = regime.subLabel ? ` / ${regime.subLabel}` : '';
  lines.push([{ text: `Regime: ${regime.label}${subTag} · ADX: ${fmt(m.adx)} · +DI/-DI: ${fmt(m.plusDI)}/${fmt(m.minusDI)}` }]);
  lines.push([{ text: `HV: ${fmt(m.hv)}% · ATR: ${fmt(plan.riskPerUnit / 1.5)} · Close: ${fmt(lastClose)}` }]);
  lines.push([{ text: `MACD: DIF ${fmt(em.macd)} / DEA ${fmt(em.signal)} / HIST ${fmt(em.hist)} · RSI(14): ${fmt(em.rsi)}` }]);
  if (regime.riskNote) lines.push([{ text: '⚠️ ' + regime.riskNote, italic: true }]);
  lines.push([{ text: '⚠️ 仅作建议，系统为纯盯盘模式不会自动下单', italic: true }]);
  return lines;
}

function buildNeutralRichLines(prevAction, regime, klines) {
  const lastClose = klines.length ? klines[klines.length - 1].close : null;
  const fromLabel = prevAction === 'LONG' ? '做多' : prevAction === 'SHORT' ? '做空' : '—';
  const hint = prevAction === 'LONG' ? '做多信号已结束，当前转为观望状态'
             : prevAction === 'SHORT' ? '做空信号已结束，当前转为观望状态'
             : '当前无明确交易信号';
  return [
    [{ text: '⏰ 推送时间：', bold: true }, { text: new Date().toLocaleString() }],
    [{ text: '📊 当前状态：', bold: true }, { text: '🟡 观望 (NEUTRAL)', bold: true }],
    [{ text: '🔄 状态切换：', bold: true }, { text: `${fromLabel} → 观望` }],
    [{ text: '💬 ' }, { text: hint, bold: true }],
    [{ text: '🎯 当前价：', bold: true }, { text: fmt(lastClose) }],
    [{ text: '📊 Regime：', bold: true }, { text: regime?.label || '--' }],
    [{ text: '⚠️ 建议：平掉既有仓位或收紧止损，等待下一次明确信号', italic: true }],
  ];
}

function buildSnapshotRichLines(regime, klines, indicators, tradePlan, fundingData) {
  const lastIdx = klines.length - 1;
  const lastClose = klines[lastIdx]?.close;
  const m = regime?.metrics || {};
  const atr = indicators.atr[lastIdx];
  const adx = indicators.adx[lastIdx];
  const hv = indicators.hv[lastIdx];
  const roc = indicators.roc[lastIdx];
  const slope = indicators.slope[lastIdx];

  const em = regime?.enhancedMetrics || {};
  const subTag = regime?.subLabel ? ` · ${regime.subLabel}` : '';
  const lines = [
    [{ text: '⏰ 推送时间：', bold: true }, { text: new Date().toLocaleString() }],
    [{ text: '📊 当前 Regime：', bold: true }, { text: (regime?.label || '--') + subTag, bold: true },
      { text: `  (${regime?.desc || ''})` }],
    [{ text: '🎯 方向 / 置信度：', bold: true },
      { text: `${dirZh(regime?.direction)} · ${regime?.confidenceLabel || '--'}` }],
    [{ text: '💡 风险提示：', bold: true }, { text: regime?.riskNote || '—' }],
    [{ text: '━━━━━ 技术指标 ━━━━━' }],
    [{ text: '💰 最新价格：', bold: true }, { text: fmt(lastClose) }],
    [{ text: '📏 ATR(14)：', bold: true }, { text: fmt(atr) }],
    [{ text: '💪 ADX(14)：', bold: true }, { text: fmt(adx) }, { text: `   +DI/-DI: ${fmt(m.plusDI)}/${fmt(m.minusDI)}` }],
    [{ text: '🌡️ HV(年化)：', bold: true }, { text: fmt(hv) + '%' }, { text: `   分位带 [${fmt(m.hvLow)}%, ${fmt(m.hvHigh)}%]` }],
    [{ text: '⚡ ROC(14)：', bold: true }, { text: fmt(roc) + '%' }],
    [{ text: '📐 Slope：', bold: true }, { text: fmt(slope) + ' $/h' }],
    [{ text: '📶 MACD：', bold: true },
      { text: `DIF ${fmt(em.macd)} · DEA ${fmt(em.signal)} · HIST ${fmt(em.hist)}` }],
    [{ text: '🧭 RSI(14)：', bold: true }, { text: fmt(em.rsi) }],
  ];

  // 资金费率数据（若 server.js 注入了 fundingProvider）
  if (fundingData) {
    const fp = fundingData;
    const dirLabel = ({
      long_crowded: '多头拥挤',
      short_crowded: '空头拥挤',
      neutral: '中性',
      warming_up: '暖机中',
    })[fp.rate1hDirection] || fp.rate1hDirection || '--';
    lines.push([{ text: '━━━━━ 资金费率 ━━━━━' }]);
    lines.push([{ text: '📈 近 1H 均值：', bold: true }, { text: fp.fmtPct ? fp.fmtPct(fp.rate1hAvg) : fmtPct(fp.rate1hAvg) },
      { text: `   (情绪: ${dirLabel})` }]);
    lines.push([{ text: '💵 瞬时预测：', bold: true }, { text: fp.fmtPct ? fp.fmtPct(fp.predictedFundingRate) : fmtPct(fp.predictedFundingRate) }]);
    lines.push([{ text: '💵 上期已结算：', bold: true }, { text: fp.fmtPct ? fp.fmtPct(fp.lastSettledFundingRate) : fmtPct(fp.lastSettledFundingRate) }]);
  }

  // 交易计划参数
  lines.push([{ text: '━━━━━ 交易计划 ━━━━━' }]);
  if (tradePlan && tradePlan.ok) {
    lines.push([{ text: '🎬 动作：', bold: true }, {
      text: tradePlan.direction === 'long' ? '做多 (LONG)' : '做空 (SHORT)', bold: true
    }]);
    lines.push([{ text: '🚪 入场价：', bold: true }, { text: String(tradePlan.entry), bold: true }]);
    lines.push([{ text: '🛡️ 止损价：', bold: true }, { text: String(tradePlan.stopLoss), bold: true },
      { text: `   (-${tradePlan.riskPct}%)` }]);
    lines.push([{ text: '🎯 TP1：', bold: true }, { text: String(tradePlan.takeProfits[0].price), bold: true },
      { text: `   +${tradePlan.takeProfits[0].gainPct}% · 平 ${tradePlan.takeProfits[0].closePct}%` }]);
    lines.push([{ text: '🎯 TP2：', bold: true }, { text: String(tradePlan.takeProfits[1].price), bold: true },
      { text: `   +${tradePlan.takeProfits[1].gainPct}% · 平 ${tradePlan.takeProfits[1].closePct}%` }]);
    lines.push([{ text: '🎯 TP3：', bold: true }, { text: String(tradePlan.takeProfits[2].price), bold: true },
      { text: `   +${tradePlan.takeProfits[2].gainPct}% · 平 ${tradePlan.takeProfits[2].closePct}%` }]);
    lines.push([{ text: '💼 仓位建议：', bold: true }, { text: tradePlan.suggestedPositionPct + '%', bold: true }]);
    lines.push([{ text: '🎖️ 置信度：', bold: true }, { text: tradePlan.confidenceLabel, bold: true }]);
  } else {
    lines.push([{ text: '🎬 动作：', bold: true }, { text: '🟡 观望 (NEUTRAL)', bold: true }]);
    lines.push([{ text: '原因：', bold: true }, { text: tradePlan?.reason || '信号不足' }]);
  }
  return lines;
}

// ---------------------- 飞书 Webhook 关键信号推送 ----------------------
/**
 * 三类事件都会尝试推送（各自独立冷却）：
 *   1) regimeChange  - subRegime 变化（如 RANGE_NEUTRAL → STRONG_BULL）
 *   2) macdCross     - MACD 金叉 / 死叉
 *   3) rsiZone       - RSI 进入/离开超买超卖区
 * 启动第一轮不推送（避免冷启动噪音），只初始化 lastXxx 状态。
 */
function dispatchWebhookSignals(prevRegime, curRegime, tradePlan, klines) {
  const sig = curRegime.signals || {};
  const em = curRegime.enhancedMetrics || {};
  const lastClose = klines.length ? klines[klines.length - 1].close : null;

  // 首轮：初始化 baseline，不推送
  const isBootstrap = notifyState.lastSubRegime === null;
  if (isBootstrap) {
    notifyState.lastSubRegime = curRegime.subRegime;
    notifyState.lastRsiZone = sig.rsiZone || null;
    notifyState.lastMacdSide = sig.macdSide || null;
    saveNotifyState();
    return;
  }

  // 1) Regime 切换
  if (curRegime.subRegime !== notifyState.lastSubRegime) {
    const fromLabel = SUB_LABELS[notifyState.lastSubRegime] || notifyState.lastSubRegime;
    const toLabel = curRegime.subLabel;
    webhook.sendRich(
      `🔔 Regime 切换：${fromLabel} → ${toLabel}`,
      buildWebhookRegimeLines(prevRegime, curRegime, tradePlan, lastClose),
      { eventKey: 'regimeChange' }
    );
    notifyState.lastSubRegime = curRegime.subRegime;
    saveNotifyState();
  }

  // 2) MACD 金叉 / 死叉（基于 signals.macdCross，本轮才新发生）
  if (sig.macdCross === 'GOLDEN' || sig.macdCross === 'DEATH') {
    const isGolden = sig.macdCross === 'GOLDEN';
    webhook.sendRich(
      isGolden ? '📈 MACD 金叉' : '📉 MACD 死叉',
      buildWebhookMacdLines(curRegime, tradePlan, lastClose, isGolden),
      { eventKey: `macdCross_${sig.macdCross}` }
    );
  }
  if (sig.macdSide && sig.macdSide !== notifyState.lastMacdSide) {
    notifyState.lastMacdSide = sig.macdSide;
    saveNotifyState();
  }

  // 3) RSI 区间变化（只在进入超买/超卖区时推送，离开→中性不单独发）
  const curZone = sig.rsiZone;
  if (curZone && curZone !== notifyState.lastRsiZone) {
    if (curZone === 'OVERBOUGHT' || curZone === 'OVERSOLD') {
      webhook.sendRich(
        curZone === 'OVERBOUGHT' ? '⚠️ RSI 进入超买区' : '⚠️ RSI 进入超卖区',
        buildWebhookRsiLines(curRegime, tradePlan, lastClose, curZone),
        { eventKey: `rsiZone_${curZone}` }
      );
    }
    notifyState.lastRsiZone = curZone;
    saveNotifyState();
  }
}

function buildWebhookRegimeLines(prevRegime, cur, plan, lastClose) {
  const em = cur.enhancedMetrics || {};
  const m = cur.metrics || {};
  const lines = [
    [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
    [{ text: '📊 Regime：', bold: true }, { text: `${cur.label} / ${cur.subLabel}`, bold: true }],
    [{ text: '🎯 方向：', bold: true }, { text: dirZh(cur.direction), bold: true },
      { text: `  · 置信度 ${cur.confidenceLabel}` }],
    [{ text: '💰 当前价：', bold: true }, { text: fmt(lastClose) }],
    [{ text: '━━━━━ 指标 ━━━━━' }],
    [{ text: `ADX=${fmt(m.adx)}  +DI=${fmt(m.plusDI)}  -DI=${fmt(m.minusDI)}` }],
    [{ text: `MACD=${fmt(em.macd)}  Signal=${fmt(em.signal)}  Hist=${fmt(em.hist)}` }],
    [{ text: `RSI(14)=${fmt(em.rsi)}  HV=${fmt(m.hv)}%` }],
    [{ text: '💡 风险提示：', bold: true }, { text: cur.riskNote || '—' }],
  ];
  if (plan && plan.ok) {
    lines.push([{ text: '━━━━━ 交易建议 ━━━━━' }]);
    lines.push([{ text: '动作：', bold: true }, { text: plan.action, bold: true },
      { text: `   仓位 ${plan.suggestedPositionPct}%` }]);
    lines.push([{ text: `入场 ${plan.entry} / 止损 ${plan.stopLoss} / TP1 ${plan.takeProfits[0].price}` }]);
  } else if (plan) {
    lines.push([{ text: '🟡 观望：', bold: true }, { text: plan.reason || '—' }]);
  }
  return lines;
}

function buildWebhookMacdLines(cur, plan, lastClose, isGolden) {
  const em = cur.enhancedMetrics || {};
  const m = cur.metrics || {};
  const hint = isGolden
    ? '多头动能启动；若同时处于趋势市可顺势加仓，震荡市需警惕假突破'
    : '空头动能启动；若同时处于趋势市可顺势做空，震荡市需警惕假跌破';
  return [
    [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
    [{ text: '📊 当前 Regime：', bold: true }, { text: `${cur.label} / ${cur.subLabel}` }],
    [{ text: '💰 当前价：', bold: true }, { text: fmt(lastClose) }],
    [{ text: `MACD=${fmt(em.macd)}  Signal=${fmt(em.signal)}  Hist=${fmt(em.hist)}` }],
    [{ text: `辅助：ADX=${fmt(m.adx)}  RSI=${fmt(em.rsi)}` }],
    [{ text: '💡 解读：', bold: true }, { text: hint }],
    (plan && plan.ok)
      ? [{ text: '建议：', bold: true }, { text: `${plan.action} / 入场 ${plan.entry} / 止损 ${plan.stopLoss}` }]
      : [{ text: '建议：', bold: true }, { text: plan?.reason || '观望' }],
  ];
}

function buildWebhookRsiLines(cur, plan, lastClose, zone) {
  const em = cur.enhancedMetrics || {};
  const m = cur.metrics || {};
  const isOB = zone === 'OVERBOUGHT';
  const hint = isOB
    ? 'RSI 进入超买（≥70）：短线追多风险偏高，趋势市可收紧止盈，震荡市可轻仓反手'
    : 'RSI 进入超卖（≤30）：短线追空风险偏高，趋势市可收紧止盈，震荡市可轻仓反手';
  return [
    [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
    [{ text: '📊 当前 Regime：', bold: true }, { text: `${cur.label} / ${cur.subLabel}` }],
    [{ text: '💰 当前价：', bold: true }, { text: fmt(lastClose) }],
    [{ text: `RSI(14)=${fmt(em.rsi)}  MACD=${fmt(em.macd)}  ADX=${fmt(m.adx)}` }],
    [{ text: '💡 解读：', bold: true }, { text: hint }],
  ];
}

function dirZh(d) {
  return ({ long: '做多 (LONG)', short: '做空 (SHORT)', neutral: '中性 / 观望' })[d] || '—';
}

// ---------------------- 通知触发（状态机）----------------------
function handleNotificationsOnSuccess(prevRegime, currentRegime, klines, tradePlan) {
  // 1) 失败恢复
  if (notifyState.failureAlerted) {
    notifyRich('✅ Regime 监控已恢复', [
      [{ text: '⏰ 恢复时间：', bold: true }, { text: new Date().toLocaleString() }],
      [{ text: '状态：', bold: true }, { text: `连续失败 ${notifyState.consecutiveFailures} 次后已恢复正常` }],
      [{ text: '当前 Regime：', bold: true }, { text: currentRegime.label }],
    ]);
    notifyState.failureAlerted = false;
  }
  notifyState.consecutiveFailures = 0;

  // 2) 启动首次成功：不再单独发消息（由 server.js 启动监听时统一发简洁启动通知）
  //    但需初始化 startupSent + lastTradeAction 状态, 以便后续正确比对
  const action = getTradeAction(tradePlan);
  if (!notifyState.startupSent) {
    notifyState.startupSent = true;
    notifyState.lastTradeAction = action;
    saveNotifyState();
    return;
  }

  // 3) 交易动作状态切换（核心）
  if (action && action !== notifyState.lastTradeAction) {
    const prev = notifyState.lastTradeAction;
    if (action === 'LONG') {
      notifyRich('📈 交易信号：转为做多 (LONG)', buildPlanRichLines(tradePlan, currentRegime, klines));
      // ↓ 新增：Telegram VIP 群推送（异步、不阻塞、失败仅打日志）
      tg.fireAndForget(tg.sendTradeSignal(tradePlan, currentRegime, { eventType: 'OPEN' }));
    } else if (action === 'SHORT') {
      notifyRich('📉 交易信号：转为做空 (SHORT)', buildPlanRichLines(tradePlan, currentRegime, klines));
      tg.fireAndForget(tg.sendTradeSignal(tradePlan, currentRegime, { eventType: 'OPEN' }));
    } else if (action === 'NEUTRAL') {
      const title = prev === 'LONG'
        ? '🟡 交易信号：做多结束 → 观望'
        : prev === 'SHORT'
          ? '🟡 交易信号：做空结束 → 观望'
          : '🟡 交易信号：观望';
      notifyRich(title, buildNeutralRichLines(prev, currentRegime, klines));
      tg.fireAndForget(tg.sendTradeSignal(tradePlan, currentRegime, { eventType: 'CLOSE' }));
    }
    notifyState.lastTradeAction = action;
    saveNotifyState();
  }
}

function handleNotificationsOnFailure(errMsg) {
  notifyState.consecutiveFailures += 1;
  if (
    !notifyState.failureAlerted &&
    notifyState.consecutiveFailures >= NOTIFY.failuresBeforeAlert
  ) {
    notifyState.failureAlerted = true;
    notifyRich('⚠️ Regime 监控连续拉取失败', [
      [{ text: '⏰ 告警时间：', bold: true }, { text: new Date().toLocaleString() }],
      [{ text: '失败次数：', bold: true }, { text: String(notifyState.consecutiveFailures) }],
      [{ text: '错误信息：', bold: true }, { text: errMsg || '--' }],
      [{ text: '说明：', bold: true }, { text: '恢复后将自动通知' }],
    ]);
  }
}

// ---------------------- 手动刷新强制推送 ----------------------
/** 无视状态机直接推送【手动刷新 · 市场快照】完整信息 */
function notifyManualRefresh() {
  if (!cache.indicators || !cache.regime) {
    notifyText('【手动刷新 · 市场快照】', '数据尚未就绪，无法推送快照。');
    return;
  }
  const fundingData = safeFunding();
  notifyRich('【手动刷新 · 市场快照】',
    buildSnapshotRichLines(cache.regime, cache.klines, cache.indicators, cache.tradePlan, fundingData));
  // 同步 lastTradeAction, 避免手动刷后紧接着的自动周期又重发一次切换消息
  notifyState.lastTradeAction = getTradeAction(cache.tradePlan);
  saveNotifyState();
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
      // 新增：MACD / RSI 最新值
      macd: ind.macd?.[lastFullIdx] ?? null,
      signal: ind.signal?.[lastFullIdx] ?? null,
      hist: ind.hist?.[lastFullIdx] ?? null,
      rsi: ind.rsi?.[lastFullIdx] ?? null,
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
      // 新增：完整切片，与 candles 对齐
      macd: slice(ind.macd || []),
      signal: slice(ind.signal || []),
      hist: slice(ind.hist || []),
      rsi: slice(ind.rsi || []),
    },
    // 需求 1.2 / 1.3：独立返回 MACD / RSI 最近 50 个周期的历史数据供图表单独渲染
    macdRsi: buildMacdRsiChartSlice(cache.klines, ind, CHART_TAIL),
  });
});

/**
 * 提取 MACD / RSI 最近 N 个周期，单独返回给前端（满足需求 1.2 / 1.3）
 */
function buildMacdRsiChartSlice(klines, ind, tail = CHART_TAIL) {
  const n = Math.min(tail, klines.length);
  const start = klines.length - n;
  const points = klines.slice(start).map(k => k.time);
  const tailArr = (arr) => (Array.isArray(arr) ? arr.slice(start) : []);
  return {
    tail: n,
    times: points,
    macd: tailArr(ind.macd),
    signal: tailArr(ind.signal),
    hist: tailArr(ind.hist),
    rsi: tailArr(ind.rsi),
  };
}

// Webhook 推送状态查询（便于调试）
router.get('/webhook/status', (req, res) => {
  res.json({ ok: true, status: webhook.getStatus() });
});

// Telegram 推送状态查询（便于调试）
router.get('/telegram/status', (req, res) => {
  res.json({ ok: true, status: tg.getStatus() });
});

// 触发一条 TG 自检消息（POST 防误触发）
router.post('/telegram/ping', async (req, res) => {
  const r = await tg.ping();
  res.json({ ok: r.ok === true, result: r });
});

// 手动触发刷新 —— 同时强制推送【手动刷新 · 市场快照】飞书消息
router.post('/refresh', async (req, res) => {
  await refresh();
  if (!cache.error) notifyManualRefresh();
  res.json({ ok: !cache.error, error: cache.error, updatedAt: cache.updatedAt, pushed: !cache.error });
});

// 静态页面：访问 /api/regime/page 即可看到 Chart.js 面板
router.get('/page', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'regime.html'));
});

module.exports = { router, setNotifier, setFundingProvider };