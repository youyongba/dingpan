/**
 * ============================================================
 *  notifier/telegram.js
 *  Telegram VIP 群组「交易信号」推送工具（独立、低侵入）
 *
 *  设计原则：
 *    1. 只负责发送，不持有任何业务状态；
 *    2. 完全异步、fire-and-forget，绝不阻塞主流程；
 *    3. 任何异常只打印日志，不向上抛出、不影响 Express 响应；
 *    4. 配置统一从 .env 读取；未配置时静默禁用，不报错；
 *    5. 只对外暴露通用 sendMessage(text) 与业务专用 sendTradeSignal(plan, regime)；
 *    6. 推送内容严格过滤，只保留【交易参数】，剔除指标解释等冗余字段。
 *
 *  环境变量：
 *    TELEGRAM_BOT_TOKEN       机器人 Token（BotFather 颁发）
 *    TELEGRAM_VIP_GROUP_ID    VIP 群 chat_id（超级群组以 -100 开头的负数）
 *    TELEGRAM_PUSH_ENABLED    "0" 关闭推送（默认开启）
 *    TELEGRAM_TIMEOUT_MS      请求超时，默认 8000ms
 * ============================================================
 */

'use strict';

const axios = require('axios');

// -------------------- 配置 --------------------
const TG_CFG = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_VIP_GROUP_ID || '',
  enabled: process.env.TELEGRAM_PUSH_ENABLED !== '0',
  timeoutMs: parseInt(process.env.TELEGRAM_TIMEOUT_MS, 10) || 8000,
};

const TG_API_BASE = 'https://api.telegram.org';

// 启动校验（仅打印一次警告，不抛错）
(function preflight() {
  if (!TG_CFG.enabled) {
    console.log('[telegram] 推送已禁用 (TELEGRAM_PUSH_ENABLED=0)');
    return;
  }
  if (!TG_CFG.token || !TG_CFG.chatId) {
    console.warn('[telegram] ⚠️  TELEGRAM_BOT_TOKEN / TELEGRAM_VIP_GROUP_ID 未配置，推送将被静默跳过');
  } else {
    console.log(`[telegram] 推送已就绪 (chat_id=${TG_CFG.chatId})`);
  }
})();

// -------------------- 工具函数 --------------------

/** HTML 转义，防止价格里的 < > & 破坏 Telegram HTML 解析 */
function escapeHTML(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 数字格式化，避免 toFixed 在 null/undefined 上抛错 */
function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '--';
  return Number(n).toFixed(d);
}

/** 当前时间字符串（本地时区，便于阅读） */
function nowStr() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

// -------------------- 通用发送 --------------------

/**
 * 通用消息发送（异步、不抛错）
 * @param {string} text          消息正文（建议使用 HTML 子集：<b> <i> <code> <pre>）
 * @param {object} [opt]
 * @param {'HTML'|'MarkdownV2'|null} [opt.parseMode='HTML']
 * @param {boolean} [opt.disablePreview=true]
 * @param {boolean} [opt.silent=false]   静默推送（不响铃）
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string}>}
 */
async function sendMessage(text, opt = {}) {
  if (!TG_CFG.enabled) return { ok: false, skipped: 'disabled' };
  if (!TG_CFG.token || !TG_CFG.chatId) return { ok: false, skipped: 'not_configured' };
  if (!text || typeof text !== 'string') return { ok: false, skipped: 'empty_text' };

  const url = `${TG_API_BASE}/bot${TG_CFG.token}/sendMessage`;
  const payload = {
    chat_id: TG_CFG.chatId,
    text,
    parse_mode: opt.parseMode === null ? undefined : (opt.parseMode || 'HTML'),
    disable_web_page_preview: opt.disablePreview !== false,
    disable_notification: !!opt.silent,
  };

  try {
    const resp = await axios.post(url, payload, {
      timeout: TG_CFG.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
    if (resp.data && resp.data.ok) return { ok: true };
    console.error('[telegram] 业务错误:', resp.data);
    return { ok: false, error: 'tg_biz_error' };
  } catch (err) {
    // 关键：只打印日志，不抛出，确保不影响主流程
    const detail = err.response?.data?.description || err.message || 'unknown';
    console.error('[telegram] 推送失败:', detail);
    return { ok: false, error: detail };
  }
}

/**
 * Fire-and-forget：完全不阻塞调用方
 * 用法：tg.fireAndForget(tg.sendTradeSignal(plan, regime))
 */
function fireAndForget(promise) {
  Promise.resolve(promise).catch(e => {
    console.error('[telegram] fireAndForget 兜底:', e?.message || e);
  });
}

// -------------------- 业务专用：交易信号 --------------------

/**
 * 推送【开仓 / 加仓 / 平仓】交易信号
 *
 * 严格过滤，只保留交易参数：方向 / 入场 / 止损 / TP / 仓位 / 置信度 / 当前价
 * 不带任何指标解释、Regime 描述等冗余字段。
 *
 * @param {object} plan   regimeModule.js 中 buildTradePlan 输出的对象
 * @param {object} [regime] 可选，仅用于在标题里附带方向标签
 * @param {object} [meta]   可选，附加上下文：{ symbol, eventType }
 *   - eventType: 'OPEN'(开仓) | 'CLOSE'(平仓/转观望) | 'UPDATE'(状态变化)
 */
async function sendTradeSignal(plan, regime, meta = {}) {
  if (!plan || typeof plan !== 'object') return { ok: false, skipped: 'no_plan' };

  const symbol = meta.symbol || 'BTCUSDT';
  const eventType = meta.eventType || (plan.ok ? 'OPEN' : 'CLOSE');

  // 平仓 / 转观望
  if (eventType === 'CLOSE' || !plan.ok) {
    const lines = [
      `🟡 <b>${escapeHTML(symbol)} 交易信号：观望</b>`,
      '',
      `📊 当前状态：信号结束 / 转观望`,
      plan && plan.currentPrice ? `💰 当前价：<code>${escapeHTML(fmt(plan.currentPrice))}</code>` : null,
      plan && plan.reason       ? `📝 原因：${escapeHTML(plan.reason)}` : null,
      '',
      `⏰ ${escapeHTML(nowStr())}`,
    ].filter(Boolean);
    return sendMessage(lines.join('\n'));
  }

  // 开仓 / 加仓
  const dir = plan.direction; // 'long' | 'short'
  const dirEmoji = dir === 'long' ? '🟢' : '🔴';
  const dirZh = dir === 'long' ? '做多 (LONG)' : '做空 (SHORT)';

  const tps = Array.isArray(plan.takeProfits) ? plan.takeProfits : [];
  const tpLines = tps.map(t =>
    `🎯 <b>${escapeHTML(t.level)}</b>: <code>${escapeHTML(fmt(t.price))}</code>` +
    `   (${escapeHTML(t.rr)} · +${escapeHTML(fmt(t.gainPct, 2))}% · 平${escapeHTML(t.closePct)}%)`
  );

  // 严格过滤：只保留交易参数
  const lines = [
    `${dirEmoji} <b>${escapeHTML(symbol)} 交易信号：${escapeHTML(dirZh)}</b>`,
    '',
    `💰 当前价：<code>${escapeHTML(fmt(plan.currentPrice))}</code>`,
    `🚪 入场价：<code>${escapeHTML(fmt(plan.entry))}</code>`,
    `🛡 止损价：<code>${escapeHTML(fmt(plan.stopLoss))}</code>   (-${escapeHTML(fmt(plan.riskPct, 2))}%)`,
    '',
    ...tpLines,
    '',
    `💼 建议仓位：<b>${escapeHTML(plan.suggestedPositionPct)}%</b>`,
    `🎖 置信度：<b>${escapeHTML(plan.confidenceLabel || '--')}</b>`,
    '',
    `⏰ ${escapeHTML(nowStr())}`,
  ];

  return sendMessage(lines.join('\n'));
}

// -------------------- 状态查询 / 自检 --------------------

function getStatus() {
  return {
    enabled: TG_CFG.enabled,
    hasToken: !!TG_CFG.token,
    hasChatId: !!TG_CFG.chatId,
    chatId: TG_CFG.chatId || null,
    timeoutMs: TG_CFG.timeoutMs,
  };
}

/** 启动自检：发一条 ping，仅在显式调用时执行 */
async function ping() {
  return sendMessage(`✅ <b>TG 推送通道自检</b>\n\n时间：${escapeHTML(nowStr())}`, { silent: true });
}

module.exports = {
  sendMessage,
  sendTradeSignal,
  fireAndForget,
  getStatus,
  ping,
};
