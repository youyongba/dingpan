/**
 * ============================================================
 *  regime/enhancedJudge.js
 *  升级版 Regime 判断：在原 ADX/HV 判定基础上融合 MACD + RSI
 *
 *  输入：baseRegime（原 judgeRegime 的输出：TREND / RANGE / PANIC / NEUTRAL）
 *        + 最新 ADX/+DI/-DI/HV/MACD/Signal/Hist/RSI
 *  输出：
 *    {
 *      ...baseRegime,                // 保留 regime / label / color / desc / metrics
 *      subRegime,                    // STRONG_BULL / WEAK_BULL / RANGE_NEUTRAL /
 *                                    // WEAK_BEAR / STRONG_BEAR / PANIC / UNCLEAR
 *      subLabel,                     // 中文标签：强多头 / 弱多头 / 震荡 / 弱空头 / 强空头 / 恐慌 / 未明
 *      direction,                    // long / short / neutral
 *      confidence,                   // high / medium / low
 *      confidenceLabel,              // 高 / 中 / 低
 *      riskNote,                     // 风险提示（字符串）
 *      signals: {                    // 本次最新快照信号
 *        macdCross,                  // 'GOLDEN' | 'DEATH' | null
 *        rsiZone,                    // 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL'
 *        macdSide,                   // 'BULL' | 'BEAR' | 'FLAT'
 *        diSide,                     // 'BULL' | 'BEAR' | 'FLAT'
 *      },
 *      enhancedMetrics: { macd, signal, hist, rsi }
 *    }
 *
 *  规则（核心决策树）：
 *    1. 原 ADX 判 TREND：
 *         - +DI>-DI (多头)
 *             MACD hist>0 且 RSI<70 → STRONG_BULL
 *             MACD hist>0 且 RSI>=70 → WEAK_BULL（超买风险）
 *             MACD hist<=0          → WEAK_BULL（动能转弱/背离）
 *         - -DI>+DI (空头) 同理镜像
 *    2. 原 ADX 判 RANGE：
 *         - RSI 40~60 且 |MACD|<阈值 → RANGE_NEUTRAL（震荡强化，规避假突破）
 *         - RSI>=70                  → WEAK_BEAR（顶部反转概率升高）
 *         - RSI<=30                  → WEAK_BULL（底部反转概率升高）
 *         - 其余                     → RANGE_NEUTRAL
 *    3. 原 ADX 判 PANIC：维持 PANIC，但方向由 MACD 确认
 *    4. 原 NEUTRAL：
 *         - MACD hist>0 且 RSI>50    → WEAK_BULL（弱信号）
 *         - MACD hist<0 且 RSI<50    → WEAK_BEAR
 *         - 其余                     → UNCLEAR
 * ============================================================
 */

'use strict';

const { detectMacdCross, classifyRSI } = require('../indicators/macdRsi');

// MACD "平坦"阈值：|hist| 相对价格比（可按品种调整）
const MACD_FLAT_RATIO = 0.0003;

const SUB_LABELS = {
  STRONG_BULL:   '强多头',
  WEAK_BULL:     '弱多头',
  RANGE_NEUTRAL: '震荡',
  WEAK_BEAR:     '弱空头',
  STRONG_BEAR:   '强空头',
  PANIC:         '恐慌',
  UNCLEAR:       '未明',
};

const CONF_LABEL = { high: '高', medium: '中', low: '低' };

/**
 * @param {object} baseRegime judgeRegime() 的输出
 * @param {object} indicatorsLatest
 *   { adx, plusDI, minusDI, hv, macd, signal, hist, rsi, close, histSeries }
 */
function enhance(baseRegime, latest) {
  const {
    adx = null, plusDI = null, minusDI = null,
    macd = null, signal = null, hist = null,
    rsi = null, close = null, histSeries = [],
  } = latest || {};

  // -------- 基础信号抽取 --------
  const macdCross = detectMacdCross(histSeries); // GOLDEN / DEATH / null
  const rsiZone = classifyRSI(rsi);              // OVERBOUGHT / OVERSOLD / NEUTRAL

  const macdFlatAbs = close ? close * MACD_FLAT_RATIO : 0;
  let macdSide = 'FLAT';
  if (hist != null && Number.isFinite(hist)) {
    if (hist > macdFlatAbs) macdSide = 'BULL';
    else if (hist < -macdFlatAbs) macdSide = 'BEAR';
  }

  let diSide = 'FLAT';
  if (plusDI != null && minusDI != null && Number.isFinite(plusDI) && Number.isFinite(minusDI)) {
    const spread = plusDI - minusDI;
    if (spread > 2) diSide = 'BULL';
    else if (spread < -2) diSide = 'BEAR';
  }

  // -------- 核心决策 --------
  let subRegime = 'UNCLEAR';
  let direction = 'neutral';
  let confidence = 'low';
  let riskNote = '';

  const baseKey = baseRegime?.regime || 'NEUTRAL';

  if (baseKey === 'TREND') {
    if (diSide === 'BULL') {
      if (macdSide === 'BULL' && rsiZone !== 'OVERBOUGHT') {
        subRegime = 'STRONG_BULL'; direction = 'long';
        confidence = adx > 35 ? 'high' : 'medium';
        riskNote = '趋势与动能共振，注意回撤保护利润';
      } else if (macdSide === 'BULL' && rsiZone === 'OVERBOUGHT') {
        subRegime = 'WEAK_BULL'; direction = 'long';
        confidence = 'low';
        riskNote = `RSI=${num(rsi)} 超买：短线追多风险偏高，建议等待回踩`;
      } else {
        subRegime = 'WEAK_BULL'; direction = 'long';
        confidence = 'low';
        riskNote = 'ADX 多头但 MACD 动能转弱，警惕顶背离';
      }
    } else if (diSide === 'BEAR') {
      if (macdSide === 'BEAR' && rsiZone !== 'OVERSOLD') {
        subRegime = 'STRONG_BEAR'; direction = 'short';
        confidence = adx > 35 ? 'high' : 'medium';
        riskNote = '趋势与动能共振向下，注意反弹保护利润';
      } else if (macdSide === 'BEAR' && rsiZone === 'OVERSOLD') {
        subRegime = 'WEAK_BEAR'; direction = 'short';
        confidence = 'low';
        riskNote = `RSI=${num(rsi)} 超卖：短线追空风险偏高，建议等待反弹`;
      } else {
        subRegime = 'WEAK_BEAR'; direction = 'short';
        confidence = 'low';
        riskNote = 'ADX 空头但 MACD 动能转弱，警惕底背离';
      }
    } else {
      subRegime = 'UNCLEAR'; direction = 'neutral'; confidence = 'low';
      riskNote = 'ADX 判趋势但 DI 差值不显著，信号不清晰';
    }
  } else if (baseKey === 'RANGE') {
    const rsiMid = rsi != null && rsi >= 40 && rsi <= 60;
    if (rsiMid && macdSide === 'FLAT') {
      subRegime = 'RANGE_NEUTRAL'; direction = 'neutral'; confidence = 'medium';
      riskNote = 'MACD 钝化 + RSI 中性：震荡确认，规避假突破';
    } else if (rsiZone === 'OVERBOUGHT') {
      subRegime = 'WEAK_BEAR'; direction = 'short'; confidence = 'low';
      riskNote = '震荡区顶部 RSI 超买，可尝试轻仓高抛';
    } else if (rsiZone === 'OVERSOLD') {
      subRegime = 'WEAK_BULL'; direction = 'long'; confidence = 'low';
      riskNote = '震荡区底部 RSI 超卖，可尝试轻仓低吸';
    } else {
      subRegime = 'RANGE_NEUTRAL'; direction = 'neutral'; confidence = 'low';
      riskNote = '震荡市：建议区间/网格，避免方向单';
    }
  } else if (baseKey === 'PANIC') {
    subRegime = 'PANIC'; direction = 'neutral'; confidence = 'low';
    riskNote = '高波动无趋势：建议降低杠杆，等待方向明朗';
  } else {
    // NEUTRAL
    if (macdSide === 'BULL' && rsi != null && rsi > 50) {
      subRegime = 'WEAK_BULL'; direction = 'long'; confidence = 'low';
      riskNote = 'ADX 偏弱，仅 MACD/RSI 提示多头，适合小仓位试单';
    } else if (macdSide === 'BEAR' && rsi != null && rsi < 50) {
      subRegime = 'WEAK_BEAR'; direction = 'short'; confidence = 'low';
      riskNote = 'ADX 偏弱，仅 MACD/RSI 提示空头，适合小仓位试单';
    } else {
      subRegime = 'UNCLEAR'; direction = 'neutral'; confidence = 'low';
      riskNote = '信号不足：观望或收紧风险';
    }
  }

  // MACD 刚发生金叉/死叉时，对方向性给一个小幅加成
  if (macdCross === 'GOLDEN' && direction === 'long' && confidence === 'low') {
    confidence = 'medium';
    riskNote = `${riskNote}；MACD 刚金叉，动能翻多`;
  } else if (macdCross === 'DEATH' && direction === 'short' && confidence === 'low') {
    confidence = 'medium';
    riskNote = `${riskNote}；MACD 刚死叉，动能转空`;
  }

  return {
    ...baseRegime,
    subRegime,
    subLabel: SUB_LABELS[subRegime] || subRegime,
    direction,
    confidence,
    confidenceLabel: CONF_LABEL[confidence] || '--',
    riskNote,
    signals: { macdCross, rsiZone, macdSide, diSide },
    enhancedMetrics: {
      macd: num(macd), signal: num(signal), hist: num(hist), rsi: num(rsi),
    },
  };
}

function num(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

module.exports = { enhance, SUB_LABELS };
