/**
 * ============================================================
 *  regime/aiAnalysisRouter.js
 *  挂载路径: /api/regime/ai-analysis
 *  - 透传代理 aitrade.24os.cn 的四个 REST 接口
 *  - 额外提供 /build-from-regime: 用当前 regime cache + funding 组装一条信号后提交
 *  - 失败全部 5xx JSON 响应, 不会 500 泄漏 stack
 * ============================================================
 */
const express = require('express');
const ai = require('./aiAnalysis');

/**
 * @param {object} opts
 * @param {()=>object} opts.getCache          读取 regime 缓存 {indicators, klines, regime, tradePlan}
 * @param {()=>object|null} [opts.getFunding]  可选，读取资金费率快照
 * @param {string} [opts.symbol]               固定 symbol (默认 BTCUSDT)
 */
function createRouter({ getCache, getFunding = null, symbol = 'BTCUSDT' } = {}) {
  if (typeof getCache !== 'function') {
    throw new Error('aiAnalysisRouter: getCache 必须是函数');
  }
  const router = express.Router();

  // --- 1) 查看本模块配置/启停状态 ---
  router.get('/config', (req, res) => {
    res.json({ ok: true, ...ai.getConfig() });
  });

  // --- 2) GET /signals 列表 ---
  router.get('/signals', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const sym = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
      const { status, data } = await ai.listSignals({ symbol: sym, limit, offset });
      return res.status(status).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, code: e.code });
    }
  });

  // --- 3) GET /signals/:id 详情 ---
  router.get('/signals/:id', async (req, res) => {
    try {
      const { status, data } = await ai.getSignalDetail(req.params.id);
      return res.status(status).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, code: e.code });
    }
  });

  // --- 4) POST /signals 手动提交 ---
  router.post('/signals', express.json({ limit: '128kb' }), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.symbol) body.symbol = symbol;
      const { status, data } = await ai.submitSignal(body);
      return res.status(status).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, code: e.code });
    }
  });

  // --- 5) PATCH /signals(/:id) 增量补充 ---
  router.patch('/signals/:id?', express.json({ limit: '128kb' }), async (req, res) => {
    try {
      const id = req.params.id || null;
      const { status, data } = await ai.patchSignal(req.body || {}, id);
      return res.status(status).json(data);
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, code: e.code });
    }
  });

  // --- 6) POST /build-from-regime: 用当前 regime + funding 自动组装并提交 ---
  router.post('/build-from-regime', express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const cache = getCache() || {};
      if (!cache.indicators || !cache.klines || !cache.regime) {
        return res.status(503).json({
          ok: false,
          error: 'Regime 数据尚未就绪, 请稍后重试',
          code: 'REGIME_NOT_READY',
        });
      }
      const funding = getFunding ? safeCall(getFunding) : null;
      const payload = buildSignalFromRegime({ cache, funding, symbol });

      // 允许调用方用 req.body 覆盖/补充（比如前端传一个 risk_amount）
      if (req.body && typeof req.body === 'object') {
        Object.assign(payload, req.body);
      }

      const { status, data } = await ai.submitSignal(payload);
      return res.status(status).json({
        ok: status >= 200 && status < 300,
        submittedPayload: payload,
        upstream: data,
      });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message, code: e.code });
    }
  });

  return router;
}

// ---------------------- helpers ----------------------
function safeCall(fn) {
  try { return fn(); } catch (_) { return null; }
}

function lastFinite(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function round(n, digits = 6) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

/**
 * 把本地 regime cache + funding state 翻译成 aitrade /api/v1/signals 的字段
 * - 完全兼容文档：没有值的字段一律不传
 * - 情绪推断规则与现有 regime.direction 对齐，direction 仅作参考（AI 会自己判断）
 */
function buildSignalFromRegime({ cache, funding, symbol }) {
  const ind = cache.indicators || {};
  const regime = cache.regime || {};
  const plan = cache.tradePlan || null;
  const klines = cache.klines || [];
  const lastKline = klines.length ? klines[klines.length - 1] : null;

  const close = lastKline ? Number(lastKline.close) : lastFinite(ind.close);
  const atr = lastFinite(ind.atr);
  const adx = lastFinite(ind.adx);
  const plusDI = lastFinite(ind.plusDI);
  const minusDI = lastFinite(ind.minusDI);
  const hv = lastFinite(ind.hv);
  const roc = lastFinite(ind.roc);
  const slope = lastFinite(ind.slope);
  const macd = lastFinite(ind.macd);
  const macdSig = lastFinite(ind.signal);
  const macdHist = lastFinite(ind.hist);
  const rsi = lastFinite(ind.rsi);

  const dirRaw = (regime.direction || '').toLowerCase();
  const direction = dirRaw === 'long' ? 'LONG' : dirRaw === 'short' ? 'SHORT' : 'NEUTRAL';

  // 简化情绪：多头/空头/中性 + 置信度 → GREED/FEAR/NEUTRAL
  let sentiment = 'NEUTRAL';
  if (direction === 'LONG') sentiment = regime.confidence === 'high' ? 'GREED' : 'SLIGHT_GREED';
  else if (direction === 'SHORT') sentiment = regime.confidence === 'high' ? 'FEAR' : 'SLIGHT_FEAR';
  if (regime.subRegime === 'PANIC') sentiment = 'PANIC';

  // 用细分状态作为 long/short 条件，便于 aitrade 端回显
  const conditions = [];
  if (regime.subLabel) conditions.push(`subRegime:${regime.subLabel}`);
  if (regime.signals?.macdCross) conditions.push(`MACD:${regime.signals.macdCross}`);
  if (regime.signals?.rsiZone && regime.signals.rsiZone !== 'NEUTRAL') conditions.push(`RSI:${regime.signals.rsiZone}`);

  const payload = {
    symbol: symbol || 'BTCUSDT',
    direction,
    close: round(close, 2),
    last_price: round(close, 2),
    atr14: round(atr, 2),
    adx: round(adx, 2),
    plus_di: round(plusDI, 2),
    minus_di: round(minusDI, 2),
    hv_percent: round(hv, 2),
    roc_percent: round(roc, 2),
    slope_dollar_per_hour: round(slope, 2),
    macd: round(macd, 2),
    macd_signal: round(macdSig, 2),
    macd_hist: round(macdHist, 2),
    rsi14: round(rsi, 2),
    sentiment,
  };

  // tradePlan (如 regime 给出了 ok:true 的多/空计划)
  if (plan && plan.ok) {
    payload.entry_price = round(plan.entry, 2);
    payload.stop_loss = round(plan.stopLoss, 2);
    const tps = Array.isArray(plan.takeProfits) ? plan.takeProfits.map(t => t.price).filter(n => Number.isFinite(n)) : [];
    if (tps.length) payload.take_profits = JSON.stringify(tps);
    if (typeof plan.suggestedPositionPct === 'number') {
      payload.position_size = plan.suggestedPositionPct / 100;
    }
  }

  // 评分：confidence high/medium/low → 1~5 范围 (粗略映射)
  const confScore = { high: 5, medium: 3, low: 2 }[regime.confidence] || 1;
  if (direction === 'LONG') {
    payload.long_score = confScore;
    payload.short_score = 5 - confScore;
    payload.risk_score = regime.confidence === 'high' ? 4 : 3;
  } else if (direction === 'SHORT') {
    payload.short_score = confScore;
    payload.long_score = 5 - confScore;
    payload.risk_score = regime.confidence === 'high' ? 4 : 3;
  } else {
    payload.risk_score = 2;
  }

  if (conditions.length) {
    payload.long_conditions = direction === 'LONG' ? JSON.stringify(conditions) : '[]';
    payload.short_conditions = direction === 'SHORT' ? JSON.stringify(conditions) : '[]';
  }

  if (regime.riskNote) {
    payload.liquidity_alerts = JSON.stringify([regime.riskNote]);
  }

  // 资金费率 (如果 server.js 注入了 fundingProvider)
  if (funding && typeof funding === 'object') {
    if (Number.isFinite(funding.predictedFundingRate)) payload.funding_rate_instant = round(funding.predictedFundingRate, 8);
    if (Number.isFinite(funding.rate1hAvg)) payload.funding_rate_1h_avg = round(funding.rate1hAvg, 8);
    if (Number.isFinite(funding.lastSettledFundingRate)) payload.funding_rate_prev_settled = round(funding.lastSettledFundingRate, 8);
    if (Number.isFinite(funding.rateDailyWithPredict)) payload.funding_today_cumulative = round(funding.rateDailyWithPredict, 8);
  }

  return payload;
}

module.exports = {
  createRouter,
  _internal: { buildSignalFromRegime },
};
