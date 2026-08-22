/**
 * ============================================================
 *  mtfModule.js
 *  多周期共振评分面板 (Multi-TimeFrame Consensus)
 *
 *  七个周期 W / D / 240(4H) / 60(1H) / 15(15M) / 5(5M) / 1(1M) 各自打分,
 *  加上一列全局市场指标与底部聚合, 复刻"多周期共振"盯盘面板:
 *
 *  ── 单周期评分 (5 个分量, 每项 -1/0/+1, 总分 ∈ [-5, +5]) ──
 *    1. 收盘价 vs EMA20            (价格在均线上方 +1 / 下方 -1)
 *    2. EMA20 vs EMA50             (短均在长均上方 +1 / 下方 -1)
 *    3. MACD 柱 (hist) 正负        (正 +1 / 负 -1)
 *    4. RSI14                      (>55 +1 / <45 -1 / 中间 0)
 *    5. DMI                        (ADX≥20 且 +DI>-DI +1; -DI>+DI -1; ADX<20 → 0)
 *
 *  ── 状态与操作映射 ──
 *    +4..+5 强多→只找多 | +2..+3 偏多→回调做多 | -2..-3 偏空→反弹做空 | -4..-5 强空→只找空
 *    -1..+1 → 分量方向打架 (≥2正 且 ≥2负) 记"混乱→过滤观望", 否则"震荡→观望"
 *
 *  ── 全局指标列 ──
 *    共识引力  全周期收盘 vs EMA50 的多数方 (≥2/3 同侧: 上方/下方/分歧)
 *    市场引力  日线收盘 vs 日线 EMA20
 *    周期驱动  4H EMA20 斜率方向 (上行/下行)
 *    市场斜率  1H EMA20 斜率角度 (ATR 归一化, ±90°)
 *    相位切换  15M MACD 柱所在侧 + 最近 3 根内金/死叉
 *    市场节奏  5M 最近一根实体 vs 0.05×ATR (平静/活跃)
 *    市场结构  1H 摆动点 (fractal k=2): HH+HL 多 / LH+LL 空 / 混合
 *
 *  ── 底部聚合 ──
 *    多/中/空计数 · 加权总分 (W×0.5 D×1 4H×1.5 1H×1.5 15M×1 5M×0.5 1M×0.25, 归一到 ±5)
 *    建议 (只找空/反弹做空/观望/...) + 建议执行周期
 *    共振检测 (4H+1H+15M 同向) · 全面偏多/偏空 (≥5 周期同向)
 *    先行周期 (最近 2 根内 MACD 金/死叉的周期) · 齐涨/齐跌 (4H/1H/15M 最近一根同色)
 *    ATR% / HV% / BBW% (1H, 带升降箭头) · ATR×1.5 (点数) · 布林压缩 (蓄势待发)
 *
 *  路由: GET /api/mtf/status · POST /api/mtf/refresh
 *  纯盯盘只读模块, 不接交易引擎、不发通知.
 * ============================================================
 */
'use strict';

const express = require('express');
const axios = require('axios');
const { httpAgent, httpsAgent } = require('./lib/httpAgents');
const { computeEMA, computeMACD, computeRSI } = require('./indicators/macdRsi');
const feishu = require('./notifier/feishuWebhook');
const { cnTime } = require('./lib/timeFmt');

const router = express.Router();

// ---------------------- 配置 ----------------------
const BINANCE_FAPI = 'https://fapi.binance.com';
const SYMBOL = process.env.MTF_SYMBOL || 'BTCUSDT';
const TIMEOUT = Number(process.env.BINANCE_TIMEOUT_MS || 10000);
const REFRESH_MS = Number(process.env.MTF_REFRESH_MS || 90 * 1000);   // 默认 90s 刷新全部周期

// 周期定义 (key 与面板显示一致; weight 用于加权总分)
const TIMEFRAMES = [
  { key: 'W',   interval: '1w',  limit: 200, weight: 0.5,  label: '周线' },
  { key: 'D',   interval: '1d',  limit: 300, weight: 1.0,  label: '日线' },
  { key: '240', interval: '4h',  limit: 300, weight: 1.5,  label: '4小时' },
  { key: '60',  interval: '1h',  limit: 300, weight: 1.5,  label: '1小时' },
  { key: '15',  interval: '15m', limit: 300, weight: 1.0,  label: '15分钟' },
  { key: '5',   interval: '5m',  limit: 300, weight: 0.5,  label: '5分钟' },
  { key: '1',   interval: '1m',  limit: 300, weight: 0.25, label: '1分钟' },
];
const RESONANCE_KEYS = ['240', '60', '15'];      // 共振检测周期组 (4H+1H+15M)

// ---------------------- 指标计算 (模块自带 ATR / DMI / BB / HV) ----------------------

/** True Range 序列 */
function computeTR(klines) {
  return klines.map((k, i) => {
    if (i === 0) return k.high - k.low;
    const prevClose = klines[i - 1].close;
    return Math.max(k.high - k.low, Math.abs(k.high - prevClose), Math.abs(k.low - prevClose));
  });
}

/** Wilder RMA (α = 1/period, seed = SMA) */
function computeRMA(values, period) {
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

/** ATR (Wilder, 默认 14) */
function computeATR(klines, period = 14) {
  return computeRMA(computeTR(klines), period);
}

/** DMI / ADX (Wilder, 默认 14) → { adx, plusDI, minusDI } 逐根数组 */
function computeDMI(klines, period = 14) {
  const n = klines.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const trRma = computeRMA(computeTR(klines), period);
  const pdmRma = computeRMA(plusDM, period);
  const mdmRma = computeRMA(minusDM, period);

  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (trRma[i] == null || !trRma[i] || pdmRma[i] == null || mdmRma[i] == null) continue;
    plusDI[i] = (pdmRma[i] / trRma[i]) * 100;
    minusDI[i] = (mdmRma[i] / trRma[i]) * 100;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100 : 0;
  }
  // ADX = RMA(DX): 从第一个非空 DX 起算
  const firstIdx = dx.findIndex((v) => v != null);
  const adx = new Array(n).fill(null);
  if (firstIdx !== -1 && n - firstIdx >= period) {
    const slice = computeRMA(dx.slice(firstIdx), period);
    for (let i = 0; i < slice.length; i++) adx[firstIdx + i] = slice[i];
  }
  return { adx, plusDI, minusDI };
}

/** 布林带宽 BBW% = (upper - lower) / middle × 100, BB(20, 2) */
function computeBBW(close, period = 20, mult = 2) {
  const out = new Array(close.length).fill(null);
  for (let i = period - 1; i < close.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += close[j];
    const mid = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (close[j] - mid) ** 2;
    const sd = Math.sqrt(varSum / period);
    if (mid > 0) out[i] = ((mult * 2 * sd) / mid) * 100;
  }
  return out;
}

/** 历史波动率 HV% (对数收益标准差 × √周期数, 窗口默认 24 根 = 1H 图上的一天) */
function computeHV(close, window = 24) {
  const out = new Array(close.length).fill(null);
  const rets = close.map((c, i) => (i === 0 ? null : Math.log(c / close[i - 1])));
  for (let i = window; i < close.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += rets[j];
    const mean = sum / window;
    let varSum = 0;
    for (let j = i - window + 1; j <= i; j++) varSum += (rets[j] - mean) ** 2;
    out[i] = Math.sqrt(varSum / (window - 1)) * Math.sqrt(window) * 100;
  }
  return out;
}

/**
 * 摆动点市场结构 (fractal k=2): 高点 = 左右各 2 根都更低; 低点镜像.
 * 取最近两个摆动高点 + 两个摆动低点 → HH/LH + HL/LL.
 * @returns {{label:string, side:'bull'|'bear'|'mixed'}|null}
 */
function detectStructure(klines, k = 2) {
  const highs = [];
  const lows = [];
  for (let i = k; i < klines.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) highs.push(klines[i].high);
    if (isLow) lows.push(klines[i].low);
  }
  if (highs.length < 2 || lows.length < 2) return null;
  const hTag = highs[highs.length - 1] > highs[highs.length - 2] ? 'HH' : 'LH';
  const lTag = lows[lows.length - 1] > lows[lows.length - 2] ? 'HL' : 'LL';
  const side = hTag === 'HH' && lTag === 'HL' ? 'bull' : hTag === 'LH' && lTag === 'LL' ? 'bear' : 'mixed';
  return { label: `${hTag}+${lTag}`, side };
}

// ---------------------- 单周期评分 ----------------------

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
const at = (arr, back) => (Array.isArray(arr) && arr.length > back ? arr[arr.length - 1 - back] : null);

/**
 * 计算单个周期的评分与状态.
 * @returns 面板一行所需的全部字段 + 供聚合复用的中间指标
 */
function scoreTimeframe(tf, klines) {
  const close = klines.map((k) => k.close);
  const ema20 = computeEMA(close, 20);
  const ema50 = computeEMA(close, 50);
  const { hist } = computeMACD(close);
  const rsi = computeRSI(close, 14);
  const { adx, plusDI, minusDI } = computeDMI(klines, 14);
  const atr = computeATR(klines, 14);

  const c = last(close);
  const e20 = last(ema20);
  const e50 = last(ema50);
  const h = last(hist);
  const r = last(rsi);
  const a = last(adx);
  const pdi = last(plusDI);
  const mdi = last(minusDI);

  // 5 个分量, 每项 -1 / 0 / +1
  const components = {
    priceVsEma20: c != null && e20 != null ? (c > e20 ? 1 : c < e20 ? -1 : 0) : 0,
    ema20VsEma50: e20 != null && e50 != null ? (e20 > e50 ? 1 : e20 < e50 ? -1 : 0) : 0,
    macdHist: h != null ? (h > 0 ? 1 : h < 0 ? -1 : 0) : 0,
    rsi: r != null ? (r > 55 ? 1 : r < 45 ? -1 : 0) : 0,
    dmi: a != null && a >= 20 && pdi != null && mdi != null ? (pdi > mdi ? 1 : pdi < mdi ? -1 : 0) : 0,
  };
  const vals = Object.values(components);
  const score = vals.reduce((s, v) => s + v, 0);
  const posCount = vals.filter((v) => v > 0).length;
  const negCount = vals.filter((v) => v < 0).length;

  // 状态 + 操作
  let state, action;
  if (score >= 4)       { state = '强多'; action = '只找多'; }
  else if (score >= 2)  { state = '偏多'; action = '回调做多'; }
  else if (score <= -4) { state = '强空'; action = '只找空'; }
  else if (score <= -2) { state = '偏空'; action = '反弹做空'; }
  else if (posCount >= 2 && negCount >= 2) { state = '混乱'; action = '过滤观望'; }
  else                  { state = '震荡'; action = '观望'; }

  const side = score >= 2 ? 'bull' : score <= -2 ? 'bear' : 'neutral';

  // 最近 2 根内 MACD 金/死叉 → "先行周期"检测
  let recentCross = null;
  for (let back = 0; back <= 1; back++) {
    const cur = at(hist, back);
    const prev = at(hist, back + 1);
    if (cur == null || prev == null) break;
    if (prev <= 0 && cur > 0) { recentCross = 'golden'; break; }
    if (prev >= 0 && cur < 0) { recentCross = 'death'; break; }
  }

  // 最近一根 K 线颜色 (齐涨/齐跌检测用)
  const lastK = klines[klines.length - 1];
  const candle = lastK ? (lastK.close > lastK.open ? 'up' : lastK.close < lastK.open ? 'down' : 'flat') : null;

  return {
    key: tf.key,
    label: tf.label,
    weight: tf.weight,
    score,
    state,
    action,
    side,
    components,
    recentCross,
    candle,
    // 聚合层复用的中间值
    _close: c, _ema20: ema20, _ema50: e50, _hist: hist,
    _adx: a, _atr: atr, _klines: klines,
  };
}

// ---------------------- 全局指标列 ----------------------

/** 斜率角度: EMA20 近 5 根变化量按 ATR 归一化后取反正切 (±90°) */
function slopeDegrees(ema20, atr, bars = 5) {
  const cur = last(ema20);
  const prev = at(ema20, bars);
  const a = last(atr);
  if (cur == null || prev == null || a == null || a <= 0) return null;
  return (Math.atan((cur - prev) / (bars * a) * bars) * 180) / Math.PI;
}

function buildIndicators(tfMap) {
  const list = [];
  const sideOf = (v) => (v === 'bull' ? '多' : v === 'bear' ? '空' : '中');

  // 1. 共识引力: 全周期收盘 vs EMA50 多数方 (≥2/3 周期同侧)
  {
    let above = 0, below = 0;
    const totalTf = Object.keys(tfMap).length;
    for (const tf of Object.values(tfMap)) {
      if (tf._close != null && tf._ema50 != null) {
        if (tf._close > tf._ema50) above++;
        else if (tf._close < tf._ema50) below++;
      }
    }
    const majority = Math.ceil(totalTf * 2 / 3);   // 6周期时=4, 7周期时=5
    const side = above >= majority ? 'bull' : below >= majority ? 'bear' : 'mixed';
    list.push({
      key: 'consensusGravity', name: '共识引力',
      state: side === 'bull' ? '上方' : side === 'bear' ? '下方' : '分歧',
      tendency: sideOf(side),
      detail: `收盘在EMA50上方 ${above}/${totalTf} · 下方 ${below}/${totalTf}`,
    });
  }

  // 2. 市场引力: 日线收盘 vs 日线 EMA20
  {
    const d = tfMap.D;
    const e20 = d ? last(d._ema20) : null;
    const above = d && d._close != null && e20 != null ? d._close > e20 : null;
    list.push({
      key: 'marketGravity', name: '市场引力',
      state: above == null ? '--' : above ? '上方' : '下方',
      tendency: above == null ? '中' : above ? '多' : '空',
      detail: d && e20 != null ? `D收盘 ${d._close.toFixed(1)} vs EMA20 ${e20.toFixed(1)}` : '',
    });
  }

  // 3. 周期驱动: 4H EMA20 斜率方向
  {
    const tf = tfMap['240'];
    const deg = tf ? slopeDegrees(tf._ema20, tf._atr) : null;
    const dir = deg == null ? null : deg > 2 ? 'up' : deg < -2 ? 'down' : 'flat';
    list.push({
      key: 'cycleDriver', name: '周期驱动',
      state: dir == null ? '--' : dir === 'up' ? `上行(${tf.score >= 0 ? '+' : '-'})` : dir === 'down' ? `下行(${tf.score >= 0 ? '+' : '-'})` : '走平',
      tendency: dir === 'up' ? (tf.score >= 2 ? '多' : '中') : dir === 'down' ? (tf.score <= -2 ? '空' : '中') : '中',
      detail: deg != null ? `4H EMA20 斜率 ${deg.toFixed(1)}°` : '',
    });
  }

  // 4. 市场斜率: 1H EMA20 斜率角度
  {
    const tf = tfMap['60'];
    const deg = tf ? slopeDegrees(tf._ema20, tf._atr) : null;
    list.push({
      key: 'marketSlope', name: '市场斜率',
      state: deg == null ? '--' : `${Math.abs(deg).toFixed(1)}°${deg >= 0 ? '↑' : '↓'}`,
      tendency: deg == null ? '中' : deg > 10 ? '多' : deg < -10 ? '空' : '中',
      detail: '1H EMA20 · ATR 归一化角度',
    });
  }

  // 5. 相位切换: 15M MACD 柱所在侧 (+ 最近金/死叉)
  {
    const tf = tfMap['15'];
    const h = tf ? last(tf._hist) : null;
    const crossNote = tf?.recentCross === 'golden' ? ' · 刚金叉' : tf?.recentCross === 'death' ? ' · 刚死叉' : '';
    list.push({
      key: 'phaseSwitch', name: '相位切换',
      state: h == null ? '--' : (h > 0 ? '上方' : '下方') + crossNote,
      tendency: h == null ? '中' : h > 0 ? '多' : '空',
      detail: '15M MACD 柱零轴位置',
    });
  }

  // 6. 市场节奏: 5M 最近一根实体 vs 0.05×ATR
  {
    const tf = tfMap['5'];
    const k = tf ? tf._klines[tf._klines.length - 1] : null;
    const a = tf ? last(tf._atr) : null;
    let state = '--', tendency = '中';
    if (k && a != null && a > 0) {
      const body = Math.abs(k.close - k.open);
      const active = body > a * 0.05 * 5;    // 实体 > 0.25×ATR 记活跃 (0.05 档 × 5 根意义)
      state = active ? '活跃' : '平静';
      tendency = active ? (k.close > k.open ? '多' : '空') : '中';
    }
    list.push({
      key: 'marketRhythm', name: '市场节奏 (ATR×0.05)',
      state, tendency,
      detail: '5M 最近实体幅度 vs ATR 档位',
    });
  }

  // 7. 市场结构: 1H 摆动点 HH/HL/LH/LL
  {
    const tf = tfMap['60'];
    const st = tf ? detectStructure(tf._klines.slice(-120)) : null;
    list.push({
      key: 'marketStructure', name: '市场结构 (A5/A3)',
      state: st ? st.label + (st.side === 'bull' ? '多' : st.side === 'bear' ? '空' : '') : '--',
      tendency: st ? sideOf(st.side) : '中',
      detail: '1H 摆动高低点结构 (fractal k=2)',
    });
  }

  return list;
}

// ---------------------- 聚合汇总 ----------------------

function buildSummary(tfMap, tfRows) {
  const bullCount = tfRows.filter((t) => t.side === 'bull').length;
  const bearCount = tfRows.filter((t) => t.side === 'bear').length;
  const neutralCount = tfRows.length - bullCount - bearCount;

  // 加权总分 = 各周期分的加权平均 (按权重和归一), 四舍五入后钳制到 ±5
  const weightSum = tfRows.reduce((s, t) => s + t.weight, 0) || 1;
  const weighted = tfRows.reduce((s, t) => s + t.score * t.weight, 0) / weightSum;
  const totalScore = Math.max(-5, Math.min(5, Math.round(weighted)));

  let totalState, suggestion;
  if (totalScore >= 4)       { totalState = '强多'; suggestion = '只找多'; }
  else if (totalScore >= 2)  { totalState = '偏多'; suggestion = '回调做多'; }
  else if (totalScore <= -4) { totalState = '强空'; suggestion = '只找空'; }
  else if (totalScore <= -2) { totalState = '偏空'; suggestion = '反弹做空'; }
  else                       { totalState = '震荡'; suggestion = '观望'; }

  // 共振: 4H+1H+15M 全部同向 (|score|>=2)
  const resoRows = RESONANCE_KEYS.map((k) => tfMap[k]).filter(Boolean);
  let resonance = null;
  if (resoRows.length === RESONANCE_KEYS.length) {
    if (resoRows.every((t) => t.side === 'bear')) resonance = 'bear';
    else if (resoRows.every((t) => t.side === 'bull')) resonance = 'bull';
  }

  // 全面偏多/偏空: 至多允许 1 个周期不同向 (6周期时≥5, 7周期时≥6)
  const overallMin = tfRows.length - 1;
  const overall = bearCount >= overallMin ? '全面偏空' : bullCount >= overallMin ? '全面偏多' : null;

  // 建议执行周期: 与总方向一致的最小共振周期 (240→60→15 里最后一个同向的)
  let execTf = null;
  if (totalScore <= -2 || totalScore >= 2) {
    const wantSide = totalScore > 0 ? 'bull' : 'bear';
    for (const k of RESONANCE_KEYS) {
      if (tfMap[k] && tfMap[k].side === wantSide) execTf = k;
    }
  }

  // 回调/反弹入场参考价: 按建议执行周期 (execTf) 的指标综合计算.
  //   区间上沿(近) = 现价 ∓ 0.5×ATR       — 浅回调最少要回踩半个 ATR
  //   区间下沿(远) = 该周期 EMA20 (趋势动态支撑/阻力)
  //       · EMA20 距现价不足 0.5×ATR (太近, 刚回踩过) → 用 1.0×ATR 兜底
  //       · EMA20 距现价超过 1.5×ATR (太远, 均线滞后) → 封顶在 1.5×ATR
  //   建议挂单价 = 区间中点; SL/TP1 = 挂单价 ∓/± 1.5×ATR (与交易模块 1R 口径一致)
  let entryRef = null;
  if (execTf && tfMap[execTf]) {
    const t = tfMap[execTf];
    const atr = last(t._atr);
    const e20 = last(t._ema20);
    const close = t._close;
    if (atr != null && atr > 0 && close != null && e20 != null) {
      const sign = totalScore > 0 ? 1 : -1;                     // 1=回调做多 / -1=反弹做空
      const depthOf = (px) => (sign * (close - px)) / atr;      // 相对现价的回调深度 (单位 ATR, 正=方向正确)
      const near = close - sign * 0.5 * atr;
      let far = e20;
      if (depthOf(far) <= 0.5) far = close - sign * 1.0 * atr;
      else if (depthOf(far) > 1.5) far = close - sign * 1.5 * atr;
      const entry = (near + far) / 2;
      const risk = 1.5 * atr;
      const r1 = (n) => Math.round(n * 10) / 10;
      entryRef = {
        tf: execTf,
        side: sign > 0 ? 'long' : 'short',
        close: r1(close), atr: r1(atr), ema20: r1(e20),
        zoneNear: r1(near),                                     // 区间上沿 (离现价近)
        zoneFar: r1(far),                                       // 区间下沿 (离现价远)
        entry: r1(entry),                                       // 建议挂单价 (区间中点)
        sl: r1(entry - sign * risk),
        tp1: r1(entry + sign * risk),
        depthAtr: +(depthOf(entry)).toFixed(2),                 // 建议价对应的回调深度 (×ATR)
      };
    }
  }

  // 先行周期: 最近 2 根内 MACD 交叉且方向与总分一致的周期
  const leaders = tfRows
    .filter((t) => t.recentCross && ((totalScore < 0 && t.recentCross === 'death') || (totalScore > 0 && t.recentCross === 'golden')))
    .map((t) => t.key);

  // 齐涨/齐跌: 共振周期组最近一根 K 线同色
  const candles = resoRows.map((t) => t.candle);
  const allUp = candles.length > 0 && candles.every((c) => c === 'up');
  const allDown = candles.length > 0 && candles.every((c) => c === 'down');

  // 波动率组 (基于 1H)
  const h1 = tfMap['60'];
  let vol = null;
  if (h1) {
    const close = h1._klines.map((k) => k.close);
    const atrArr = h1._atr;
    const atrNow = last(atrArr);
    const atrPrev = at(atrArr, 1);
    const c = last(close);
    const bbwArr = computeBBW(close);
    const bbwNow = last(bbwArr);
    const bbwPrev = at(bbwArr, 1);
    const hvArr = computeHV(close, 24);
    const hvNow = last(hvArr);
    const hvPrev = at(hvArr, 1);
    // 布林压缩: 当前 BBW 低于近 120 根的 20 分位 → 蓄势待发
    const recentBbw = bbwArr.slice(-120).filter((v) => v != null).sort((a, b) => a - b);
    const p20 = recentBbw.length ? recentBbw[Math.floor(recentBbw.length * 0.2)] : null;
    const squeeze = bbwNow != null && p20 != null && bbwNow <= p20;

    vol = {
      atrPct: atrNow != null && c ? +(atrNow / c * 100).toFixed(2) : null,
      atrTrend: atrNow != null && atrPrev != null ? (atrNow >= atrPrev ? 'up' : 'down') : null,
      atrX15: atrNow != null ? +(atrNow * 1.5).toFixed(1) : null,
      hvPct: hvNow != null ? +hvNow.toFixed(1) : null,
      hvTrend: hvNow != null && hvPrev != null ? (hvNow >= hvPrev ? 'up' : 'down') : null,
      bbwPct: bbwNow != null ? +bbwNow.toFixed(2) : null,
      bbwTrend: bbwNow != null && bbwPrev != null ? (bbwNow >= bbwPrev ? 'up' : 'down') : null,
      squeeze,
    };
  }

  return {
    bullCount, bearCount, neutralCount, total: tfRows.length,
    totalScore, totalState, suggestion, execTf,
    entryRef,                                      // 回调/反弹入场参考 { tf, side, entry, zoneNear, zoneFar, sl, tp1, ... } | null
    resonance,                                     // 'bull' | 'bear' | null
    resonanceLabel: resonance === 'bear' ? '空头共振 (4H+1H+15M)' : resonance === 'bull' ? '多头共振 (4H+1H+15M)' : '无共振',
    overall,                                       // '全面偏空' | '全面偏多' | null
    leaders,                                       // ['240','60','15']
    candleSync: allDown ? '齐跌' : allUp ? '齐涨' : null,
    vol,
    currentPrice: h1 && h1._close != null ? h1._close : null,
  };
}

// ---------------------- 短周期状态变化 → 飞书推送 ----------------------
//
// 规则:
//   - 监控 MTF_NOTIFY_TFS 指定周期 (默认 15M + 5M) 的"状态"标签
//     (强多/偏多/震荡/混乱/偏空/强空)
//   - 新状态需连续 MTF_NOTIFY_CONFIRM 轮刷新一致才确认推送 (默认 2 轮 ≈ 3 分钟),
//     防止分数在阈值附近来回抖动刷屏
//   - 进程启动后的第一轮只记录基线, 不推送 (避免每次重启都发一条)
//   - 走 force 跳过 feishuWebhook 的全局节流 (confirm 机制本身就是防抖)
const STATE_CONFIRM = Math.max(1, parseInt(process.env.MTF_NOTIFY_CONFIRM, 10) || 2);
const NOTIFY_TFS = (process.env.MTF_NOTIFY_TFS || '15,5').split(',').map((s) => s.trim()).filter(Boolean);
const TF_CN_LABEL = { W: '周线', D: '日线', 240: '4小时', 60: '1小时', 15: '15分钟', 5: '5分钟', 1: '1分钟' };

// key -> { lastState, pendingState, pendingCount }
const notifyStates = new Map();

function evaluateTfStateChange(tfKey, tf, summary) {
  if (!tf || !tf.state) return;
  const cur = tf.state;
  const label = TF_CN_LABEL[tfKey] || tfKey;
  let st = notifyStates.get(tfKey);
  if (!st) { st = { lastState: null, pendingState: null, pendingCount: 0 }; notifyStates.set(tfKey, st); }

  // 启动首轮: 只记基线
  if (st.lastState == null) {
    st.lastState = cur;
    console.log(`[mtf] ${label} 状态基线: ${cur}`);
    return;
  }
  // 状态没变 (或抖回原状态): 清掉待确认
  if (cur === st.lastState) {
    st.pendingState = null;
    st.pendingCount = 0;
    return;
  }
  // 状态变了: 累计确认轮数
  if (st.pendingState === cur) {
    st.pendingCount += 1;
  } else {
    st.pendingState = cur;
    st.pendingCount = 1;
  }
  if (st.pendingCount < STATE_CONFIRM) return;

  const from = st.lastState;
  st.lastState = cur;
  st.pendingState = null;
  st.pendingCount = 0;

  const emoji = tf.side === 'bear' ? '🔴' : tf.side === 'bull' ? '🟢' : '🟡';
  const scoreStr = tf.score > 0 ? `+${tf.score}` : String(tf.score);
  console.log(`[mtf] 📣 ${label} 状态变化: ${from} → ${cur} (分 ${scoreStr}), 推送飞书`);
  feishu.sendRich(`${emoji} MTF ${label}状态变化: ${from} → ${cur}`, [
    [{ text: `📊 ${SYMBOL} · ${label}周期` }],
    [{ text: `状态: ${from} → ${cur}   (分数 ${scoreStr})` }],
    [{ text: `操作: ${tf.action}` }],
    [{ text: `总分: ${summary.totalState} ${summary.totalScore > 0 ? '+' + summary.totalScore : summary.totalScore} · 建议 ${summary.suggestion}${summary.execTf ? ' · ' + summary.execTf : ''}` }],
    [{ text: `共振: ${summary.resonanceLabel}${summary.overall ? ' · ' + summary.overall : ''}` }],
    [{ text: `现价: ${summary.currentPrice != null ? Number(summary.currentPrice).toFixed(1) : '--'}` }],
    [{ text: `⏰ ${cnTime()}` }],
  ], { eventKey: `mtf${tfKey}StateChange`, force: true });
}

// ---------------------- 总建议变化 → 飞书推送 ----------------------
//
// 监控聚合汇总的「建议」(只找多/回调做多/观望/反弹做空/只找空, 与总分状态一一对应),
// 与单周期推送同款 confirm 防抖: 新建议连续 STATE_CONFIRM 轮一致才确认;
// 启动首轮只记基线不推送。
const suggestionNotify = { lastSuggestion: null, pendingSuggestion: null, pendingCount: 0 };
const SUGGESTION_EMOJI = { 只找多: '🟢', 回调做多: '🟩', 观望: '🟡', 反弹做空: '🟧', 只找空: '🔴' };

function evaluateSuggestionChange(summary, tfRows) {
  if (!summary || !summary.suggestion) return;
  const cur = summary.suggestion;
  const st = suggestionNotify;

  if (st.lastSuggestion == null) {
    st.lastSuggestion = cur;
    console.log(`[mtf] 总建议基线: ${cur}`);
    return;
  }
  if (cur === st.lastSuggestion) {
    st.pendingSuggestion = null;
    st.pendingCount = 0;
    return;
  }
  if (st.pendingSuggestion === cur) {
    st.pendingCount += 1;
  } else {
    st.pendingSuggestion = cur;
    st.pendingCount = 1;
  }
  if (st.pendingCount < STATE_CONFIRM) return;

  const from = st.lastSuggestion;
  st.lastSuggestion = cur;
  st.pendingSuggestion = null;
  st.pendingCount = 0;

  const emoji = SUGGESTION_EMOJI[cur] || '📌';
  const totalStr = summary.totalScore > 0 ? `+${summary.totalScore}` : String(summary.totalScore);
  // 各周期一行速览: 周线 强多+5 · 日线 偏多+2 · ...
  const tfOverview = (tfRows || [])
    .map((t) => `${TF_CN_LABEL[t.key] || t.label || t.key} ${t.state}${t.score > 0 ? '+' + t.score : t.score}`)
    .join(' · ');

  console.log(`[mtf] 📣 总建议变化: ${from} → ${cur} (总分 ${totalStr}), 推送飞书`);
  const er = summary.entryRef;
  const entryLine = er
    ? `${er.side === 'long' ? '回调' : '反弹'}区间: ${er.zoneNear} ~ ${er.zoneFar}   建议挂单 ${er.entry} (深度 ${er.depthAtr}×ATR) · SL ${er.sl} · TP1 ${er.tp1}`
    : null;
  feishu.sendRich(`${emoji} MTF 总建议变化: ${from} → ${cur}`, [
    [{ text: `📊 ${SYMBOL} · 多周期共振汇总` }],
    [{ text: `建议: ${from} → ${cur}${summary.execTf ? '   (建议执行周期 ' + (TF_CN_LABEL[summary.execTf] || summary.execTf) + ')' : ''}`, bold: true }],
    ...(entryLine ? [[{ text: entryLine }]] : []),
    [{ text: `总分: ${summary.totalState} ${totalStr}   (多 ${summary.bullCount} / 空 ${summary.bearCount} / 中 ${summary.neutralCount})` }],
    [{ text: `共振: ${summary.resonanceLabel}${summary.overall ? ' · ' + summary.overall : ''}${summary.candleSync ? ' · ' + summary.candleSync : ''}` }],
    [{ text: `各周期: ${tfOverview || '--'}` }],
    [{ text: `现价: ${summary.currentPrice != null ? Number(summary.currentPrice).toFixed(1) : '--'}` }],
    [{ text: `⏰ ${cnTime()}` }],
  ], { eventKey: 'mtfSuggestionChange', force: true });
}

// ---------------------- 数据拉取与刷新 ----------------------

let cache = {
  ok: false,
  updatedAt: null,
  symbol: SYMBOL,
  timeframes: [],       // 面板左表行
  indicators: [],       // 面板右列
  summary: null,        // 底部聚合
  error: null,
};

async function fetchKlines(interval, limit) {
  const { data } = await axios.get(`${BINANCE_FAPI}/fapi/v1/klines`, {
    params: { symbol: SYMBOL, interval, limit },
    timeout: TIMEOUT,
    httpAgent, httpsAgent,
  });
  return data.map((k) => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

let _isRefreshing = false;   // 重入守卫 (与 regimeModule 同款, 防慢响应堆积)

async function refresh() {
  if (_isRefreshing) return;
  _isRefreshing = true;
  try {
    const klinesList = await Promise.all(TIMEFRAMES.map((tf) => fetchKlines(tf.interval, tf.limit)));
    const tfRows = TIMEFRAMES.map((tf, i) => scoreTimeframe(tf, klinesList[i]));
    const tfMap = Object.fromEntries(tfRows.map((t) => [t.key, t]));

    const indicators = buildIndicators(tfMap);
    const summary = buildSummary(tfMap, tfRows);

    cache = {
      ok: true,
      updatedAt: Date.now(),
      symbol: SYMBOL,
      // 对外裁剪掉内部大数组 (_klines/_ema20/_hist/_atr), 只留面板要的字段
      timeframes: tfRows.map(({ key, label, score, state, action, side, components, recentCross, candle }) => ({
        key, label, score, state, action, side, components, recentCross, candle,
      })),
      indicators,
      summary,
      error: null,
    };

    // 短周期 (默认 15M/5M) 状态变化检测 → 飞书 (confirm 防抖, 详见上方注释)
    for (const tfKey of NOTIFY_TFS) {
      try {
        evaluateTfStateChange(tfKey, tfMap[tfKey], summary);
      } catch (e) {
        console.error(`[mtf] ${tfKey} 状态推送检测异常:`, e?.message || e);
      }
    }
    // 总建议 (只找多/回调做多/观望/反弹做空/只找空) 变化检测 → 飞书 (同款 confirm 防抖)
    try {
      evaluateSuggestionChange(summary, tfRows);
    } catch (e) {
      console.error('[mtf] 总建议推送检测异常:', e?.message || e);
    }
  } catch (e) {
    cache.error = e?.message || String(e);
    console.error('[mtf] 刷新失败:', cache.error);
  } finally {
    _isRefreshing = false;
  }
}

// ---------------------- 路由 ----------------------

router.get('/status', (req, res) => {
  res.json(cache);
});

router.post('/refresh', async (req, res) => {
  await refresh();
  res.json({ ok: cache.ok, updatedAt: cache.updatedAt, error: cache.error });
});

// ---------------------- 启动 ----------------------

const timer = setInterval(refresh, REFRESH_MS);
if (typeof timer.unref === 'function') timer.unref();
refresh();
console.log(`[mtf] 多周期共振模块已启动: ${SYMBOL} · ${TIMEFRAMES.map((t) => t.key).join('/')} · 刷新 ${REFRESH_MS / 1000}s`);

// ---------------------- 对外只读接口 ----------------------
/**
 * 读取指定周期的最新评分行（供 regimeModule 共振信号复用）
 * @param {string} key 'W'|'D'|'240'|'60'|'15'|'5'
 * @returns {{key,label,score,state,action,side,components,recentCross,candle}|null}
 */
function getTimeframe(key) {
  if (!cache.ok || !Array.isArray(cache.timeframes)) return null;
  return cache.timeframes.find((t) => t.key === String(key)) || null;
}

/** 最近一次成功刷新的时间戳（毫秒），未成功过返回 null */
function getUpdatedAt() {
  return cache.updatedAt;
}

module.exports = { router, refresh, getTimeframe, getUpdatedAt, _test: { evaluateTfStateChange, notifyStates, evaluateSuggestionChange, suggestionNotify, buildSummary } };
