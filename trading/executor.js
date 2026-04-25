/**
 * ============================================================
 *  trading/executor.js
 *  自动平仓执行器
 *
 *  职责：
 *    1) 构造平仓 / 转发开仓 webhook payload
 *    2) POST 到 config.webhookUrl, 失败重试
 *    3) 调用通知层向飞书 + Telegram 同步推送结构化消息
 *
 *  与状态/风控解耦：本模块不更改任何 state, 由 riskEngine 调用
 * ============================================================
 */
'use strict';

const axios = require('axios');
const config = require('./config');

// 复用现有通知通道（懒引用避免循环依赖）
let _tg = null, _feishu = null;
function tg() { return _tg || (_tg = require('../notifier/telegram')); }
function feishu() {
  // server.js 注入的 notifier 是 (title, body, opts) 形式，但我们通过 axios 直接发送会更可靠；
  // 这里改为直接调用 feishuWebhook（如果用户配置了），同时保留 tg 通道。
  return _feishu || (_feishu = require('../notifier/feishuWebhook'));
}

// ---------------- 出站 webhook ----------------

async function postWebhook(payload, label = 'auto-trade') {
  const cfg = config.get();
  if (!cfg.webhookUrl) {
    console.warn(`[trade.executor] webhookUrl 未配置, 跳过 (${label})`);
    return { ok: false, skipped: 'no_url' };
  }
  const retry = cfg.webhookRetry ?? 2;
  let lastErr = null;
  for (let i = 0; i <= retry; i++) {
    try {
      const resp = await axios.post(cfg.webhookUrl, payload, {
        timeout: cfg.webhookTimeoutMs || 8000,
        headers: { 'Content-Type': 'application/json' },
      });
      console.log(`[trade.executor] ✅ ${label} 发送成功 status=${resp.status}`);
      return { ok: true, status: resp.status, data: resp.data };
    } catch (err) {
      lastErr = err;
      console.error(`[trade.executor] ❌ ${label} 第 ${i + 1} 次失败:`, err.response?.data || err.message);
    }
    if (i < retry) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return { ok: false, error: lastErr?.message };
}

// ---------------- payload 工厂（严格按用户模板） ----------------

function buildTpPayload(direction, level, closePercent, opts = {}) {
  const cfg = config.get();
  const payload = {
    token: cfg.token,
    action: 'take_profit',
    symbol: cfg.symbol,
    direction,
    close_percent: closePercent,
    order_type: 'market',
    trigger: level,                 // 'tp_1' | 'tp_2' | 'tp_3'
    timestamp: new Date().toISOString(),
  };
  if (opts.setProtectionSl) {
    payload.set_protection_sl = true;
    payload.protection_sl_price = 'entry_price';
    payload.protection_sl_order_type = 'market';
  }
  return payload;
}

function buildSlPayload(direction, trigger = 'sl') {
  const cfg = config.get();
  return {
    token: cfg.token,
    action: 'stop_loss',
    symbol: cfg.symbol,
    direction,
    close_percent: '100%',
    order_type: 'market',
    trigger,                                  // 'sl' 或 'sl_protection'
    timestamp: new Date().toISOString(),
  };
}

function buildOpenForwardPayload(rawSignal) {
  const cfg = config.get();
  // 用户模板里 open 信号本身就完整，直接转发
  // 如果原始信号缺失 leverage 或 position_size，自动补齐系统默认值
  return { 
    ...rawSignal, 
    leverage: rawSignal.leverage ?? cfg.defaultLeverage,
    position_size: rawSignal.position_size ?? cfg.defaultPositionSize,
    timestamp: rawSignal.timestamp || new Date().toISOString() 
  };
}

// ---------------- 触发动作（核心 API） ----------------

async function fireTakeProfit(direction, level, opts = {}) {
  const closePercent = ({ tp_1: '50%', tp_2: '30%', tp_3: '20%' })[level];
  const payload = buildTpPayload(direction, level, closePercent, opts);
  const res = await postWebhook(payload, `${direction.toUpperCase()} ${level}`);
  return { res, payload };
}

async function fireStopLoss(direction, opts = {}) {
  const payload = buildSlPayload(direction, opts.trigger || 'sl');
  const res = await postWebhook(payload, `${direction.toUpperCase()} SL`);
  return { res, payload };
}

async function forwardOpen(rawSignal) {
  const cfg = config.get();
  if (!cfg.forwardOpenOrders) {
    return { res: { ok: false, skipped: 'forward_open_disabled' }, payload: null };
  }
  const payload = buildOpenForwardPayload(rawSignal);
  const res = await postWebhook(payload, `${rawSignal.action}`);
  return { res, payload };
}

// ---------------- 通知整合（飞书 + TG） ----------------

/**
 * 业务事件统一推送（飞书富文本 + TG HTML）
 * @param {object} ev
 *   { type, title, lines: Array<string>, isAlert?: boolean }
 *   type: 'open_ok' | 'open_blocked' | 'wait' | 'tp' | 'sl' | 'reset' | 'unlock' | 'error'
 */
function notify(ev) {
  const cfg = config.get();
  const text = (ev.lines || []).join('\n');

  // 飞书：复用 feishuWebhook 富文本
  if (cfg.notify.feishu) {
    try {
      const richLines = (ev.lines || []).map(line => [{ text: String(line) }]);
      feishu().sendRich(ev.title, richLines, { eventKey: 'auto_trade_' + ev.type });
    } catch (e) {
      console.error('[trade.executor] 飞书推送异常:', e.message);
    }
  }

  // Telegram：HTML 格式
  if (cfg.notify.telegram) {
    try {
      const html = `<b>${escapeHTML(ev.title)}</b>\n\n${(ev.lines || []).map(escapeHTML).join('\n')}`;
      tg().fireAndForget(tg().sendMessage(html));
    } catch (e) {
      console.error('[trade.executor] TG 推送异常:', e.message);
    }
  }

  // 同时输出到日志, 调试期一目了然
  console.log(`[trade.notify] ${ev.title}\n  ${(ev.lines || []).join('\n  ')}`);
}

function escapeHTML(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  postWebhook,
  fireTakeProfit,
  fireStopLoss,
  forwardOpen,
  notify,
};
