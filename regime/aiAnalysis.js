/**
 * ============================================================
 *  regime/aiAnalysis.js
 *  DeepSeek 行情分析系统 (https://aitrade.24os.cn) REST 客户端
 *
 *  所有配置通过 .env 注入，服务端做代理转发，不把 base URL 暴露给前端
 *  设计原则：
 *   - 独立文件 / 独立路由前缀，和现有 regime / trading / backtest 完全解耦
 *   - 失败不抛到外层（上层路由自行包装 res.status），避免拖垮 regime refresh 主流程
 * ============================================================
 */
const axios = require('axios');
const { httpAgent, httpsAgent } = require('../lib/httpAgents');

const BASE_URL = (process.env.AI_ANALYSIS_BASE_URL || 'https://aitrade.24os.cn').replace(/\/+$/, '');
const TIMEOUT = Number(process.env.AI_ANALYSIS_TIMEOUT_MS) || 15000;
const ENABLED = process.env.AI_ANALYSIS_ENABLED !== '0';

// 允许透传的字段（严格按 aitrade API 文档声明），多余字段自动丢弃
const ALLOWED_FIELDS = new Set([
  'symbol', 'direction', 'entry_price', 'stop_loss', 'take_profits',
  'risk_amount', 'position_size', 'notional',
  'long_conditions', 'short_conditions', 'liquidity_alerts',
  'risk_score', 'long_score', 'short_score',
  'last_price', 'vwap', 'atr14',
  'depth_ratio', 'spread', 'cvd', 'cvd_price_corr', 'illiq',
  'close', 'adx', 'plus_di', 'minus_di',
  'hv_percent', 'roc_percent', 'slope_dollar_per_hour',
  'macd', 'macd_signal', 'macd_hist', 'rsi14',
  'funding_rate_instant', 'funding_rate_1h_avg',
  'funding_rate_prev_settled', 'funding_today_cumulative',
  'sentiment',
]);

function sanitize(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (v === undefined || v === null) continue;
    // Number 字段用 Number.isFinite 过滤 NaN/Infinity
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

function disabledErr() {
  const err = new Error('AI 分析已在 .env 中关闭 (AI_ANALYSIS_ENABLED=0)');
  err.code = 'AI_ANALYSIS_DISABLED';
  return err;
}

async function request(method, urlPath, { body = null, params = null } = {}) {
  if (!ENABLED) throw disabledErr();
  const url = `${BASE_URL}${urlPath}`;
  try {
    const resp = await axios.request({
      method,
      url,
      params: params || undefined,
      data: body || undefined,
      timeout: TIMEOUT,
      httpAgent,
      httpsAgent,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      // 不让 axios 自动 throw on 4xx: 统一在调用方处理
      validateStatus: s => s >= 200 && s < 500,
    });
    return { status: resp.status, data: resp.data };
  } catch (e) {
    const err = new Error(`[aiAnalysis] ${method} ${urlPath} 失败: ${e.message}`);
    err.cause = e;
    err.code = e.code || 'AI_ANALYSIS_NETWORK_ERROR';
    throw err;
  }
}

/**
 * POST /api/v1/signals  —— 接收一条新信号，后台同步触发 AI 分析
 * @param {object} signal 原始指标数据（会自动只保留白名单字段）
 */
async function submitSignal(signal) {
  const clean = sanitize(signal);
  if (!clean.symbol) {
    const err = new Error('submitSignal: symbol 字段必填');
    err.code = 'AI_ANALYSIS_BAD_REQUEST';
    throw err;
  }
  return request('POST', '/api/v1/signals', { body: clean });
}

/**
 * PATCH /api/v1/signals            —— 默认更新库中最新一条
 * PATCH /api/v1/signals/:id        —— 更新指定 ID
 */
async function patchSignal(signal, id = null) {
  const clean = sanitize(signal);
  const path = id != null ? `/api/v1/signals/${encodeURIComponent(id)}` : '/api/v1/signals';
  return request('PATCH', path, { body: clean });
}

/**
 * GET /api/v1/signals
 */
async function listSignals({ symbol = '', limit = 10, offset = 0 } = {}) {
  const params = { limit, offset };
  if (symbol) params.symbol = symbol;
  return request('GET', '/api/v1/signals', { params });
}

/**
 * GET /api/v1/signals/:id
 */
async function getSignalDetail(id) {
  if (id == null) {
    const err = new Error('getSignalDetail: id 必填');
    err.code = 'AI_ANALYSIS_BAD_REQUEST';
    throw err;
  }
  return request('GET', `/api/v1/signals/${encodeURIComponent(id)}`, {});
}

function getConfig() {
  return { baseUrl: BASE_URL, timeout: TIMEOUT, enabled: ENABLED };
}

module.exports = {
  submitSignal,
  patchSignal,
  listSignals,
  getSignalDetail,
  getConfig,
  ALLOWED_FIELDS,
  sanitize,
};
