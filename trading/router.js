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

/** 按模板算 TP/SL (回退方案) */
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

/**
 * 拉取 regimeModule 最近一次 tradePlan 的 TP/SL/仓位
 * 注意：不返回 entry — 入场价由调用方用 WS lastPrice (市价立即成交)
 * @returns {null | {tp1, tp2, tp3, sl, positionSize, confidence, planEntry, source:'regime_plan'}}
 */
function planLevelsFromRegime(direction) {
  let getLatestPlan;
  try {
    ({ getLatestPlan } = require('../regimeModule'));
  } catch (_) {
    return null;
  }
  if (typeof getLatestPlan !== 'function') return null;

  const { tradePlan, updatedAt } = getLatestPlan() || {};
  if (!tradePlan || !tradePlan.ok) return null;
  if (tradePlan.direction !== direction) return null;
  const tps = Array.isArray(tradePlan.takeProfits) ? tradePlan.takeProfits : [];
  if (tps.length < 3) return null;

  // 时效性：5min 刷新, 30min 内视为有效
  const ageMs = updatedAt ? Date.now() - updatedAt : Infinity;
  if (ageMs > 30 * 60 * 1000) return null;

  return {
    // ↓ 不返回 entryPrice, 由调用方注入 WS 实时价 (市价开仓)
    planEntry: Number(tradePlan.entry),     // 仅做"理想入场价"展示, 不参与撮合
    tp1: Number(tps[0].price),
    tp2: Number(tps[1].price),
    tp3: Number(tps[2].price),
    sl: Number(tradePlan.stopLoss),
    positionSize: tradePlan.suggestedPositionPct + '%',
    confidence: tradePlan.confidenceLabel,
    planAgeSec: Math.round(ageMs / 1000),
    source: 'regime_plan',
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

    // ---- 入场价：始终用 WS 实时价 (市价立即成交, 不等回踩) ----
    const marketPrice = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(marketPrice)) {
      return res.status(503).json({ ok: false, error: 'price_feed_not_ready' });
    }

    // ---- TP/SL/仓位决策：优先用 regime plan, 否则回退 template ----
    const planLv = planLevelsFromRegime(direction);
    let entryPrice = marketPrice;
    let tp1, tp2, tp3, sl, positionSize, source, confidence, planAgeSec, planEntry;
    if (planLv) {
      // ✅ 与 TG 推送的 plan 完全一致（除 entry 外）
      ({ tp1, tp2, tp3, sl, positionSize, confidence, planAgeSec, planEntry } = planLv);
      source = 'regime_plan';
    } else {
      const lv = calcLevels(direction, entryPrice);
      tp1 = lv.tp1; tp2 = lv.tp2; tp3 = lv.tp3; sl = lv.sl;
      positionSize = sig.position_size ?? cfg.defaultPositionSize;
      source = 'template_fallback';
    }

    // 信号里如果显式带字段, 最高优先级
    if (sig.entry != null) entryPrice = Number(sig.entry);
    if (sig.stop_loss != null) sl = Number(sig.stop_loss);
    if (sig.tp1 != null) tp1 = Number(sig.tp1);
    if (sig.tp2 != null) tp2 = Number(sig.tp2);
    if (sig.tp3 != null) tp3 = Number(sig.tp3);
    if (sig.position_size != null) positionSize = sig.position_size;
    if (sig.entry != null || sig.stop_loss != null) source = 'signal_explicit';

    // ---- 数值健全性校验：止损/止盈方向必须正确 ----
    const isLong = direction === 'long';
    const slOk = isLong ? sl < entryPrice : sl > entryPrice;
    const tpOk = isLong
      ? (tp1 > entryPrice && tp2 > tp1 && tp3 > tp2)
      : (tp1 < entryPrice && tp2 < tp1 && tp3 < tp2);
    if (!slOk || !tpOk) {
      // 当前价已穿越 plan 区间, 直接拒绝, 避免一开仓就触发
      const reason = !slOk ? 'sl_wrong_side' : 'tp_wrong_order';
      exec.notify({
        type: 'open_blocked',
        title: `🚫 ${direction.toUpperCase()} 开仓被拦截 (${reason})`,
        lines: [
          `市价 ${entryPrice} 已偏离 plan 区间, 撮合后会立刻触发, 已拒绝`,
          `plan 入场价: ${planEntry ?? '--'} | sl: ${sl} | tp1: ${tp1}`,
          `建议: 等待下一根 K 线刷新 plan, 或检查 regime 信号方向`,
        ],
        isAlert: true,
      });
      return res.status(409).json({ ok: false, error: reason, marketPrice, sl, tp1, tp2, tp3, planEntry });
    }

    // 登记仓位（locked = true）
    const pos = state.openPosition(direction, {
      entryPrice,                  // 实际入场价（市价）
      planEntry: planEntry || null, // 理想入场价（plan 算的, 仅展示）
      entryAt: new Date().toISOString(),
      leverage: sig.leverage ?? cfg.defaultLeverage,
      positionSize,
      tp1, tp2, tp3,
      initialStopLoss: sl,
      currentStopLoss: sl,
      raw: sig,
      priceSource: source,
    });

    // 计算实际滑点（市价 vs plan 理想入场价）
    const slipPct = (planEntry && planEntry > 0)
      ? (((entryPrice - planEntry) / planEntry * 100) * (isLong ? 1 : -1)).toFixed(3)
      : null;

    const sourceZh = ({
      regime_plan: '✅ regime tradePlan (与 TG 推送一致)',
      template_fallback: '⚠️ 模板回退 (regime plan 不可用)',
      signal_explicit: '📝 外部信号显式指定',
    })[source] || source;
    exec.forwardOpen(sig).then((r) => {
      exec.notify({
        type: 'open_ok',
        title: `${direction === 'long' ? '🟢' : '🔴'} ${direction.toUpperCase()} 开仓成功 (市价)`,
        lines: [
          `symbol: ${cfg.symbol}`,
          `价位来源: ${sourceZh}` + (planAgeSec != null ? ` · plan 距今 ${planAgeSec}s` : ''),
          confidence ? `置信度: ${confidence}` : null,
          `市价入场: ${Number(entryPrice).toFixed(2)}`,
          planEntry ? `plan 理想入场: ${planEntry.toFixed(2)}${slipPct != null ? ` · 滑点 ${slipPct}%` : ''}` : null,
          `仓位: ${positionSize} / 杠杆: ${pos.leverage}x`,
          `TP1: ${tp1.toFixed(2)} (50%)`,
          `TP2: ${tp2.toFixed(2)} (30%)`,
          `TP3: ${tp3.toFixed(2)} (20%)`,
          `SL : ${sl.toFixed(2)} (100%)`,
          `转发开仓 webhook: ${r.res.ok ? '✅ 已发送' : '❌ ' + (r.res.error || r.res.skipped)}`,
        ].filter(Boolean),
      });
    });

    return res.json({ ok: true, action, position: pos, priceSource: source });
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
