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

let _tg = null, _feishu = null;
function tg() { return _tg || (_tg = require('../notifier/telegram')); }
function feishu() {
  return _feishu || (_feishu = require('../notifier/feishuWebhook'));
}

// ---------------- 出站 webhook ----------------

/**
 * 通用 HTTP POST.
 *
 * @param {object} payload
 * @param {string} label
 * @param {object} [opts]
 * @param {number} [opts.retry]      覆盖 cfg.webhookRetry, 开仓必须显式传 0
 * @param {number} [opts.timeoutMs]  覆盖 cfg.webhookTimeoutMs
 *
 * ⚠️ 开仓 (forwardOpen) 一律 retry=0:
 *   接收方多为"先下单后响应", 一旦客户端超时重试 = 重复下单.
 *   平仓 (TP/SL) 可保留默认重试: 即便重复触发, 服务端通常按"剩余仓位"幂等执行,
 *   最坏情况是少平 0% (已平), 不会扩大风险敞口.
 */
async function postWebhook(payload, label = 'auto-trade', opts = {}) {
  const cfg = config.get();
  if (!cfg.webhookUrl) {
    console.warn(`[trade.executor] webhookUrl 未配置, 跳过 (${label})`);
    return { ok: false, skipped: 'no_url' };
  }
  const retry = opts.retry != null ? opts.retry : (cfg.webhookRetry ?? 2);
  const timeout = opts.timeoutMs ?? cfg.webhookTimeoutMs ?? 15000;
  let lastErr = null;
  for (let i = 0; i <= retry; i++) {
    try {
      const resp = await axios.post(cfg.webhookUrl, payload, {
        timeout,
        headers: { 'Content-Type': 'application/json' },
      });
      console.log(`[trade.executor] ✅ ${label} 发送成功 status=${resp.status} (尝试 ${i + 1}/${retry + 1})`);
      return { ok: true, status: resp.status, data: resp.data, attempts: i + 1 };
    } catch (err) {
      lastErr = err;
      console.error(`[trade.executor] ❌ ${label} 第 ${i + 1}/${retry + 1} 次失败:`, err.response?.data || err.message);
    }
    if (i < retry) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return { ok: false, error: lastErr?.message, attempts: retry + 1 };
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
  return {
    ...rawSignal,
    leverage: rawSignal.leverage ?? cfg.defaultLeverage,
    position_size: rawSignal.position_size ?? cfg.defaultPositionSize,
    timestamp: rawSignal.timestamp || new Date().toISOString(),
  };
}

// ---------------- 触发动作（核心 API） ----------------

async function fireTakeProfit(direction, level, opts = {}) {
  const closePercent = ({ tp_1: '50%', tp_2: '30%', tp_3: '20%' })[level];
  const payload = buildTpPayload(direction, level, closePercent, opts);
  // ⚠️ 接收方非幂等 (同 payload 会重复下单), TP/SL 也必须 retry=0.
  // riskEngine 已先把 tpHit 写盘, 即便此次失败, 后续 tick 不会重复 fireTp.
  // 失败时飞书会告警, 用户人工去交易所核对.
  const res = await postWebhook(payload, `${direction.toUpperCase()} ${level}`, { retry: 0 });
  return { res, payload };
}

async function fireStopLoss(direction, opts = {}) {
  const payload = buildSlPayload(direction, opts.trigger || 'sl');
  const res = await postWebhook(payload, `${direction.toUpperCase()} SL`, { retry: 0 });
  return { res, payload };
}

// ---------------- 开仓冷却闸 (内存级双保险) ----------------
//
// state.canOpen 已经能阻止"内部已锁"的同方向二次开仓, 但它依赖 state 持久化文件
// 写盘成功且新进程启动时正确读盘. 本闸是冗余保护: 进程内, 同方向 forwardOpen
// 在 cfg.openForwardCooldownMs 内重复调用直接拒绝, 不会发出第二份 HTTP.
const _lastForwardAt = { open_long: 0, open_short: 0 };
let _testClock = null;
function _now() { return _testClock ? _testClock() : Date.now(); }
function __setTestClock(fn) { _testClock = fn || null; }      // 仅测试用
function __resetForwardCooldown() {                            // 仅测试用
  _lastForwardAt.open_long = 0;
  _lastForwardAt.open_short = 0;
}

async function forwardOpen(rawSignal) {
  const cfg = config.get();
  if (!cfg.forwardOpenOrders) {
    return { res: { ok: false, skipped: 'forward_open_disabled' }, payload: null };
  }

  const action = rawSignal.action;
  if (action === 'open_long' || action === 'open_short') {
    const cooldown = cfg.openForwardCooldownMs ?? 15000;
    const last = _lastForwardAt[action] || 0;
    const now = _now();
    if (last && now - last < cooldown) {
      const ageMs = now - last;
      console.warn(
        `[trade.executor] 🚧 ${action} 在冷却期被拦截 (距上次 ${ageMs}ms < ${cooldown}ms), 不发 webhook`
      );
      return {
        res: { ok: false, skipped: 'open_cooldown', cooldownAgeMs: ageMs },
        payload: null,
      };
    }
    _lastForwardAt[action] = now;
  }

  const payload = buildOpenForwardPayload(rawSignal);

  // ⚠️ 开仓必须 retry=0: 接收方"先下单后响应"模式下, 客户端超时重试 = 重复下单
  const res = await postWebhook(payload, action || 'open', { retry: 0 });
  return { res, payload };
}

// ---------------- 通知整合（仅飞书 + 日志） ----------------

/**
 * 业务事件统一推送
 *
 * ⚠️ 设计：trading 引擎内部所有事件 (开仓/止盈/止损/重置/WS/错误)
 *    只推送到 飞书 + 控制台日志, **不推 Telegram**.
 *    Telegram 通道仅由 regimeModule 用作"喊单"(tg.sendTradeSignal).
 *
 * 如需要把 trading 事件也发到 TG, 把 config.get().notify.telegram 设为 true,
 * 并在 .env 同时显式开启 TRADING_NOTIFY_TG=1
 *
 * @param {object} ev
 *   { type, title, lines: Array<string>, isAlert?: boolean }
 */
function notify(ev) {
  const cfg = config.get();

  // 飞书：复用 feishuWebhook 富文本
  if (cfg.notify.feishu) {
    try {
      const richLines = (ev.lines || []).map(line => [{ text: String(line) }]);
      feishu().sendRich(ev.title, richLines, { eventKey: 'auto_trade_' + ev.type });
    } catch (e) {
      console.error('[trade.executor] 飞书推送异常:', e.message);
    }
  }

  // Telegram：默认关闭, 只在显式打开时才推 (避免污染 VIP 群喊单)
  const tgAllowed = cfg.notify.telegram && process.env.TRADING_NOTIFY_TG === '1';
  if (tgAllowed) {
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

/**
 * 把出站 webhook payload 序列化成 notify lines, 直接发飞书核对.
 *
 *   📤 webhook payload (open_long):
 *   {
 *     "token": "...",
 *     "action": "open_long",
 *     ...
 *   }
 *
 * @param {string} label    标签, 如 'open_long' / 'tp_1' / 'sl'
 * @param {object} payload  实际 POST 给 webhookUrl 的 JSON 对象
 * @returns {string[]}      lines 数组, 调用方直接 spread 进 notify({lines})
 */
function formatPayloadLines(label, payload) {
  if (payload == null) return [`📤 webhook payload (${label}): <无, 该通道未启用或被跳过>`];
  let body;
  try {
    body = JSON.stringify(payload, null, 2);
  } catch (_) {
    body = String(payload);
  }
  return [`📤 webhook payload (${label}):`, ...body.split('\n')];
}

module.exports = {
  postWebhook,
  fireTakeProfit,
  fireStopLoss,
  forwardOpen,
  notify,
  formatPayloadLines,
  __setTestClock,
  __resetForwardCooldown,
};
