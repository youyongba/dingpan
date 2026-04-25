/**
 * ============================================================
 *  trading/router.js
 *  自动平仓引擎 - Express 路由
 *
 *  对外接口：
 *    POST /api/auto-trade/signal      接收外部 webhook 入仓/平仓信号 (token 校验)
 *    POST /api/auto-trade/reset       手动重置 { direction:'long'|'short' } (鉴权)
 *    GET  /api/auto-trade/status      查询当前仓位 + WS 状态
 *    GET  /api/auto-trade/config      读取当前配置
 *    POST /api/auto-trade/config      局部更新配置 (鉴权)
 *
 *  鉴权：通过请求头 X-Auth-Token, 与 process.env.CONFIG_AUTH_TOKEN 比对
 * ============================================================
 */
'use strict';

const express = require('express');
const router = express.Router();

const config = require('./config');
const state = require('./state');
const priceFeed = require('./priceFeed');
const exec = require('./executor');

const ADMIN_TOKEN = process.env.CONFIG_AUTH_TOKEN || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'CONFIG_AUTH_TOKEN 未配置, 管理接口已禁用' });
  if (req.headers['x-auth-token'] !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: '鉴权失败' });
  next();
}

/** 解析 "1%" → 1, 1 → 1 */
function parsePercent(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/^([\d.]+)\s*%?$/);
  return m ? parseFloat(m[1]) : null;
}

/** 按模板算 TP/SL */
function calcLevels(direction, entryPrice) {
  const t = config.get().template;
  const seg = t[direction];
  if (t.mode !== 'percent' || !seg) return { tp1: null, tp2: null, tp3: null, sl: null };
  const sign = direction === 'long' ? 1 : -1;
  const pct = (n) => entryPrice * (1 + sign * (n / 100));
  return {
    tp1: pct(seg.tp1),
    tp2: pct(seg.tp2),
    tp3: pct(seg.tp3),
    sl: entryPrice * (1 - sign * (seg.sl / 100)),  // 反向
  };
}

// ============ POST /signal: 核心入口 ============
router.post('/signal', async (req, res) => {
  const cfg = config.get();
  const sig = req.body || {};

  // 1. token 校验
  if (!sig.token || sig.token !== cfg.token) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
  if (!cfg.enabled) {
    return res.status(503).json({ ok: false, error: 'auto_trade_disabled' });
  }

  const action = sig.action;

  // ===== 观望 =====
  if (action === 'wait') {
    exec.notify({ type: 'wait', title: '⏸ 观望信号已忽略', lines: [`symbol: ${sig.symbol || cfg.symbol}`] });
    return res.json({ ok: true, action: 'wait', skipped: true });
  }

  // ===== 开仓 =====
  if (action === 'open_long' || action === 'open_short') {
    const direction = action === 'open_long' ? 'long' : 'short';

    // 同方向锁定 → 拒绝
    const gate = state.canOpen(direction);
    if (!gate.ok) {
      exec.notify({
        type: 'open_blocked',
        title: `🚫 ${direction.toUpperCase()} 重复开仓被拦截`,
        lines: [
          `原因: ${gate.reason}`,
          `当前持仓入场价: ${gate.position?.entryPrice}`,
          `已触发 TP1=${gate.position?.tpHit?.tp1} TP2=${gate.position?.tpHit?.tp2}`,
        ],
      });
      // 关键：不影响反方向, 反方向可以正常开
      return res.status(409).json({ ok: false, error: gate.reason });
    }

    const entryPrice = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(entryPrice)) {
      return res.status(503).json({ ok: false, error: 'price_feed_not_ready' });
    }

    // 计算 TP/SL
    const lv = calcLevels(direction, entryPrice);

    // 登记仓位（locked = true）
    const pos = state.openPosition(direction, {
      entryPrice,
      entryAt: new Date().toISOString(),
      leverage: sig.leverage ?? cfg.defaultLeverage,
      positionSize: sig.position_size ?? cfg.defaultPositionSize,
      tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
      initialStopLoss: lv.sl,
      currentStopLoss: lv.sl,
      raw: sig,
    });

    // 转发开仓 webhook (异步, 不阻塞响应)
    exec.forwardOpen(sig).then((r) => {
      exec.notify({
        type: 'open_ok',
        title: `${direction === 'long' ? '🟢' : '🔴'} ${direction.toUpperCase()} 开仓成功`,
        lines: [
          `symbol: ${cfg.symbol}`,
          `入场价: ${entryPrice}`,
          `仓位: ${pos.positionSize} / 杠杆: ${pos.leverage}x`,
          `TP1: ${lv.tp1.toFixed(2)} (50%)`,
          `TP2: ${lv.tp2.toFixed(2)} (30%)`,
          `TP3: ${lv.tp3.toFixed(2)} (20%)`,
          `SL : ${lv.sl.toFixed(2)} (100%)`,
          `转发开仓 webhook: ${r.res.ok ? '✅ 已发送' : '❌ ' + (r.res.error || r.res.skipped)}`,
        ],
      });
    });

    return res.json({ ok: true, action, position: pos });
  }

  // ===== 外部直接发来的 take_profit / stop_loss =====
  // (一般是本系统 WS 自动触发, 但允许外部手动 trigger)
  if (action === 'take_profit' || action === 'stop_loss') {
    const direction = sig.direction;
    if (!['long', 'short'].includes(direction)) {
      return res.status(400).json({ ok: false, error: 'missing_direction' });
    }
    if (action === 'stop_loss') {
      const r = await exec.fireStopLoss(direction, { trigger: sig.trigger || 'sl' });
      state.closeAndUnlock(direction, sig.trigger || 'sl');
      exec.notify({
        type: 'sl',
        title: `🔻 ${direction.toUpperCase()} 外部触发止损 (100% 全平)`,
        lines: [`webhook: ${r.res.ok ? '✅' : '❌ ' + (r.res.error || '')}`],
        isAlert: true,
      });
      return res.json({ ok: true, ...r.res });
    }
    // take_profit
    const r = await exec.fireTakeProfit(direction, sig.trigger, {
      setProtectionSl: !!sig.set_protection_sl,
    });
    return res.json({ ok: true, ...r.res });
  }

  return res.status(400).json({ ok: false, error: `unknown_action: ${action}` });
});

// ============ POST /reset: 手动重置（解锁 + 取消所有 TP/SL） ============
router.post('/reset', requireAdmin, (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  const prev = state.manualReset(direction);
  exec.notify({
    type: 'reset',
    title: `🛠 ${direction.toUpperCase()} 已手动重置`,
    lines: [
      `已解锁开仓权限`,
      `已取消该方向全部待触发 TP1/TP2/TP3 与 SL`,
      `原入场价: ${prev?.entryPrice ?? '--'}`,
    ],
  });
  res.json({ ok: true, prev });
});

// ============ GET /status ============
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    enabled: config.get().enabled,
    symbol: config.get().symbol,
    priceFeed: priceFeed.getStatus(),
    positions: state.get(),
  });
});

// ============ POST /toggle: 一键开关自动交易 ============
// body: { enabled: true|false }
// 设计上不强制 X-Auth-Token, 只切换 enabled 一个布尔; 改其它字段仍走 /config
router.post('/toggle', (req, res) => {
  const next = !!(req.body && req.body.enabled);
  const updated = config.patch({ enabled: next });
  exec.notify({
    type: next ? 'unlock' : 'reset',
    title: next ? '✅ 自动交易已开启' : '⛔ 自动交易已关闭',
    lines: [
      next ? '系统将自动接收信号并执行 TP/SL/平仓 webhook' : '系统进入纯盯盘模式, 不再自动下单',
      '可在前端开关或 POST /api/auto-trade/toggle 切换',
    ],
  });
  res.json({ ok: true, enabled: updated.enabled });
});

// ============ GET /config ============
router.get('/config', (req, res) => {
  // 出于安全, token 不全量回显
  const c = config.get();
  res.json({ ok: true, config: { ...c, token: c.token ? c.token.slice(0, 8) + '***' : '' } });
});

// ============ POST /config ============
router.post('/config', requireAdmin, (req, res) => {
  const updated = config.patch(req.body || {});
  res.json({ ok: true, config: { ...updated, token: updated.token ? updated.token.slice(0, 8) + '***' : '' } });
});

module.exports = router;
