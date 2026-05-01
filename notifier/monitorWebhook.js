/**
 * ============================================================
 *  notifier/monitorWebhook.js
 *  交易点位监控系统 webhook 推送通道 (与下单端 webhook 完全独立)
 *
 *  设计原则:
 *    1. 只负责发送, 不持有任何业务状态
 *    2. 完全异步、fire-and-forget, 绝不阻塞主流程
 *    3. 任何异常只打印日志, 不向上抛出, 不影响调用方
 *    4. 配置统一从 .env 读取; URL/Token 缺失则静默禁用
 *    5. 鉴权: HTTP Header `Authorization: Bearer <token>`
 *
 *  环境变量:
 *    MONITOR_OPEN_WEBHOOK_URL     挂单/开仓/TP/SL 触发使用 (POST 完整 payload)
 *    MONITOR_CANCEL_WEBHOOK_URL   取消挂单/一键全平使用 (POST {symbol, side})
 *    MONITOR_WEBHOOK_TOKEN        Bearer Token
 *    MONITOR_WEBHOOK_ENABLED      "0" 关闭 (默认开启)
 *    MONITOR_WEBHOOK_TIMEOUT_MS   单次超时 (默认 10000)
 *
 *  对外 API:
 *    sendOpen({symbol, side, entry, tp1, tp2, tp3, sl, comment})
 *    sendCancel({symbol, side})
 *    fireAndForget(promise)
 *    getStatus()
 *    ping()  仅在显式调用时发起自检
 * ============================================================
 */

'use strict';

const axios = require('axios');
const { httpAgent, httpsAgent } = require('../lib/httpAgents');

// -------------------- 配置 --------------------
const CFG = {
  openUrl: process.env.MONITOR_OPEN_WEBHOOK_URL || '',
  cancelUrl: process.env.MONITOR_CANCEL_WEBHOOK_URL || '',
  token: process.env.MONITOR_WEBHOOK_TOKEN || '',
  enabled: process.env.MONITOR_WEBHOOK_ENABLED !== '0',
  timeoutMs: parseInt(process.env.MONITOR_WEBHOOK_TIMEOUT_MS, 10) || 10000,
};

// 启动时一次性自检日志, 便于排查"为何没推送"
(function preflight() {
  if (!CFG.enabled) {
    console.log('[monitor-webhook] 推送已禁用 (MONITOR_WEBHOOK_ENABLED=0)');
    return;
  }
  if (!CFG.openUrl && !CFG.cancelUrl) {
    console.warn('[monitor-webhook] ⚠️ MONITOR_OPEN_WEBHOOK_URL / MONITOR_CANCEL_WEBHOOK_URL 均未配置, 推送将被静默跳过');
    return;
  }
  if (!CFG.token) {
    console.warn('[monitor-webhook] ⚠️ MONITOR_WEBHOOK_TOKEN 未配置, 仍会发送但 Authorization 头为空');
  }
  console.log(
    `[monitor-webhook] 已就绪 (open=${CFG.openUrl ? 'on' : 'off'}, cancel=${CFG.cancelUrl ? 'on' : 'off'}, token=${CFG.token ? 'on' : 'off'})`
  );
})();

// -------------------- 内部工具 --------------------

function authHeaders() {
  if (CFG.token) return { Authorization: `Bearer ${CFG.token}` };
  return {};
}

/** 安全数字: undefined/NaN → null, 防止 JSON 把 NaN 序列化成 null 时的歧义 */
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把 'long'/'short'/'LONG'/'SHORT' 一致化为大写 LONG/SHORT */
function normalizeSide(side) {
  if (side == null) return '';
  const s = String(side).toUpperCase();
  if (s === 'LONG' || s === 'SHORT') return s;
  if (s === 'BUY') return 'LONG';
  if (s === 'SELL') return 'SHORT';
  return s;
}

async function postJson(url, body, label) {
  if (!url) return { ok: false, skipped: 'no_url' };
  try {
    const resp = await axios.post(url, body, {
      timeout: CFG.timeoutMs,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      httpAgent, httpsAgent,
      // 一次性请求, 不需要 keepAlive 重用
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 300) {
      // 监控端可能返回任意 JSON, 只要 2xx 就视为成功; 不强制 ok 字段
      return { ok: true, status: resp.status, data: resp.data };
    }
    console.error(`[monitor-webhook] ❌ ${label} HTTP ${resp.status}:`, summarize(resp.data));
    return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
  } catch (err) {
    const detail = err.response?.data || err.message || 'unknown';
    console.error(`[monitor-webhook] ❌ ${label} 失败:`, summarize(detail));
    return { ok: false, error: err.message || 'unknown' };
  }
}

function summarize(o) {
  try {
    const s = typeof o === 'string' ? o : JSON.stringify(o);
    return s.length > 200 ? s.slice(0, 200) + '...' : s;
  } catch (_) {
    return String(o);
  }
}

// -------------------- 对外 API --------------------

/**
 * 推送"挂单/开仓/止盈/止损"事件 — 完整 payload.
 *
 * @param {object} info
 *   @param {string}        info.symbol     例 'BTCUSDT'
 *   @param {string}        info.side       'long'|'short'|'LONG'|'SHORT'
 *   @param {number}        info.entry      开仓/挂单价
 *   @param {number}        info.tp1
 *   @param {number}        info.tp2
 *   @param {number}        info.tp3
 *   @param {number}        info.sl
 *   @param {string}        [info.comment]  事件备注 (例 "TP1 触发", "1H 多头形态确认")
 * @returns {Promise<{ok:boolean, ...}>}
 */
async function sendOpen(info) {
  if (!CFG.enabled) return { ok: false, skipped: 'disabled' };
  if (!CFG.openUrl) return { ok: false, skipped: 'no_open_url' };
  if (!info || typeof info !== 'object') return { ok: false, skipped: 'bad_info' };
  const side = normalizeSide(info.side);
  if (side !== 'LONG' && side !== 'SHORT') return { ok: false, skipped: 'bad_side' };

  // 严格按用户给定的字段顺序与名称序列化, 不夹带额外字段, 防止下游解析容错弱
  const body = {
    symbol: String(info.symbol || 'BTCUSDT'),
    side,
    entry: num(info.entry),
    tp1: num(info.tp1),
    tp2: num(info.tp2),
    tp3: num(info.tp3),
    sl: num(info.sl),
    comment: String(info.comment || ''),
  };
  return postJson(CFG.openUrl, body, `open ${side}`);
}

/**
 * 推送"取消挂单/全平监控"事件 — 仅 symbol+side.
 *
 * @param {object} info
 *   @param {string} info.symbol
 *   @param {string} info.side  'long'|'short'|'LONG'|'SHORT'
 */
async function sendCancel(info) {
  if (!CFG.enabled) return { ok: false, skipped: 'disabled' };
  if (!CFG.cancelUrl) return { ok: false, skipped: 'no_cancel_url' };
  if (!info || typeof info !== 'object') return { ok: false, skipped: 'bad_info' };
  const side = normalizeSide(info.side);
  if (side !== 'LONG' && side !== 'SHORT') return { ok: false, skipped: 'bad_side' };

  const body = {
    symbol: String(info.symbol || 'BTCUSDT'),
    side,
  };
  return postJson(CFG.cancelUrl, body, `cancel ${side}`);
}

/**
 * Fire-and-forget 包装: 把 sendOpen/sendCancel 的 Promise 兜底, 防止未 await 时
 * 抛错导致 process unhandledRejection.
 *
 * 用法:
 *   monitor.fireAndForget(monitor.sendOpen({...}));
 */
function fireAndForget(promise) {
  Promise.resolve(promise).catch(e => {
    console.error('[monitor-webhook] fireAndForget 兜底:', e?.message || e);
  });
}

// -------------------- 状态查询 / 自检 --------------------

function getStatus() {
  return {
    enabled: CFG.enabled,
    hasOpenUrl: !!CFG.openUrl,
    hasCancelUrl: !!CFG.cancelUrl,
    hasToken: !!CFG.token,
    timeoutMs: CFG.timeoutMs,
  };
}

/** 启动自检 — 仅在显式调用时执行 (例如 /api/monitor/ping) */
async function ping() {
  // 用一个明显的"测试 payload"敲一下 open 接口; 监控端可识别 comment 跳过入库
  return sendOpen({
    symbol: 'BTCUSDT',
    side: 'LONG',
    entry: 0,
    tp1: 0,
    tp2: 0,
    tp3: 0,
    sl: 0,
    comment: '__ping__',
  });
}

module.exports = {
  sendOpen,
  sendCancel,
  fireAndForget,
  getStatus,
  ping,
  _config: CFG, // 测试可见
};
