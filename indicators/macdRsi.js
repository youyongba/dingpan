/**
 * ============================================================
 *  indicators/macdRsi.js
 *  MACD + RSI 指标计算模块（严格金融行业标准公式）
 *
 *  - MACD 与 TradingView / Binance 默认实现一致：
 *      DIF(MACD Line) = EMA(close, 12) - EMA(close, 26)
 *      DEA(Signal)    = EMA(DIF, 9)
 *      HIST           = DIF - DEA              // 不 ×2（国外主流），与 Binance 一致
 *    说明：
 *      - EMA 初值采用 SMA(period) 作为 seed，随后按 α = 2/(N+1) 递推，
 *        避免"零序"递推造成的长期漂移；也是 TradingView 的默认行为。
 *
 *  - RSI 使用 Wilder 原始平滑（α = 1/N），与主流平台一致：
 *      gain_i / loss_i 先通过 SMA(14) 做 seed，之后用 RMA(14) 递推。
 *
 *  - 所有函数均按"逐根 K 线"返回与输入同长度的数组，未就绪位置填 null，
 *    方便直接对齐到 klines 画图，也便于取 last 值。
 * ============================================================
 */

'use strict';

/**
 * 通用 EMA（seed = 前 period 根 SMA）
 * @param {number[]} values
 * @param {number} period
 * @returns {Array<number|null>}
 */
function computeEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < period) return out;

  const alpha = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      // 若中间有 null，仍然延续上一个 EMA（极少见，Binance K 线几乎不会缺）
      out[i] = out[i - 1];
      continue;
    }
    out[i] = v * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

/**
 * 计算 MACD (标准 12 / 26 / 9)
 * @param {number[]} close 收盘价序列（升序，最新在最后）
 * @param {object}   [opt]
 * @param {number}   [opt.fast=12]
 * @param {number}   [opt.slow=26]
 * @param {number}   [opt.signal=9]
 * @returns {{
 *   macd:   Array<number|null>,  // DIF
 *   signal: Array<number|null>,  // DEA
 *   hist:   Array<number|null>,  // MACD - Signal
 * }}
 */
function computeMACD(close, opt = {}) {
  const fast = opt.fast || 12;
  const slow = opt.slow || 26;
  const signalP = opt.signal || 9;

  const emaFast = computeEMA(close, fast);
  const emaSlow = computeEMA(close, slow);

  const macd = close.map((_, i) => {
    if (emaFast[i] == null || emaSlow[i] == null) return null;
    return emaFast[i] - emaSlow[i];
  });

  // signal = EMA(macd, 9)，注意 seed 要从 macd 非空起算
  const firstValidIdx = macd.findIndex((v) => v != null);
  const signal = new Array(close.length).fill(null);
  if (firstValidIdx !== -1 && close.length - firstValidIdx >= signalP) {
    const macdSlice = macd.slice(firstValidIdx); // 去掉前置 null
    const sigSlice = computeEMA(macdSlice, signalP);
    for (let i = 0; i < sigSlice.length; i++) {
      signal[firstValidIdx + i] = sigSlice[i];
    }
  }

  const hist = macd.map((m, i) => {
    if (m == null || signal[i] == null) return null;
    return m - signal[i];
  });

  return { macd, signal, hist };
}

/**
 * 计算 RSI（Wilder 平滑，默认 14）
 * 公式：
 *   gain_i = max(close_i - close_{i-1}, 0)
 *   loss_i = max(close_{i-1} - close_i, 0)
 *   首个 avgGain / avgLoss = SMA(14)
 *   之后：avgGain_i = (avgGain_{i-1} * 13 + gain_i) / 14   // Wilder RMA
 *   RS  = avgGain / avgLoss
 *   RSI = 100 - 100/(1+RS)
 * @param {number[]} close
 * @param {number}   [period=14]
 * @returns {Array<number|null>}
 */
function computeRSI(close, period = 14) {
  const out = new Array(close.length).fill(null);
  if (close.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = close[i] - close[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < close.length; i++) {
    const diff = close[i] - close[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * 检测 MACD 金叉 / 死叉
 *   金叉：前一根 hist <= 0，当根 hist > 0
 *   死叉：前一根 hist >= 0，当根 hist < 0
 * @param {Array<number|null>} hist
 * @returns {'GOLDEN'|'DEATH'|null}
 */
function detectMacdCross(hist) {
  if (!Array.isArray(hist) || hist.length < 2) return null;
  const cur = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  if (cur == null || prev == null) return null;
  if (prev <= 0 && cur > 0) return 'GOLDEN';
  if (prev >= 0 && cur < 0) return 'DEATH';
  return null;
}

/**
 * 检测 RSI 超买 / 超卖状态（仅返回当前区间，不做上下穿越防抖；
 * 穿越事件由 regime 模块的前后对比逻辑处理）
 * @param {number} rsi
 * @param {object} [opt]
 * @param {number} [opt.overbought=70]
 * @param {number} [opt.oversold=30]
 * @returns {'OVERBOUGHT'|'OVERSOLD'|'NEUTRAL'|null}
 */
function classifyRSI(rsi, opt = {}) {
  if (rsi == null || !Number.isFinite(rsi)) return null;
  const ob = opt.overbought || 70;
  const os = opt.oversold || 30;
  if (rsi >= ob) return 'OVERBOUGHT';
  if (rsi <= os) return 'OVERSOLD';
  return 'NEUTRAL';
}

/**
 * 裁剪 series 尾部 N 项（给前端画图用），保持时间对齐
 * @param {Array<number|null>} series
 * @param {number} tail
 */
function tailSeries(series, tail) {
  if (!Array.isArray(series)) return [];
  const n = Math.min(tail, series.length);
  return series.slice(series.length - n);
}

module.exports = {
  computeEMA,
  computeMACD,
  computeRSI,
  detectMacdCross,
  classifyRSI,
  tailSeries,
};
