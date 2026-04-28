/**
 * ============================================================
 *  notifier/feishuWebhook.js
 *  飞书自定义机器人 Webhook 推送模块
 *
 *  特性：
 *  - 支持飞书自定义机器人签名校验（sha256 HMAC base64）
 *  - 支持 text / post（富文本）两种消息类型
 *  - 全局最小推送间隔 + 同类事件独立冷却，避免骚扰
 *  - 内部串行队列，不与 axios 并发争抢
 *  - 推送失败自动重试 2 次（指数退避 800ms / 1600ms）
 *  - 所有配置均可通过环境变量覆盖
 *
 *  环境变量：
 *    FEISHU_WEBHOOK_URL                 飞书群机器人 Webhook 地址
 *    FEISHU_WEBHOOK_SECRET              机器人签名密钥（可选；启用"签名校验"才需要）
 *    WEBHOOK_ENABLED                    "0" 关闭（默认开启）
 *    WEBHOOK_MIN_INTERVAL_MS            全局最小推送间隔，默认 30000（30s）
 *    WEBHOOK_EVENT_COOLDOWN_MS          同类事件冷却，默认 300000（5min）
 * ============================================================
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { httpAgent, httpsAgent } = require('../lib/httpAgents');

// ---------------------- 配置 ----------------------
const CFG = {
  url: process.env.FEISHU_WEBHOOK_URL || '',
  secret: process.env.FEISHU_WEBHOOK_SECRET || '',
  enabled: process.env.WEBHOOK_ENABLED !== '0',
  minIntervalMs: parseInt(process.env.WEBHOOK_MIN_INTERVAL_MS, 10) || 30 * 1000,
  eventCooldownMs: parseInt(process.env.WEBHOOK_EVENT_COOLDOWN_MS, 10) || 5 * 60 * 1000,
  timeoutMs: 10 * 1000,
};

// ---------------------- 节流状态 ----------------------
let lastSendAt = 0;
const lastEventAt = new Map(); // eventKey -> timestamp
let queue = Promise.resolve();
let queueDepth = 0;
const QUEUE_MAX_DEPTH = 30;

// ---------------------- 签名 ----------------------
/**
 * 飞书自定义机器人签名算法：
 *   stringToSign = `${timestamp}\n${secret}`
 *   sign = base64( HMAC-SHA256(stringToSign, "") )
 * 注意：key 为 stringToSign，data 为空字符串（官方规定）
 */
function genSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

// ---------------------- 节流判断 ----------------------
/**
 * @param {string} eventKey 事件类型，如 'regimeChange' / 'macdCross' / 'rsiZone'
 * @param {boolean} [force=false] 是否跳过节流
 */
function canSend(eventKey, force = false) {
  if (!CFG.enabled) return { ok: false, reason: 'webhook_disabled' };
  if (!CFG.url) return { ok: false, reason: 'no_webhook_url' };
  if (force) return { ok: true };

  const now = Date.now();
  if (now - lastSendAt < CFG.minIntervalMs) {
    return { ok: false, reason: 'global_throttle', waitMs: CFG.minIntervalMs - (now - lastSendAt) };
  }
  if (eventKey) {
    const last = lastEventAt.get(eventKey) || 0;
    if (now - last < CFG.eventCooldownMs) {
      return { ok: false, reason: 'event_cooldown', waitMs: CFG.eventCooldownMs - (now - last) };
    }
  }
  return { ok: true };
}

// ---------------------- 发送实现 ----------------------
async function doPost(payload, retry = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const resp = await axios.post(CFG.url, payload, {
        timeout: CFG.timeoutMs,
        headers: { 'Content-Type': 'application/json' },
        httpAgent, httpsAgent,
      });
      if (resp.data && (resp.data.StatusCode === 0 || resp.data.code === 0 || resp.data.msg === 'ok')) {
        return { ok: true };
      }
      // 业务错误
      lastErr = new Error(`[webhook biz] ${JSON.stringify(resp.data)}`);
      console.error('[webhook] 业务错误:', resp.data);
      // 19002 通常是 content 节点字段非法 — 打印 payload 摘要协助排查
      if (resp.data && resp.data.code === 19002 && attempt === 0) {
        try {
          const dbg = JSON.stringify(payload).slice(0, 500);
          console.error('[webhook] 🔧 payload 摘要 (前 500 字):', dbg);
        } catch (_) {}
      }
      // 19002 是参数错误, 重试也是 19002, 直接放弃
      if (resp.data && resp.data.code === 19002) return { ok: false, error: lastErr.message, skip: '19002_no_retry' };
    } catch (err) {
      lastErr = err;
      console.error(`[webhook] 第 ${attempt + 1} 次发送失败:`, err.response?.data || err.message);
    }
    if (attempt < retry) {
      await sleep(800 * (attempt + 1));
    }
  }
  return { ok: false, error: lastErr?.message };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 构造 payload（自动加签）
 * @param {'text'|'post'} msgType
 * @param {object} content
 */
function buildPayload(msgType, content) {
  const payload = { msg_type: msgType, content };
  if (CFG.secret) {
    const ts = Math.floor(Date.now() / 1000);
    payload.timestamp = String(ts);
    payload.sign = genSign(ts, CFG.secret);
  }
  return payload;
}

// ---------------------- 对外 API ----------------------
/**
 * 发送纯文本消息
 * @param {string} text
 * @param {object} [opt]
 * @param {string} [opt.eventKey]
 * @param {boolean} [opt.force]
 */
function sendText(text, opt = {}) {
  return enqueue(async () => {
    const gate = canSend(opt.eventKey, opt.force);
    if (!gate.ok) {
      console.log(`[webhook] 跳过(${gate.reason}):`, text.slice(0, 60));
      return { ok: false, skipped: gate.reason };
    }
    const payload = buildPayload('text', { text });
    const result = await doPost(payload);
    if (result.ok) markSent(opt.eventKey);
    return result;
  });
}

/**
 * 发送飞书 post 富文本消息
 *
 * ⚠️ 飞书 post 富文本(tag:'text')官方只支持 { tag, text, un_escape } 三个字段,
 *    传入 style/bold/italic 等未知字段会触发 19002 (params error, unknown content value).
 *    bold/italic 这里只做"语义保留", 真要排版请改用 interactive 卡片消息.
 *
 * @param {string} title
 * @param {Array<Array<{text:string, bold?:boolean, italic?:boolean, href?:string}>>} lines
 * @param {object} [opt]
 */
function sendRich(title, lines, opt = {}) {
  return enqueue(async () => {
    const gate = canSend(opt.eventKey, opt.force);
    if (!gate.ok) {
      console.log(`[webhook] 跳过(${gate.reason}):`, title);
      return { ok: false, skipped: gate.reason };
    }
    const safeTitle = String(title || '通知').slice(0, 200) || '通知';
    const safeLines = Array.isArray(lines) && lines.length ? lines : [[{ text: ' ' }]];

    const post_content = safeLines
      .map(line => {
        const segs = (Array.isArray(line) && line.length ? line : [{ text: ' ' }])
          .map(seg => {
            // a 链接节点
            if (seg && seg.href) {
              const text = String(seg.text ?? seg.href ?? ' ') || ' ';
              return { tag: 'a', text, href: String(seg.href) };
            }
            // 普通文本节点 — 只保留 tag + text, 严禁 style/bold/italic
            const text = String((seg && seg.text) ?? '') || ' ';
            return { tag: 'text', text };
          })
          .filter(Boolean);
        return segs.length ? segs : [{ tag: 'text', text: ' ' }];
      })
      .filter(arr => arr && arr.length);

    const payload = buildPayload('post', { post: { zh_cn: { title: safeTitle, content: post_content } } });
    const result = await doPost(payload);
    if (result.ok) markSent(opt.eventKey);
    return result;
  });
}

function markSent(eventKey) {
  const now = Date.now();
  lastSendAt = now;
  if (eventKey) lastEventAt.set(eventKey, now);
}

// 串行队列，避免并发风暴
function enqueue(fn) {
  if (queueDepth >= QUEUE_MAX_DEPTH) {
    console.warn(`[webhook] 队列溢出 (${queueDepth}), 丢弃本次消息`);
    return Promise.resolve({ ok: false, skipped: 'queue_overflow' });
  }
  queueDepth++;
  const p = queue.then(fn).catch(e => {
    console.error('[webhook] 队列异常:', e.message);
    return { ok: false, error: e.message };
  }).finally(() => { queueDepth--; });
  queue = p;
  return p;
}

// ---------------------- 状态查询 ----------------------
function getStatus() {
  return {
    enabled: CFG.enabled,
    hasUrl: !!CFG.url,
    hasSecret: !!CFG.secret,
    minIntervalMs: CFG.minIntervalMs,
    eventCooldownMs: CFG.eventCooldownMs,
    queueDepth,
    lastSendAt,
    lastEventAt: Object.fromEntries(lastEventAt),
  };
}

module.exports = {
  sendText,
  sendRich,
  canSend,
  getStatus,
  _config: CFG, // for tests
};
