/**
 * ============================================================
 *  regimeModule.js
 *  宏观市场状态（Regime）独立判定模块
 *  - 拉取 Binance USDT 永续合约 BTCUSDT 1h K线（辅以 15m K线算 RSI/MACD）
 *  - 计算 ATR / ADX / +DI / -DI / HV / ROC / Slope
 *  - 输出 Regime：趋势 / 震荡 / 恐慌 / 中性
 *  - 附加飞书信号：15m RSI 超买超卖；1h/15m「RSI超卖过+MACD金叉过+{5分钟|1分钟}MTF强多」
 *    及反向「RSI超买过+MACD死叉过+{5分钟|1分钟}MTF强空」共振推送（四组独立去重）
 *  - 与原有业务完全解耦：只对外暴露一个 Express Router
 * ============================================================
 */
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const { httpAgent, httpsAgent } = require('./lib/httpAgents');
const { computeMACD, computeRSI, detectMacdCross, classifyRSI } = require('./indicators/macdRsi');
const { enhance: enhanceRegime, SUB_LABELS } = require('./regime/enhancedJudge');
const webhook = require('./notifier/feishuWebhook');
const tg = require('./notifier/telegram'); // ← 新增：Telegram VIP 群推送（独立通道）
const tradeConfig = require('./trading/config'); // 自动交易开关（用于动态文案）
const aiAnalysisRouter = require('./regime/aiAnalysisRouter'); // ← 新增：DeepSeek AI 分析子模块

// 根据当前自动交易开关返回提示文案
function autoTradeNote() {
  return tradeConfig.get().enabled
    ? '✅ 自动交易已开启，系统将按本计划自动执行 TP/SL'
    : '⚠️ 自动交易未开启，本建议价位仅作参考';
}

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

// 15 分钟辅助周期 + 多周期共振信号配置
//   - 15m RSI 超买/超卖 → 飞书（边沿去重）
//   - 「RSI超卖过 + MACD金叉过 + {5分钟|1分钟}MTF强多」共振（1h/15m × 5m/1m 四组）→ 飞书
//   「xx过」= 最近 N 根 K 线内曾经发生（含当根），N 可通过环境变量调整
const INTERVAL_15M = '15m';
const COMBO = {
  lookback1h: Math.max(1, parseInt(process.env.REGIME_COMBO_LOOKBACK_1H, 10) || 6),    // 1h 回溯 6 根 ≈ 6 小时
  lookback15m: Math.max(1, parseInt(process.env.REGIME_COMBO_LOOKBACK_15M, 10) || 8),  // 15m 回溯 8 根 ≈ 2 小时
  rsiOverbought: 70,
  rsiOversold: 30,
  mtfMaxAgeMs: 10 * 60 * 1000, // MTF 数据超过 10 分钟未刷新视为不可用
};

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
  m15: null,   // 15 分钟辅助指标 { rsi, macd, signal, hist, lastClose, lastTime }
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
  // 15 分钟 RSI 区间 / MACD 零轴侧 + 多周期共振信号状态（首次为 null 表示未建基线）
  lastRsi15Zone: null,     // 'OVERBOUGHT' / 'OVERSOLD' / 'NEUTRAL'
  lastMacd15Side: null,    // 'BULL' / 'BEAR'（hist 零轴侧，切换即金叉/死叉）
  lastCombo1h: null,       // 'BULL' / 'BEAR' / 'NONE'（1h 指标 + 5分钟 MTF）
  lastCombo15m: null,      // 'BULL' / 'BEAR' / 'NONE'（15m 指标 + 5分钟 MTF）
  lastCombo1hMtf1: null,   // 'BULL' / 'BEAR' / 'NONE'（1h 指标 + 1分钟 MTF）
  lastCombo15mMtf1: null,  // 'BULL' / 'BEAR' / 'NONE'（15m 指标 + 1分钟 MTF）
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
    if (obj && typeof obj.lastRsi15Zone === 'string') notifyState.lastRsi15Zone = obj.lastRsi15Zone;
    if (obj && typeof obj.lastMacd15Side === 'string') notifyState.lastMacd15Side = obj.lastMacd15Side;
    if (obj && typeof obj.lastCombo1h === 'string') notifyState.lastCombo1h = obj.lastCombo1h;
    if (obj && typeof obj.lastCombo15m === 'string') notifyState.lastCombo15m = obj.lastCombo15m;
    if (obj && typeof obj.lastCombo1hMtf1 === 'string') notifyState.lastCombo1hMtf1 = obj.lastCombo1hMtf1;
    if (obj && typeof obj.lastCombo15mMtf1 === 'string') notifyState.lastCombo15mMtf1 = obj.lastCombo15mMtf1;
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
      lastRsi15Zone: notifyState.lastRsi15Zone,
      lastMacd15Side: notifyState.lastMacd15Side,
      lastCombo1h: notifyState.lastCombo1h,
      lastCombo15m: notifyState.lastCombo15m,
      lastCombo1hMtf1: notifyState.lastCombo1hMtf1,
      lastCombo15mMtf1: notifyState.lastCombo15mMtf1,
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

  // 方向 + 置信度 (直接使用 enhancedRegime 的分析结果，避免前后矛盾)
  const direction = regime.direction;
  const confidence = regime.confidence;
  const basis = regime.riskNote || `基于 ${regime.subLabel} 状态`;

  if (!direction || direction === 'neutral') {
    return {
      ok: false, action: 'wait',
      reason: regime.riskNote || '当前状态无明确方向，建议观望',
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

  // 仓位建议: 一律按置信度小仓位 (高 3% / 中 2% / 低 1%), 不再用 50% 默认.
  //   100x 杠杆下 50% 仓位 = 必爆仓级别, 全局去掉; 自动/手动/热力图所有路径统一这套.
  const positionPct = ({ high: 3, medium: 2, low: 1 })[confidence] || 1;

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
      autoTradeNote(),
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
async function fetchKlines(interval = INTERVAL, limit = LIMIT) {
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: SYMBOL, interval, limit },
    timeout: TIMEOUT,
    httpAgent, httpsAgent,
  });
  return data.map(k => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

/** 计算 15 分钟辅助指标（拉取失败时返回 null，不影响 1h 主流程） */
function compute15mIndicators(klines15) {
  if (!Array.isArray(klines15) || !klines15.length) return null;
  const c15 = klines15.map(k => k.close);
  const { macd, signal, hist } = computeMACD(c15, { fast: 12, slow: 26, signal: 9 });
  const rsi = computeRSI(c15, 14);
  return {
    rsi, macd, signal, hist,
    times: klines15.map(k => k.time),
    lastClose: c15[c15.length - 1],
    lastTime: klines15[klines15.length - 1].time,
  };
}

// 重入守卫: 防止上一轮 refresh 还没回(币安 fapi 慢响应), setInterval
// 5min 又触发新一轮 → klines/indicators 在堆里堆积 → GC 风暴 → CPU 100%.
// 这是排查时定位的 P1 元凶之一.
let _isRefreshing = false;
let _lastRefreshStartedAt = 0;

async function refresh() {
  if (_isRefreshing) {
    const ageSec = Math.round((Date.now() - _lastRefreshStartedAt) / 1000);
    console.warn(`[regime] 上一轮 refresh 还在跑 (${ageSec}s), 跳过本轮以防堆积`);
    return;
  }
  _isRefreshing = true;
  _lastRefreshStartedAt = Date.now();
  try {
    // 1h 主周期 + 15m 辅助周期并行拉取；15m 失败只降级（不影响 1h 主流程）
    const [klines, klines15] = await Promise.all([
      fetchKlines(INTERVAL, LIMIT),
      fetchKlines(INTERVAL_15M, LIMIT).catch(e => {
        console.error('[regime] 15m K线拉取失败(本轮跳过 15m 信号):', e.message);
        return null;
      }),
    ]);
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

    // 15 分钟辅助指标（RSI / MACD）
    const m15 = compute15mIndicators(klines15);

    const prevRegime = cache.regime;
    cache = {
      updatedAt: Date.now(),
      klines,
      indicators,
      regime: enhanced,
      tradePlan,
      m15,
      error: null,
    };
    console.log(
      `[regime] refreshed @ ${new Date().toISOString()} -> ${enhanced.label}/${enhanced.subLabel} ` +
      `(dir=${enhanced.direction}, conf=${enhanced.confidenceLabel}) | plan: ${tradePlan.action}`
    );
    handleNotificationsOnSuccess(prevRegime, enhanced, klines, tradePlan);
    // 关键信号 → 飞书 Webhook（独立于 IM API 通道）
    dispatchWebhookSignals(prevRegime, enhanced, tradePlan, klines);
    // 15m RSI 超买/超卖 + MACD 金叉/死叉 → 飞书（异常隔离，不影响主流程）
    try { dispatch15mSignals(m15); }
    catch (e) { console.error('[regime] 15m 信号检测异常:', e?.message || e); }
    // 多周期共振信号（1h / 15m 的 RSI+MACD 回溯 × 5分钟/1分钟 MTF强多/强空）→ 飞书
    try { dispatchComboSignals(indicators, m15, c[c.length - 1]); }
    catch (e) { console.error('[regime] 共振信号检测异常:', e?.message || e); }
  } catch (err) {
    cache.error = err.message;
    console.error('[regime] refresh failed:', err.message);
    handleNotificationsOnFailure(err.message);
  } finally {
    _isRefreshing = false;
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
    { text: `   +${plan.takeProfits[0].gainPct}% · 1R · 平 ${plan.takeProfits[0].closePct}%` }]);
  lines.push([{ text: '🎯 TP2：', bold: true }, { text: String(plan.takeProfits[1].price), bold: true },
    { text: `   +${plan.takeProfits[1].gainPct}% · 2R · 平 ${plan.takeProfits[1].closePct}%` }]);
  lines.push([{ text: '🎯 TP3：', bold: true }, { text: String(plan.takeProfits[2].price), bold: true },
    { text: `   +${plan.takeProfits[2].gainPct}% · 3R · 平 ${plan.takeProfits[2].closePct}%` }]);
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
  lines.push([{ text: autoTradeNote(), italic: true }]);
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
    if (fp.rateDailyWithPredict !== undefined) {
      lines.push([{ text: '📅 今日累计含预测：', bold: true }, { text: fp.fmtPct ? fp.fmtPct(fp.rateDailyWithPredict) : fmtPct(fp.rateDailyWithPredict) }]);
    }
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
      { text: `   +${tradePlan.takeProfits[0].gainPct}% · 1R · 平 ${tradePlan.takeProfits[0].closePct}%` }]);
    lines.push([{ text: '🎯 TP2：', bold: true }, { text: String(tradePlan.takeProfits[1].price), bold: true },
      { text: `   +${tradePlan.takeProfits[1].gainPct}% · 2R · 平 ${tradePlan.takeProfits[1].closePct}%` }]);
    lines.push([{ text: '🎯 TP3：', bold: true }, { text: String(tradePlan.takeProfits[2].price), bold: true },
      { text: `   +${tradePlan.takeProfits[2].gainPct}% · 3R · 平 ${tradePlan.takeProfits[2].closePct}%` }]);
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
    // 自动取消反向挂单:
    //   - MACD 金叉 (看多反转) → 取消空头 pending  (cancelPendingByReverseSignal('macd_cross', 'long', ...))
    //   - MACD 死叉 (看空反转) → 取消多头 pending  (cancelPendingByReverseSignal('macd_cross', 'short', ...))
    cancelReversePendingSafely('macd_cross', isGolden ? 'long' : 'short', isGolden ? 'GOLDEN' : 'DEATH');
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
      // 自动取消反向挂单:
      //   - RSI 超买 (看空预警) → 取消多头 pending
      //   - RSI 超卖 (看多预警) → 取消空头 pending
      cancelReversePendingSafely('rsi_zone', curZone === 'OVERBOUGHT' ? 'short' : 'long', curZone);
    }
    notifyState.lastRsiZone = curZone;
    saveNotifyState();
  }
}

/**
 * 包装一层异常隔离 — 取消挂单失败 (trading/router 不可用 / state 落盘失败) 不能影响
 * regime 主流程, 否则 dispatchWebhookSignals 会卡住, regime 状态持久化也跟着挂.
 *
 * @param {string} kind          'macd_cross' | 'rsi_zone'
 * @param {'long'|'short'} dir   反向信号方向 (参见 cancelPendingByReverseSignal 注释)
 * @param {string} label         具体信号 ('GOLDEN' / 'DEATH' / 'OVERBOUGHT' / 'OVERSOLD')
 */
function cancelReversePendingSafely(kind, dir, label) {
  try {
    const { cancelPendingByReverseSignal } = require('./trading/router');
    if (typeof cancelPendingByReverseSignal !== 'function') return;
    const r = cancelPendingByReverseSignal(kind, dir, { label });
    if (r.cancelled) {
      console.log(`[regime→trade] 🛑 反向信号 ${kind}=${label} 取消 ${r.cancelled} pending: ${r.reason}`);
    }
  } catch (e) {
    console.error(`[regime→trade] cancelReversePendingSafely 异常 (${kind}/${dir}/${label}):`, e?.message || e);
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
    lines.push([{ text: `入场 ${plan.entry} / 止损 ${plan.stopLoss}` }]);
    lines.push([{ text: `TP1 ${plan.takeProfits[0].price} (1R) / TP2 ${plan.takeProfits[1].price} (2R) / TP3 ${plan.takeProfits[2].price} (3R)` }]);
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

// ---------------------- 15m RSI 信号 + 多周期共振信号 ----------------------

/** RSI 最近 lookback 根内（含当根）是否触碰过超卖/超买区 */
function rsiTouchedWithin(rsiSeries, zone, lookback) {
  if (!Array.isArray(rsiSeries) || !rsiSeries.length) return false;
  const n = rsiSeries.length;
  for (let i = Math.max(0, n - lookback); i < n; i++) {
    const v = rsiSeries[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (zone === 'OVERSOLD' && v <= COMBO.rsiOversold) return true;
    if (zone === 'OVERBOUGHT' && v >= COMBO.rsiOverbought) return true;
  }
  return false;
}

/** MACD hist 最近 lookback 根内（含当根）是否出现过金叉/死叉 */
function macdCrossedWithin(histSeries, type, lookback) {
  if (!Array.isArray(histSeries) || histSeries.length < 2) return false;
  const n = histSeries.length;
  for (let i = Math.max(1, n - lookback); i < n; i++) {
    const prev = histSeries[i - 1];
    const cur = histSeries[i];
    if (prev == null || cur == null) continue;
    if (type === 'GOLDEN' && prev <= 0 && cur > 0) return true;
    if (type === 'DEATH' && prev >= 0 && cur < 0) return true;
  }
  return false;
}

/**
 * 读取 MTF 模块指定周期（'5' / '1' 等）的最新评分行（强多/强空来自 mtfModule.scoreTimeframe）。
 * 懒加载 require，且数据超过 mtfMaxAgeMs 未刷新视为不可用，返回 null。
 */
function getMtfRow(tfKey) {
  try {
    const mtf = require('./mtfModule');
    if (typeof mtf.getTimeframe !== 'function') return null;
    const updatedAt = typeof mtf.getUpdatedAt === 'function' ? mtf.getUpdatedAt() : null;
    if (!updatedAt || Date.now() - updatedAt > COMBO.mtfMaxAgeMs) return null;
    return mtf.getTimeframe(tfKey);
  } catch (e) {
    console.error(`[regime] 读取 MTF ${tfKey}m 状态失败:`, e?.message || e);
    return null;
  }
}

/**
 * 15 分钟信号 → 飞书（RSI 超买/超卖 + MACD 金叉/死叉）
 *   - RSI：与 1h 同款边沿逻辑，只在“进入”超买/超卖区时推送一次，离开→中性不推
 *   - MACD：跟踪 hist 零轴侧（BULL/BEAR），侧翻转即金叉/死叉；
 *     用状态机而非 detectMacdCross 是因为 regime 5min 刷新 < 15m 出K节奏，
 *     纯边沿检测会在同一根交叉 K 线上重复命中
 * 状态持久化到 notifyState，首轮只建基线不推送。
 */
function dispatch15mSignals(m15) {
  if (!m15 || !Array.isArray(m15.rsi) || !m15.rsi.length) return;
  const rsiNow = m15.rsi[m15.rsi.length - 1];
  const histNow = Array.isArray(m15.hist) ? m15.hist[m15.hist.length - 1] : null;

  // ---- 1) RSI 超买 / 超卖 ----
  const zone = classifyRSI(rsiNow, { overbought: COMBO.rsiOverbought, oversold: COMBO.rsiOversold });
  if (zone) {
    if (notifyState.lastRsi15Zone == null) {
      notifyState.lastRsi15Zone = zone;
      saveNotifyState();
    } else if (zone !== notifyState.lastRsi15Zone) {
      notifyState.lastRsi15Zone = zone;
      saveNotifyState();
      if (zone === 'OVERBOUGHT' || zone === 'OVERSOLD') {
        const isOB = zone === 'OVERBOUGHT';
        webhook.sendRich(
          isOB ? '⚠️ 15分钟 RSI 进入超买区' : '⚠️ 15分钟 RSI 进入超卖区',
          [
            [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
            [{ text: '💰 当前价：', bold: true }, { text: fmt(m15.lastClose) }],
            [{ text: `RSI(14,15m)=${fmt(rsiNow)}  MACD HIST(15m)=${fmt(histNow)}` }],
            [{ text: '💡 解读：', bold: true }, {
              text: isOB
                ? `15分钟 RSI ≥${COMBO.rsiOverbought}：短线超买，追多风险偏高，注意回调`
                : `15分钟 RSI ≤${COMBO.rsiOversold}：短线超卖，追空风险偏高，注意反弹`,
            }],
          ],
          { eventKey: `rsi15Zone_${zone}` }
        );
      }
    }
  }

  // ---- 2) MACD 金叉 / 死叉（hist 零轴侧翻转）----
  if (histNow != null && Number.isFinite(histNow) && histNow !== 0) {
    const side = histNow > 0 ? 'BULL' : 'BEAR';
    if (notifyState.lastMacd15Side == null) {
      notifyState.lastMacd15Side = side;
      saveNotifyState();
    } else if (side !== notifyState.lastMacd15Side) {
      notifyState.lastMacd15Side = side;
      saveNotifyState();
      const isGolden = side === 'BULL';
      const dif = Array.isArray(m15.macd) ? m15.macd[m15.macd.length - 1] : null;
      const dea = Array.isArray(m15.signal) ? m15.signal[m15.signal.length - 1] : null;
      webhook.sendRich(
        isGolden ? '📈 15分钟 MACD 金叉' : '📉 15分钟 MACD 死叉',
        [
          [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
          [{ text: '💰 当前价：', bold: true }, { text: fmt(m15.lastClose) }],
          [{ text: `MACD(15m): DIF=${fmt(dif)}  DEA=${fmt(dea)}  HIST=${fmt(histNow)}` }],
          [{ text: `RSI(14,15m)=${fmt(rsiNow)}` }],
          [{ text: '💡 解读：', bold: true }, {
            text: isGolden
              ? '15分钟级别多头动能启动；短线可关注回调做多机会，注意结合大周期方向过滤'
              : '15分钟级别空头动能启动；短线可关注反弹做空机会，注意结合大周期方向过滤',
          }],
        ],
        { eventKey: `macd15Cross_${isGolden ? 'GOLDEN' : 'DEATH'}` }
      );
    }
  }
}

/**
 * 多周期共振信号 → 飞书（指标周期 1h/15m × MTF 周期 5分钟/1分钟，共四组，
 * 指标条件均为“最近 N 根内发生过”）：
 *   1h  RSI 超卖过 + 1h  MACD 金叉过 + {5分钟|1分钟} MTF 强多 → 多头共振
 *   1h  RSI 超买过 + 1h  MACD 死叉过 + {5分钟|1分钟} MTF 强空 → 空头共振
 *   15m RSI 超卖过 + 15m MACD 金叉过 + {5分钟|1分钟} MTF 强多 → 多头共振
 *   15m RSI 超买过 + 15m MACD 死叉过 + {5分钟|1分钟} MTF 强空 → 空头共振
 * 每组独立去重：只在该组共振状态首次成立（NONE/反向 → BULL/BEAR）时推送一次，状态持久化。
 */
const COMBO_MTF_TFS = [
  { mtfKey: '5', mtfLabel: '5分钟', stateSuffix: '', eventSuffix: '' },
  { mtfKey: '1', mtfLabel: '1分钟', stateSuffix: 'Mtf1', eventSuffix: '_mtf1' },
];

function dispatchComboSignals(indicators, m15, lastClose) {
  for (const tf of COMBO_MTF_TFS) {
    const mtfRow = getMtfRow(tf.mtfKey);

    applyComboState(`lastCombo1h${tf.stateSuffix}`, evalCombo(indicators.rsi, indicators.hist, COMBO.lookback1h, mtfRow), {
      tfLabel: '1小时', lookback: COMBO.lookback1h,
      rsiNow: indicators.rsi[indicators.rsi.length - 1],
      histNow: indicators.hist[indicators.hist.length - 1],
      lastClose, mtfRow, mtfLabel: tf.mtfLabel,
      eventPrefix: `combo1h${tf.eventSuffix}`,
    });

    if (m15) {
      applyComboState(`lastCombo15m${tf.stateSuffix}`, evalCombo(m15.rsi, m15.hist, COMBO.lookback15m, mtfRow), {
        tfLabel: '15分钟', lookback: COMBO.lookback15m,
        rsiNow: m15.rsi[m15.rsi.length - 1],
        histNow: m15.hist[m15.hist.length - 1],
        lastClose: m15.lastClose, mtfRow, mtfLabel: tf.mtfLabel,
        eventPrefix: `combo15m${tf.eventSuffix}`,
      });
    }
  }
}

/** 判定单组共振状态：'BULL' / 'BEAR' / 'NONE'（mtfRow 为任一 MTF 周期的评分行） */
function evalCombo(rsiSeries, histSeries, lookback, mtfRow) {
  if (!mtfRow || !mtfRow.state) return 'NONE';
  if (mtfRow.state === '强多'
    && rsiTouchedWithin(rsiSeries, 'OVERSOLD', lookback)
    && macdCrossedWithin(histSeries, 'GOLDEN', lookback)) return 'BULL';
  if (mtfRow.state === '强空'
    && rsiTouchedWithin(rsiSeries, 'OVERBOUGHT', lookback)
    && macdCrossedWithin(histSeries, 'DEATH', lookback)) return 'BEAR';
  return 'NONE';
}

/** 共振状态机：首轮建基线；状态变为 BULL/BEAR 时推送飞书 */
function applyComboState(stateKey, comboState, ctx) {
  const prev = notifyState[stateKey];
  if (prev == null) {
    notifyState[stateKey] = comboState;
    saveNotifyState();
    return;
  }
  if (comboState === prev) return;
  notifyState[stateKey] = comboState;
  saveNotifyState();
  if (comboState !== 'BULL' && comboState !== 'BEAR') return;

  const isBull = comboState === 'BULL';
  const title = isBull
    ? `🚀 ${ctx.tfLabel}多头共振：RSI超卖过 + MACD金叉过 + ${ctx.mtfLabel}MTF强多`
    : `🧨 ${ctx.tfLabel}空头共振：RSI超买过 + MACD死叉过 + ${ctx.mtfLabel}MTF强空`;
  console.log(`[regime] 📣 共振信号 ${ctx.eventPrefix}=${comboState}, 推送飞书`);
  webhook.sendRich(title, buildComboLines(isBull, ctx), { eventKey: `${ctx.eventPrefix}_${comboState}` });
}

function buildComboLines(isBull, ctx) {
  const { tfLabel, lookback, rsiNow, histNow, lastClose, mtfRow, mtfLabel } = ctx;
  const scoreStr = mtfRow && mtfRow.score != null
    ? (mtfRow.score > 0 ? `+${mtfRow.score}` : String(mtfRow.score))
    : '--';
  return [
    [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
    [{ text: '💰 当前价：', bold: true }, { text: fmt(lastClose) }],
    [{ text: '━━━━━ 共振条件 ━━━━━' }],
    [{ text: isBull
      ? `① ${tfLabel} RSI 最近 ${lookback} 根内曾 ≤${COMBO.rsiOversold}（超卖过），当前 RSI=${fmt(rsiNow)}`
      : `① ${tfLabel} RSI 最近 ${lookback} 根内曾 ≥${COMBO.rsiOverbought}（超买过），当前 RSI=${fmt(rsiNow)}` }],
    [{ text: isBull
      ? `② ${tfLabel} MACD 最近 ${lookback} 根内出现金叉，当前 HIST=${fmt(histNow)}`
      : `② ${tfLabel} MACD 最近 ${lookback} 根内出现死叉，当前 HIST=${fmt(histNow)}` }],
    [{ text: `③ ${mtfLabel} MTF 当前「${mtfRow?.state || '--'}」（评分 ${scoreStr} · 操作：${mtfRow?.action || '--'}）` }],
    [{ text: '💡 解读：', bold: true }, { text: isBull
      ? '超卖修复 + 动能转多 + 短周期强多三重共振，可关注顺势做多机会（注意回踩确认）'
      : '超买回落 + 动能转空 + 短周期强空三重共振，可关注顺势做空机会（注意反弹确认）' }],
  ];
}

// ---------------------- MTF 组合条件自动开仓（1分钟边缘触发 + 三重过滤） ----------------------
//
// 用户在 regime 页面「手动开仓」栏拨「组合开多/组合开空」开关武装后：
//   触发边缘：MTF 1分钟评分连续 MTF5_AUTO_OPEN_CONFIRM 个新快照确认「转为」强多/强空
//   触发时刻再验三个过滤条件（全过才下单，任一不满足则跳过并保持武装）：
//     ① 大周期方向：MTF 240分钟 或 60分钟 状态为「强多/偏多」（开空为「强空/偏空」）
//     ② 15分钟 RSI：最近 COMBO.lookback15m 根收盘内出现过超卖（开空为超买过）
//     ③ 1分钟 Delta：最近一根已收盘 1m K 线主动买盘 > 卖盘（绿柱; 开空为红柱）
//   其余机制与旧版一致：
//   - 多/空开关独立武装、独立触发、独立自动关闭
//   - 每 30s 检查（只评估新快照, 按 updatedAt 去重）
//   - 从全关到武装时只记基线不追溯, 避免对着已存在的陈旧强多/强空立刻下单
//   - ⭐ 市价单：下单复用 trading/router.manualFollowImpl（与 UI「一键追单」同一实现：
//     立即市价成交, entry=当前 WS 市价, TP/SL 按 ATR 动态派生, 置信度小仓位）
//   - ⭐ 单次武装：成功开仓后只自动关闭该方向的开关（被拒/过滤不过时保持武装）
//   - 触发后冷却 MTF5_AUTO_OPEN_COOLDOWN_MS（默认 10 分钟, 兜底）
//   - ⭐ 1分钟确认转为强多/强空时, 无论开关是否武装都推飞书
//   - 开关与触发记录持久化到磁盘, 进程重启后保持
const MTF5_AUTO_FILE = process.env.MTF5_AUTO_OPEN_STATE_PATH
  || path.join(__dirname, 'data', 'mtf5_auto_open.json');
const MTF5_AUTO = {
  confirm: Math.max(1, parseInt(process.env.MTF5_AUTO_OPEN_CONFIRM, 10) || 2),
  cooldownMs: Math.max(0, parseInt(process.env.MTF5_AUTO_OPEN_COOLDOWN_MS, 10) || 10 * 60 * 1000),
  checkMs: 30 * 1000,
};
// 周期行为配置：组合逻辑只保留 1分钟作为边缘触发周期（pushStrong = 确认转强多/强空时推飞书）
const MTF_AUTO_TF_CFG = {
  '1': { label: '1分钟', pushStrong: true },
};
function newMtfAutoSlot() {
  return {
    enabledLong: false,   // 强多 → 自动开多
    enabledShort: false,  // 强空 → 自动开空
    lastFiredAt: 0,
    lastFired: null,      // { at, state, score, direction, status, ok, note }
    // 运行时（不持久化）
    _lastSeenMtfAt: 0,
    _lastState: null,
    _pendingState: null,
    _pendingCount: 0,
    _firing: false,
  };
}
const mtfAuto = { '1': newMtfAutoSlot() };
const mtf5Auto = mtfAuto['1'];   // 兼容别名（测试/旧引用; 组合逻辑后仅剩 1分钟槽）
function mtfAutoArmed(slot) { return slot.enabledLong || slot.enabledShort; }

function applyMtfAutoSlot(slot, obj) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.enabledLong === 'boolean') slot.enabledLong = obj.enabledLong;
  if (typeof obj.enabledShort === 'boolean') slot.enabledShort = obj.enabledShort;
  if (Number.isFinite(obj.lastFiredAt)) slot.lastFiredAt = obj.lastFiredAt;
  if (obj.lastFired && typeof obj.lastFired === 'object') slot.lastFired = obj.lastFired;
}
function loadMtf5AutoState() {
  try {
    const obj = JSON.parse(fs.readFileSync(MTF5_AUTO_FILE, 'utf8'));
    if (obj && obj.tfs && typeof obj.tfs === 'object') {
      // tfs 格式：只恢复仍存在的槽（组合逻辑后仅 '1'; 旧文件里的 '5' 槽忽略）
      for (const key of Object.keys(mtfAuto)) applyMtfAutoSlot(mtfAuto[key], obj.tfs[key]);
    }
    // 更早的 v1/v2 单对象格式（旧 5分钟语义）不迁移：触发逻辑已改成组合条件, 静默作废
    for (const key of Object.keys(mtfAuto)) {
      if (mtfAutoArmed(mtfAuto[key])) {
        console.log(`[regime] MTF${key} 自动开仓状态已恢复: long=${mtfAuto[key].enabledLong} short=${mtfAuto[key].enabledShort}`);
      }
    }
  } catch (e) { /* 文件不存在则忽略 */ }
}
function saveMtf5AutoState() {
  try {
    const dir = path.dirname(MTF5_AUTO_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tfs = {};
    for (const key of Object.keys(mtfAuto)) {
      const s = mtfAuto[key];
      tfs[key] = {
        enabledLong: s.enabledLong,
        enabledShort: s.enabledShort,
        lastFiredAt: s.lastFiredAt,
        lastFired: s.lastFired,
      };
    }
    fs.writeFileSync(MTF5_AUTO_FILE, JSON.stringify({ tfs, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.error('[regime] saveMtf5AutoState 失败:', e.message); }
}
loadMtf5AutoState();

// ---- 组合过滤条件 ① 大周期 ② 15m RSI ③ 1m Delta ----

// 最近一根已收盘 1m K 线的主动买卖差 (taker buy − taker sell), 按 K 线开盘时间缓存
let _delta1mCache = { fetchedAt: 0, data: null };
async function fetch1mDelta() {
  const now = Date.now();
  if (_delta1mCache.data && now - _delta1mCache.fetchedAt < 20 * 1000) return _delta1mCache.data;
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: SYMBOL, interval: '1m', limit: 2 },
    timeout: TIMEOUT,
    httpAgent, httpsAgent,
  });
  if (!Array.isArray(data) || data.length < 2) return null;
  const k = data[data.length - 2];              // 最后一根尚未收盘, 取倒数第二根（已收盘）
  const volume = +k[5];
  const takerBuy = +k[9];                        // 主动买量 (taker buy base volume)
  const takerSell = volume - takerBuy;
  const out = {
    time: k[0], close: +k[4], volume,
    takerBuy, takerSell,
    delta: takerBuy - takerSell,                 // >0 = 买盘占优（绿柱） / <0 = 卖盘占优（红柱）
  };
  _delta1mCache = { fetchedAt: now, data: out };
  return out;
}

/**
 * 组合过滤条件评估（1分钟确认转强多/强空后、下单前调用）:
 *   开多: (240m 或 60m ∈ 强多/偏多) + 15m RSI 最近超卖过 + 1m Delta 买盘
 *   开空: (240m 或 60m ∈ 强空/偏空) + 15m RSI 最近超买过 + 1m Delta 卖盘
 * @returns {{pass, htfOk, rsiOk, deltaOk, detail: string[]}}
 */
function evalMtfComboFilters(direction, delta1m) {
  const isLong = direction === 'long';
  const wantStates = isLong ? ['强多', '偏多'] : ['强空', '偏空'];
  const r240 = getMtfRow('240');
  const r60 = getMtfRow('60');
  const htfOk = wantStates.includes(r240?.state) || wantStates.includes(r60?.state);

  const rsiArr = cache?.m15?.rsi;
  const zone = isLong ? 'OVERSOLD' : 'OVERBOUGHT';
  const rsiOk = Array.isArray(rsiArr) && rsiArr.length > 0
    && rsiTouchedWithin(rsiArr, zone, COMBO.lookback15m);
  const rsiNow = Array.isArray(rsiArr) && rsiArr.length ? rsiArr[rsiArr.length - 1] : null;

  const deltaOk = delta1m != null && Number.isFinite(delta1m.delta)
    && (isLong ? delta1m.delta > 0 : delta1m.delta < 0);

  const mk = (ok) => (ok ? '✅' : '❌');
  const detail = [
    `${mk(htfOk)} ① 240m「${r240?.state || '--'}」/ 60m「${r60?.state || '--'}」需含${isLong ? '强多/偏多' : '强空/偏空'}`,
    `${mk(rsiOk)} ② 15m RSI 最近 ${COMBO.lookback15m} 根内${isLong ? '超卖过' : '超买过'} (当前 ${rsiNow != null ? rsiNow.toFixed(1) : '--'})`,
    `${mk(deltaOk)} ③ 1m Delta ${delta1m ? (delta1m.delta >= 0 ? '+' : '') + delta1m.delta.toFixed(3) : '--'} 需为${isLong ? '买盘(绿柱)' : '卖盘(红柱)'}`,
  ];
  return { pass: htfOk && rsiOk && deltaOk, htfOk, rsiOk, deltaOk, detail };
}

/** 单个周期的状态机：基线 → 变化确认 → (可选)强多强空飞书 → (武装时)组合过滤 → 自动开仓 */
async function mtfAutoTickTf(tfKey, mtf) {
  const slot = mtfAuto[tfKey];
  const cfg = MTF_AUTO_TF_CFG[tfKey];
  if (slot._firing) return;
  // 未武装且该周期不需要强多/强空推送时, 无事可做
  if (!mtfAutoArmed(slot) && !cfg.pushStrong) return;

  const updatedAt = mtf.getUpdatedAt();
  if (!updatedAt || updatedAt === slot._lastSeenMtfAt) return; // 只评估新快照
  slot._lastSeenMtfAt = updatedAt;

  const tfRow = mtf.getTimeframe(tfKey);
  if (!tfRow || !tfRow.state) return;
  const cur = tfRow.state;

  // 首个快照：只记基线（含刚开启开关后）
  if (slot._lastState == null) {
    slot._lastState = cur;
    console.log(`[regime] MTF${tfKey} 自动开仓基线: ${cfg.label}=${cur}`);
    return;
  }
  // 状态没变（或抖回原状态）：清待确认
  if (cur === slot._lastState) {
    slot._pendingState = null;
    slot._pendingCount = 0;
    return;
  }
  // 状态变了：累计确认
  if (slot._pendingState === cur) slot._pendingCount += 1;
  else { slot._pendingState = cur; slot._pendingCount = 1; }
  if (slot._pendingCount < MTF5_AUTO.confirm) return;

  const from = slot._lastState;
  slot._lastState = cur;
  slot._pendingState = null;
  slot._pendingCount = 0;
  if (cur !== '强多' && cur !== '强空') return;

  // 强多/强空确认成立：按配置推飞书（与开关是否武装无关）
  if (cfg.pushStrong) pushMtfStrongFeishu(tfKey, cfg.label, from, tfRow);

  // 方向开关独立：只在对应方向武装时评估组合过滤条件并触发交易
  const direction = cur === '强多' ? 'long' : 'short';
  const armed = direction === 'long' ? slot.enabledLong : slot.enabledShort;
  if (!armed) {
    console.log(`[regime] ⏭ MTF${tfKey} 状态确认 ${from} → ${cur}, 但${direction === 'long' ? '多' : '空'}方向开关未武装, 跳过下单`);
    return;
  }

  // ⭐ 组合过滤：① 240m/60m 大周期方向 ② 15m RSI 最近超卖/超买过 ③ 1m Delta 买/卖盘
  let delta1m = null;
  try { delta1m = await fetch1mDelta(); }
  catch (e) { console.error('[regime] 1m Delta 拉取失败:', e?.message || e); }
  const filters = evalMtfComboFilters(direction, delta1m);
  if (!filters.pass) {
    console.log(`[regime] ⏭ MTF${tfKey} 确认转「${cur}」但组合过滤未通过, 保持武装:\n  ${filters.detail.join('\n  ')}`);
    webhook.sendRich(
      `⏭ 组合自动开${direction === 'long' ? '多' : '空'}条件未满足（保持武装）`,
      [
        [{ text: `📊 MTF 1分钟已确认转「${cur}」, 但组合过滤未全部通过:` }],
        ...filters.detail.map((t) => [{ text: t }]),
        [{ text: '开关保持武装, 下次 1分钟再次确认转强时会重新评估', italic: true }],
        [{ text: `⏰ ${new Date().toLocaleString()}` }],
      ],
      { eventKey: `mtfComboSkip_${direction}` }
    );
    return;
  }
  console.log(`[regime] 🤖 MTF${tfKey} 组合自动开仓条件全部成立: ${from} → ${cur}\n  ${filters.detail.join('\n  ')}`);
  await fireMtfAutoOpen(tfKey, direction, tfRow, filters);
}

async function mtfAutoTick() {
  let mtf;
  try { mtf = require('./mtfModule'); } catch (e) { return; }
  if (typeof mtf.getUpdatedAt !== 'function' || typeof mtf.getTimeframe !== 'function') return;
  for (const tfKey of Object.keys(mtfAuto)) {
    try { await mtfAutoTickTf(tfKey, mtf); }
    catch (e) { console.error(`[regime] MTF${tfKey} 自动开仓检测异常:`, e?.message || e); }
  }
}

/** 1分钟(等配置了 pushStrong 的周期)确认转为强多/强空 → 飞书 */
function pushMtfStrongFeishu(tfKey, label, from, tfRow) {
  const isBull = tfRow.state === '强多';
  const scoreStr = tfRow.score > 0 ? `+${tfRow.score}` : String(tfRow.score);
  console.log(`[regime] 📣 MTF ${label} 确认转为${tfRow.state}, 推送飞书`);
  webhook.sendRich(
    `${isBull ? '🟢' : '🔴'} MTF ${label}转为${tfRow.state}`,
    [
      [{ text: `📊 ${SYMBOL} · ${label}周期` }],
      [{ text: `状态: ${from} → ${tfRow.state}（评分 ${scoreStr}）` }],
      [{ text: `操作建议: ${tfRow.action || '--'}` }],
      [{ text: `⏰ ${new Date().toLocaleString()}` }],
    ],
    { eventKey: `mtf${tfKey}Strong_${isBull ? 'BULL' : 'BEAR'}` }
  );
}

async function fireMtfAutoOpen(tfKey, direction, tfRow, filters = null) {
  const slot = mtfAuto[tfKey];
  const label = MTF_AUTO_TF_CFG[tfKey].label;
  const now = Date.now();
  if (now - slot.lastFiredAt < MTF5_AUTO.cooldownMs) {
    const waitS = Math.round((MTF5_AUTO.cooldownMs - (now - slot.lastFiredAt)) / 1000);
    console.log(`[regime] ⏭ MTF${tfKey} 自动开仓冷却中 (还剩 ${waitS}s), 跳过本次 ${direction}`);
    return;
  }
  slot._firing = true;
  const dirLabel = direction === 'long' ? '多单' : '空单';
  const scoreStr = tfRow.score > 0 ? `+${tfRow.score}` : String(tfRow.score);
  try {
    // ⭐ 市价单: 用 manualFollowImpl (与 UI「一键追单」同一实现, 立即市价成交),
    //    不用 manualOpenImpl (那是 pending 限价, 要等价格回踩 entry 才成交).
    const { manualFollowImpl } = require('./trading/router');
    if (typeof manualFollowImpl !== 'function') {
      console.error(`[regime] ❌ trading/router 未导出 manualFollowImpl, MTF${tfKey} 自动开仓不可用`);
      return;
    }
    const r = await manualFollowImpl({ direction, source: `mtf${tfKey}_auto_open` });
    const ok = r.status >= 200 && r.status < 300;
    if (ok) {
      slot.lastFiredAt = now;
      // ⭐ 单次武装：成功开仓后只自动关闭该周期该方向的开关;
      //    被拒 (如同方向已有持仓、行情未就绪) 时保持武装, 等下一次状态转变.
      if (direction === 'long') slot.enabledLong = false;
      else slot.enabledShort = false;
      console.log(`[regime] 🔒 MTF${tfKey} 自动开仓 ${direction} 已触发成功, ${label}${direction === 'long' ? '多' : '空'}方向开关自动关闭 (单次武装)`);
    }
    const p = r.body?.position || {};
    const note = ok
      ? `entry=${p.entryPrice ?? '--'} sl=${p.currentStopLoss ?? p.initialStopLoss ?? '--'} 仓位=${p.positionSize || '--'}`
      : (r.body?.error || r.body?.hint || `HTTP ${r.status}`);
    slot.lastFired = { at: now, state: tfRow.state, score: tfRow.score, direction, status: r.status, ok, note };
    saveMtf5AutoState();
    console.log(`[regime] ${ok ? '✅' : '⏭'} MTF${tfKey} 自动开仓(市价) ${direction} status=${r.status} ${note}`);

    webhook.sendRich(
      ok
        ? `🤖 组合自动开仓：${label}转「${tfRow.state}」+ 组合过滤通过 → 已市价开${dirLabel}`
        : `🤖 组合自动开仓被拒：${label}转「${tfRow.state}」`,
      [
        [{ text: '⏰ 时间：', bold: true }, { text: new Date().toLocaleString() }],
        [{ text: `📊 ${label} MTF：`, bold: true }, { text: `${tfRow.state}（评分 ${scoreStr} · ${tfRow.action || '--'}）` }],
        ...(filters ? filters.detail.map((t) => [{ text: t }]) : []),
        [{ text: '🎬 动作：', bold: true }, { text: ok ? `市价开${dirLabel}（立即成交）` : `开${dirLabel}失败` }],
        [{ text: '📋 结果：', bold: true }, { text: note }],
        ok
          ? [{ text: `🔒 组合开${direction === 'long' ? '多' : '空'}开关已自动关闭（单次触发防重复开仓），另一方向开关不受影响；如需再次自动开仓请到页面重新开启`, italic: true }]
          : [{ text: '⚠️ 本次未成交，开关保持武装，等待下一次状态转变', italic: true }],
        [{ text: '来源：MTF 组合条件自动开仓（与「一键追单」同通道：市价成交, TP/SL 按 ATR 派生）', italic: true }],
      ],
      { eventKey: `mtf${tfKey}AutoOpen`, force: true }
    );
  } catch (e) {
    slot.lastFired = { at: now, state: tfRow.state, score: tfRow.score, direction, status: 0, ok: false, note: e?.message || String(e) };
    saveMtf5AutoState();
    console.error(`[regime] ❌ MTF${tfKey} 自动开仓异常 (${direction}):`, e?.message || e);
  } finally {
    slot._firing = false;
  }
}

const mtf5AutoTimer = setInterval(() => {
  mtfAutoTick().catch(e => console.error('[regime] mtfAutoTick 异常:', e?.message || e));
}, MTF5_AUTO.checkMs);
if (typeof mtf5AutoTimer.unref === 'function') mtf5AutoTimer.unref();

/** 复用 trading 模块的管理鉴权（X-Auth-Token 等）；trading 不可用时拒绝 */
function mtf5AdminGuard(req, res, next) {
  try {
    const { requireAdmin } = require('./trading/router');
    if (typeof requireAdmin === 'function') return requireAdmin(req, res, next);
  } catch (e) { /* fallthrough */ }
  return res.status(503).json({ ok: false, error: 'trading 模块不可用, 无法鉴权' });
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
      tg.fireAndForget(tg.sendTradeSignal(tradePlan, currentRegime, { eventType: 'OPEN' }));
      triggerAutoTrade('open_long', tradePlan);
    } else if (action === 'SHORT') {
      notifyRich('📉 交易信号：转为做空 (SHORT)', buildPlanRichLines(tradePlan, currentRegime, klines));
      tg.fireAndForget(tg.sendTradeSignal(tradePlan, currentRegime, { eventType: 'OPEN' }));
      triggerAutoTrade('open_short', tradePlan);
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

/**
 * 把 regime 喊单自动桥接到本仓库的 trading 引擎
 *
 *  - 复用 trading/router.js 内部的 processSignal(), 与外部 webhook 走同一入口,
 *    所以 token 校验 / state.canOpen() / 反向独立 / TP-SL 健全性校验 / regime plan 价位
 *    全部沿用现成逻辑, 这里只是触发器.
 *
 *  - 同方向已锁定时 processSignal 会以 409 拒绝; 反方向不受影响.
 *  - 价位锁定: 把 TG 喊单时的 tp1/tp2/tp3/stopLoss/positionSize 显式塞进 payload,
 *    保证后续 regime 5min 刷新出新 plan 也不会影响这次开仓的监控价位.
 *  - 入场价 (entry) 不传: 由 trading 引擎按 WS 实时市价撮合, 避免用过期 plan entry
 *    污染保本止损基准 (TP1 后会把 SL 移到 entryPrice).
 *  - 默认开启, 通过环境变量 AUTO_TRADE_FROM_REGIME=0 可一键关闭.
 *
 * 注意: fire-and-forget, 任何失败都不影响 TG/飞书喊单消息.
 */
function triggerAutoTrade(action, tradePlan) {
  if (process.env.AUTO_TRADE_FROM_REGIME === '0') return;

  const cfg = tradeConfig.get();
  if (!cfg.enabled) {
    console.log(`[regime→trade] ⏭ 跳过 ${action}: trading.enabled=false`);
    return;
  }
  if (!tradePlan || !tradePlan.ok) {
    console.log(`[regime→trade] ⏭ 跳过 ${action}: tradePlan.ok=false`);
    return;
  }

  const { processSignal } = require('./trading/router');
  if (typeof processSignal !== 'function') {
    console.error('[regime→trade] ❌ trading/router.js 未导出 processSignal');
    return;
  }

  const tps = Array.isArray(tradePlan.takeProfits) ? tradePlan.takeProfits : [];
  const payload = {
    token: cfg.token,
    action,
    symbol: cfg.symbol,
    stop_loss: Number(tradePlan.stopLoss),
    tp1: tps[0]?.price != null ? Number(tps[0].price) : undefined,
    tp2: tps[1]?.price != null ? Number(tps[1].price) : undefined,
    tp3: tps[2]?.price != null ? Number(tps[2].price) : undefined,
    position_size: tradePlan.suggestedPositionPct != null
      ? `${tradePlan.suggestedPositionPct}%`
      : undefined,
  };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  console.log(
    `[regime→trade] ▶ 锁定 TG 喊单价位: sl=${payload.stop_loss} tp1=${payload.tp1} `
    + `tp2=${payload.tp2} tp3=${payload.tp3} pos=${payload.position_size}`
  );

  Promise.resolve()
    .then(() => processSignal(payload, { source: 'regime' }))
    .then((r) => {
      const tag = r.status >= 200 && r.status < 300 ? '✅' : '⏭';
      const summary = r.body && (r.body.error || (r.body.position && `entry=${r.body.position.entryPrice} sl=${r.body.position.initialStopLoss}`)) || '';
      console.log(`[regime→trade] ${tag} ${action} status=${r.status} ${summary}`);
    })
    .catch((e) => {
      console.error(`[regime→trade] ❌ ${action} 异常:`, e?.message || e);
    });
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
    // 15 分钟辅助指标最新值（拉取失败时为 null）
    m15: cache.m15 ? {
      rsi: cache.m15.rsi[cache.m15.rsi.length - 1],
      macdHist: cache.m15.hist[cache.m15.hist.length - 1],
      lastClose: cache.m15.lastClose,
      lastTime: cache.m15.lastTime,
    } : null,
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
    // 15 分钟 MACD / RSI 最近 50 根（15m 拉取失败时为 null）
    macdRsi15: buildM15ChartSlice(cache.m15, CHART_TAIL),
  });
});

/** 提取 15 分钟 MACD / RSI 最近 N 根（与 buildMacdRsiChartSlice 同结构） */
function buildM15ChartSlice(m15, tail = CHART_TAIL) {
  if (!m15 || !Array.isArray(m15.times) || !m15.times.length) return null;
  const n = Math.min(tail, m15.times.length);
  const start = m15.times.length - n;
  const tailArr = (arr) => (Array.isArray(arr) ? arr.slice(start) : []);
  return {
    tail: n,
    times: m15.times.slice(start),
    macd: tailArr(m15.macd),
    signal: tailArr(m15.signal),
    hist: tailArr(m15.hist),
    rsi: tailArr(m15.rsi),
  };
}

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

// ---------------------- MTF 组合条件自动开仓：状态查询 + 开关 ----------------------
// GET 只读无需鉴权（与 /status 同级）；POST 会武装真实下单触发器, 走 trading 管理鉴权
router.get('/mtf-auto-open', (req, res) => {
  let getTf = null;
  try {
    const mtf = require('./mtfModule');
    if (typeof mtf.getTimeframe === 'function') getTf = mtf.getTimeframe;
  } catch (e) { /* mtf 不可用时 mtf 字段返回 null */ }
  const tfs = {};
  for (const key of Object.keys(mtfAuto)) {
    const s = mtfAuto[key];
    const row = getTf ? getTf(key) : null;
    tfs[key] = {
      label: MTF_AUTO_TF_CFG[key].label,
      enabledLong: s.enabledLong,
      enabledShort: s.enabledShort,
      lastFiredAt: s.lastFiredAt || null,
      lastFired: s.lastFired,
      mtf: row ? { state: row.state, score: row.score, action: row.action } : null,
    };
  }
  // 组合过滤条件当前快照（不拉 Delta, 避免 GET 轮询打 REST; Delta 只在触发时评估）
  const filters = {
    long: evalMtfComboFilters('long', null),
    short: evalMtfComboFilters('short', null),
  };
  res.json({
    ok: true,
    tfs,
    filters: {
      long: { htfOk: filters.long.htfOk, rsiOk: filters.long.rsiOk, detail: filters.long.detail },
      short: { htfOk: filters.short.htfOk, rsiOk: filters.short.rsiOk, detail: filters.short.detail },
    },
    confirm: MTF5_AUTO.confirm,
    cooldownMs: MTF5_AUTO.cooldownMs,
    // 兼容旧字段（= 1分钟槽; 组合逻辑后 5分钟槽已移除）
    enabledLong: mtfAuto['1'].enabledLong,
    enabledShort: mtfAuto['1'].enabledShort,
    enabled: mtfAutoArmed(mtfAuto['1']),
    lastFired: mtfAuto['1'].lastFired,
  });
});

// body: { tf?: '1'(默认'1'), enabledLong?: boolean, enabledShort?: boolean, enabled?: boolean(旧, 同时设双方向) }
router.post('/mtf-auto-open', mtf5AdminGuard, (req, res) => {
  const b = req.body || {};
  const tfKey = b.tf != null ? String(b.tf) : '1';
  const slot = mtfAuto[tfKey];
  if (!slot) {
    return res.status(400).json({ ok: false, error: `tf 必须是 ${Object.keys(mtfAuto).join(' / ')}` });
  }
  const patch = {};
  if (typeof b.enabled === 'boolean') { patch.enabledLong = b.enabled; patch.enabledShort = b.enabled; }
  if (typeof b.enabledLong === 'boolean') patch.enabledLong = b.enabledLong;
  if (typeof b.enabledShort === 'boolean') patch.enabledShort = b.enabledShort;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, error: 'enabledLong / enabledShort 至少提供一个 boolean' });
  }
  const wasArmed = mtfAutoArmed(slot);
  Object.assign(slot, patch);
  // 从「全关」到「武装」时重置该周期运行时基线：第一个快照只记基线,
  // 不对已存在的强多/强空追溯下单; 已武装状态下切另一方向不打断状态跟踪.
  // （注: 1分钟槽因需持续推强多/强空飞书, 状态机常驻, 基线通常已存在, 重置同样安全）
  if (!wasArmed && mtfAutoArmed(slot)) {
    slot._lastState = null;
    slot._pendingState = null;
    slot._pendingCount = 0;
    slot._lastSeenMtfAt = 0;
  }
  saveMtf5AutoState();
  console.log(`[regime] MTF${tfKey} 自动开仓开关 → long=${slot.enabledLong ? '✅' : '🛑'} short=${slot.enabledShort ? '✅' : '🛑'}`);
  res.json({ ok: true, tf: tfKey, enabledLong: slot.enabledLong, enabledShort: slot.enabledShort });
});

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

/**
 * 对外暴露：读取最近一次成功生成的 tradePlan / regime
 * 供 trading 引擎在收到 open_long/open_short 信号时, 使用本系统计算出的精准价位
 * @returns {{tradePlan, regime, latest, updatedAt}}
 */
function getLatestPlan() {
  let latest = null;
  if (cache.indicators && cache.indicators.atr) {
    const lastIdx = cache.indicators.atr.length - 1;
    // hvRef: HV 近 120 根均值, 供 trading 侧「HV/ROC 增强止盈止损」计算相对波动率
    const hvValid = (cache.indicators.hv || []).filter((v) => v != null && Number.isFinite(v));
    const recentHv = hvValid.slice(-120);
    const hvRef = recentHv.length
      ? recentHv.reduce((s, v) => s + v, 0) / recentHv.length
      : null;
    latest = {
      atr: cache.indicators.atr[lastIdx],
      adx: cache.indicators.adx[lastIdx],
      hv: cache.indicators.hv ? cache.indicators.hv[lastIdx] : null,
      hvRef,
      roc: cache.indicators.roc ? cache.indicators.roc[lastIdx] : null,
    };
  }
  return {
    tradePlan: cache.tradePlan,
    regime: cache.regime,
    latest,
    updatedAt: cache.updatedAt,
  };
}

// ⚠️ module.exports 必须在 require('./backtest/router') 之前赋值 —
// backtest/engine.js 解构 regimeMod._internal, 循环依赖时只有提前导出才有值.
module.exports = {
  router,
  setNotifier,
  setFundingProvider,
  getLatestPlan,
  // 暴露纯函数给回测引擎复用 — 与生产环境用同一套指标/判定/计划逻辑,
  // 保证回测结果与未来真实信号一致.
  _internal: {
    computeATR,
    computeADX,
    computeHV,
    computeROC,
    computeSlope,
    judgeRegime,
    buildTradePlan,
    // 多周期共振信号纯函数（供测试/回测复用）
    rsiTouchedWithin,
    macdCrossedWithin,
    evalCombo,
    dispatchComboSignals,
    // 15m 指标/信号（供测试复用）
    compute15mIndicators,
    buildM15ChartSlice,
    dispatch15mSignals,
    notifyState,
    // MTF 组合条件自动开仓（供测试复用；mtf5Auto 为 mtfAuto['1'] 的兼容别名）
    mtfAutoTick,
    mtfAuto,
    mtf5Auto,
    MTF5_AUTO,
    evalMtfComboFilters,
    fetch1mDelta,
    __setCacheM15ForTest: (m15) => { cache.m15 = m15; },
    __resetDelta1mCacheForTest: () => { _delta1mCache = { fetchedAt: 0, data: null }; },
    // 同时暴露 enhanceRegime 给回测使用 (已经从 ./regime/enhancedJudge require)
    enhanceRegime,
    // 暴露常量
    SYMBOL,
    INTERVAL,
  },
};

// === 策略回测 (与生产 PENDING 模式同算法, 1H K 线) ===
//   /api/regime/backtest/run     POST 触发回测
//   /api/regime/backtest/summary GET  最近一次摘要
//   /api/regime/backtest/last    GET  最近一次完整结果 (含 trades + equityCurve)
//   /api/regime/backtest/history GET  历史回测列表
//   /api/regime/backtest/status  GET  是否在跑
router.use('/backtest', require('./backtest/router'));

// === DeepSeek AI 行情分析 (https://aitrade.24os.cn, base URL 可在 .env 覆盖) ===
//   /api/regime/ai-analysis/config              GET   查看配置 / 启用状态
//   /api/regime/ai-analysis/signals             GET   列表 (支持 symbol / limit / offset)
//   /api/regime/ai-analysis/signals/:id         GET   详情 + AI 报告
//   /api/regime/ai-analysis/signals             POST  手动提交一条信号
//   /api/regime/ai-analysis/signals[/:id]       PATCH 增量补充
//   /api/regime/ai-analysis/build-from-regime   POST  用当前 regime + funding 自动组装并提交
router.use('/ai-analysis', aiAnalysisRouter.createRouter({
  getCache: () => cache,
  getFunding: () => safeFunding(),
  symbol: SYMBOL,
}));