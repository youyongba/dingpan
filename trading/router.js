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
 *
 *  对内 API:
 *    processSignal(sig, opts) - 同 /signal 路由的核心处理体, 供 regimeModule 等
 *                               in-process 模块直接调用, 无需绕 HTTP
 * ============================================================
 */
'use strict';

const express = require('express');
const router = express.Router();

const config = require('./config');
const state = require('./state');
const priceFeed = require('./priceFeed');
const exec = require('./executor');
// TG 渠道用于实际开仓成交通知 (与 regime 喊单 sendTradeSignal 互不冲突)
const tg = require('../notifier/telegram');
const { cnTime } = require('../lib/timeFmt');

const ADMIN_TOKEN = process.env.CONFIG_AUTH_TOKEN || '';

// pending 限价待触发模式: 默认开启.
//   1 (默认): open_long/open_short 信号 → 把 plan 价位写入 state.armPending,
//            riskEngine 监听价格触达 plan.entry 才推 forwardOpen webhook.
//   0       : 旧行为, 收到信号立即按市价 forwardOpen + openPosition.
//
// ⚠️ pending 不再有 30min TTL 自动取消 — 想清掉只能靠:
//      a) 价格触达 entry → fill
//      b) 反向信号 (FVG / 反向开仓信号)
//      c) 手动 POST /cancel-pending
const PENDING_MODE = process.env.AUTO_TRADE_PENDING_MODE !== '0';

// ========== 手动追单 / 手动开仓 回退方案常量 ==========
// 用户硬性需求:
//   - "手动追单"(一键立即): 不参考 regime, 仅用此回退方案
//   - "手动开仓"(挂单): 优先 regime, 没有 plan 时用此回退方案
//
// 校验:
//   - entry → TP1, entry → SL, TP1 → TP2, TP2 → TP3 每段都必须 0.5%~1.2%
//   - 仓位百分比固定 10%
//
// 全部从 .env 读取, 默认 1.0% (中位) 与 10% 仓位.
const MANUAL_FALLBACK_PCT_MIN = 0.5;
const MANUAL_FALLBACK_PCT_MAX = 1.2;
const MANUAL_FALLBACK_PCT = (() => {
  const raw = parseFloat(process.env.MANUAL_FALLBACK_PCT);
  if (!Number.isFinite(raw)) return 1.0;
  return raw;
})();
const MANUAL_FALLBACK_POSITION_PCT = (() => {
  const raw = parseFloat(process.env.MANUAL_FALLBACK_POSITION_PCT);
  if (!Number.isFinite(raw)) return 10;
  return raw;
})();

if (MANUAL_FALLBACK_PCT < MANUAL_FALLBACK_PCT_MIN || MANUAL_FALLBACK_PCT > MANUAL_FALLBACK_PCT_MAX) {
  console.warn(
    `[trade.router] ⚠️ MANUAL_FALLBACK_PCT=${MANUAL_FALLBACK_PCT} 超出 ${MANUAL_FALLBACK_PCT_MIN}~${MANUAL_FALLBACK_PCT_MAX}% 区间, 手动追单/手动开仓回退方案会拒绝下单 — 请修正 .env 后重启`
  );
}

/**
 * 按用户硬性约束, 基于 entryPrice 与统一百分比 p, 推导 TP1/TP2/TP3/SL.
 *
 * 多头 (long, sign=+1):
 *   tp1 = entry * (1 + p)
 *   tp2 = tp1   * (1 + p)
 *   tp3 = tp2   * (1 + p)
 *   sl  = entry * (1 - p)
 * 空头镜像.
 *
 * @param {'long'|'short'} direction
 * @param {number} entryPrice
 * @param {number} [pct]   单位 %, 默认 MANUAL_FALLBACK_PCT, 必须落在 0.5~1.2
 * @returns {{tp1, tp2, tp3, sl, pct}}
 * @throws Error 当 pct 非法 / entryPrice 非法时
 */
function computeManualFallbackLevels(direction, entryPrice, pct) {
  const p = pct == null ? MANUAL_FALLBACK_PCT : pct;
  if (!Number.isFinite(p) || p < MANUAL_FALLBACK_PCT_MIN || p > MANUAL_FALLBACK_PCT_MAX) {
    throw new Error(
      `MANUAL_FALLBACK_PCT 必须在 ${MANUAL_FALLBACK_PCT_MIN}~${MANUAL_FALLBACK_PCT_MAX} 之间, 当前=${p}`
    );
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`invalid_entry_price: ${entryPrice}`);
  }
  const sign = direction === 'long' ? 1 : -1;
  const factor = p / 100;
  // 几何级数: TP_n = entry * (1 + sign*p)^n  (long), 空头镜像
  const tp1 = entryPrice * (1 + sign * factor);
  const tp2 = tp1 * (1 + sign * factor);
  const tp3 = tp2 * (1 + sign * factor);
  const sl = entryPrice * (1 - sign * factor);
  // 数值精度: 与 regimeModule 保持一致, 保留 2 位小数 (USDT 永续合约通常 0.1 价位即可)
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    tp1: round2(tp1),
    tp2: round2(tp2),
    tp3: round2(tp3),
    sl: round2(sl),
    pct: p,
  };
}

/**
 * 校验一组 entry/TP/SL 是否满足"每段距离都在 0.5%~1.2%"的硬性约束.
 *
 * 使用场景:
 *   - 手动追单 / 手动开仓回退方案下单前 (双保险, 即便 .env 被改动也兜得住)
 *   - 也可让前端校验自定义价位
 *
 * @returns {{ok:boolean, reason?:string, segments?:Array<{name,pct}>}}
 */
function validateManualLevels(direction, entry, tp1, tp2, tp3, sl) {
  const isLong = direction === 'long';
  const safe = (v) => Number.isFinite(Number(v));
  if (![entry, tp1, tp2, tp3, sl].every(safe)) {
    return { ok: false, reason: 'non_numeric_levels' };
  }
  // 方向校验: 多头 tp 升序大于 entry, sl 低于 entry; 空头反之
  if (isLong) {
    if (!(tp1 > entry && tp2 > tp1 && tp3 > tp2)) return { ok: false, reason: 'tp_wrong_order' };
    if (!(sl < entry)) return { ok: false, reason: 'sl_wrong_side' };
  } else {
    if (!(tp1 < entry && tp2 < tp1 && tp3 < tp2)) return { ok: false, reason: 'tp_wrong_order' };
    if (!(sl > entry)) return { ok: false, reason: 'sl_wrong_side' };
  }
  // 每段距离百分比 (取绝对值, 相对前一档)
  const seg = [
    { name: 'entry-TP1', from: entry, to: tp1 },
    { name: 'TP1-TP2', from: tp1, to: tp2 },
    { name: 'TP2-TP3', from: tp2, to: tp3 },
    { name: 'entry-SL', from: entry, to: sl },
  ].map(s => ({ ...s, pct: Math.abs((s.to - s.from) / s.from) * 100 }));

  const bad = seg.find(s =>
    s.pct < MANUAL_FALLBACK_PCT_MIN - 1e-9 || s.pct > MANUAL_FALLBACK_PCT_MAX + 1e-9
  );
  if (bad) {
    return {
      ok: false,
      reason: `segment_out_of_range:${bad.name}=${bad.pct.toFixed(3)}%`,
      segments: seg,
    };
  }
  return { ok: true, segments: seg };
}

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
    sl: entryPrice * (1 - sign * (seg.sl / 100)),
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

  const ageMs = updatedAt ? Date.now() - updatedAt : Infinity;
  if (ageMs > 30 * 60 * 1000) return null;

  return {
    planEntry: Number(tradePlan.entry),
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

/**
 * 处理一条 trading 信号 (开仓 / 平仓 / 止盈)
 *
 * 抽出为独立函数, 便于:
 *   1) Express 路由 POST /signal 直接复用
 *   2) regimeModule 在生成 LONG/SHORT plan 时直接 in-process 调用,
 *      无需绕 HTTP, 无需配置端口, 也避免 listen 顺序问题
 *
 * @param {object} sig         信号 payload (与外部 webhook 入参完全一致)
 * @param {object} [opts]
 * @param {string} [opts.source='external']         调用来源标记, 仅用于日志/通知排查
 * @param {boolean} [opts.skipRegimePlan=false]     跳过 regime tradePlan 查询 (手动追单专用)
 * @returns {Promise<{status:number, body:object}>}
 */
async function processSignal(sig, opts = {}) {
  const cfg = config.get();
  sig = sig || {};
  const callerSource = opts.source || 'external';
  const skipRegimePlan = !!opts.skipRegimePlan;
  // 手动 UI 来源 (manual_ui / manual_follow) 时, 在挂单/成交后顺手推 TG;
  // regime 自动 / 外部 webhook 不重复推 (regime 自身 handleNotificationsOnSuccess 已 sendTradeSignal).
  const isManualCaller = callerSource === 'manual_ui' || callerSource === 'manual_follow';

  if (!sig.token || sig.token !== cfg.token) {
    return { status: 401, body: { ok: false, error: 'invalid_token' } };
  }
  if (!cfg.enabled) {
    return { status: 503, body: { ok: false, error: 'auto_trade_disabled' } };
  }

  const action = sig.action;

  if (action === 'wait') {
    exec.notify({
      type: 'wait',
      title: '⏸ 观望信号已忽略',
      lines: [`symbol: ${sig.symbol || cfg.symbol}`, `来源: ${callerSource}`],
    });
    return { status: 200, body: { ok: true, action: 'wait', skipped: true } };
  }

  if (action === 'open_long' || action === 'open_short') {
    const direction = action === 'open_long' ? 'long' : 'short';

    const gate = state.canOpen(direction);
    if (!gate.ok) {
      exec.notify({
        type: 'open_blocked',
        title: `🚫 ${direction.toUpperCase()} 重复开仓被拦截 (${gate.reason})`,
        lines: [
          `来源: ${callerSource}`,
          `原因: ${gate.reason}`,
          gate.position?.pending
            ? `已有 pending 计划 entry=${gate.position?.pendingPlan?.entry} (不会自动过期, 需手动取消)`
            : `当前持仓入场价: ${gate.position?.entryPrice}`,
          `已触发 TP1=${gate.position?.tpHit?.tp1} TP2=${gate.position?.tpHit?.tp2}`,
          gate.position?.pending ? '如需重新挂单, 请先 POST /api/auto-trade/cancel-pending' : null,
        ].filter(Boolean),
      });
      return { status: 409, body: { ok: false, error: gate.reason, position: gate.position } };
    }

    const marketPrice = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(marketPrice)) {
      return { status: 503, body: { ok: false, error: 'price_feed_not_ready' } };
    }

    const planLv = skipRegimePlan ? null : planLevelsFromRegime(direction);
    let entryPrice = marketPrice;
    let tp1, tp2, tp3, sl, positionSize, source, confidence, planAgeSec, planEntry;
    if (planLv) {
      ({ tp1, tp2, tp3, sl, positionSize, confidence, planAgeSec, planEntry } = planLv);
      entryPrice = planEntry;       // pending 模式下 entry 就是 plan.entry, 不再是当下市价
      source = 'regime_plan';
    } else {
      const lv = calcLevels(direction, entryPrice);
      tp1 = lv.tp1; tp2 = lv.tp2; tp3 = lv.tp3; sl = lv.sl;
      positionSize = sig.position_size ?? cfg.defaultPositionSize;
      source = 'template_fallback';
    }

    if (sig.entry != null) { entryPrice = Number(sig.entry); planEntry = entryPrice; }
    if (sig.stop_loss != null) sl = Number(sig.stop_loss);
    if (sig.tp1 != null) tp1 = Number(sig.tp1);
    if (sig.tp2 != null) tp2 = Number(sig.tp2);
    if (sig.tp3 != null) tp3 = Number(sig.tp3);
    if (sig.position_size != null) positionSize = sig.position_size;
    if (sig.entry != null || sig.stop_loss != null) source = 'signal_explicit';
    // 手动追单 / 手动开仓回退方案显式标记, 便于 UI/TG/飞书 区分价位来源
    if (sig._priceSource) source = sig._priceSource;

    const isLong = direction === 'long';
    const slOk = isLong ? sl < entryPrice : sl > entryPrice;
    const tpOk = isLong
      ? (tp1 > entryPrice && tp2 > tp1 && tp3 > tp2)
      : (tp1 < entryPrice && tp2 < tp1 && tp3 < tp2);
    if (!slOk || !tpOk) {
      const reason = !slOk ? 'sl_wrong_side' : 'tp_wrong_order';
      exec.notify({
        type: 'open_blocked',
        title: `🚫 ${direction.toUpperCase()} 开仓被拦截 (${reason})`,
        lines: [
          `来源: ${callerSource}`,
          `entry ${entryPrice} 与 sl/tp 关系不合法, 已拒绝`,
          `plan 入场价: ${planEntry ?? '--'} | sl: ${sl} | tp1: ${tp1}`,
          `建议: 等待下一根 K 线刷新 plan, 或检查 regime 信号方向`,
        ],
        isAlert: true,
      });
      return {
        status: 409,
        body: { ok: false, error: reason, marketPrice, sl, tp1, tp2, tp3, planEntry },
      };
    }

    const sourceZh = (() => {
      if (source === 'regime_plan') return '✅ regime tradePlan (与 TG 推送一致)';
      if (source === 'template_fallback') return '⚠️ 模板回退 (regime plan 不可用)';
      if (source === 'manual_fallback') return `🛠 手动回退方案 (±${MANUAL_FALLBACK_PCT}% / ${MANUAL_FALLBACK_POSITION_PCT}%仓)`;
      if (source === 'signal_explicit') {
        return callerSource === 'regime'
          ? '✅ regime 喊单锁定价位 (TG 推送时定格)'
          : '📝 外部信号显式指定';
      }
      return source;
    })();

    // ============ 分支: pending (限价待触发) vs immediate (立即市价) ============
    // pending 模式 (默认): 把 plan.entry/SL/TP 落到 state.armPending,
    // 由 riskEngine 监听价格触达 entry 时再 fill.
    // immediate 模式: 旧行为, 立即按市价 forwardOpen + openPosition.
    // sig.market === true 可单条信号强制立即, 兜底紧急情况.
    const wantImmediate = !PENDING_MODE || sig.market === true || sig.immediate === true;

    if (!wantImmediate) {
      // pending 模式: 校验当下市价是否已穿透 entry — 穿透说明信号晚了, 用 immediate fallback
      const alreadyTouched = isLong ? marketPrice <= entryPrice : marketPrice >= entryPrice;
      if (alreadyTouched) {
        // 价格已经在 entry 那一侧, 走立即 fill 路径 (riskEngine 下一 tick 就会触发,
        // 这里直接 arm pending 即可, 不做特殊处理 — riskEngine 会立刻 fill)
        // 设计上保持简单: arm pending, 让 riskEngine 处理.
      }

      const pos = state.armPending(direction, {
        entry: entryPrice,
        sl, tp1, tp2, tp3,
        positionSize,
        leverage: sig.leverage ?? cfg.defaultLeverage,
        source,
        confidence: confidence || null,
        planEntry: planEntry || null,
        planAgeSec: planAgeSec || null,
        callerSource,
        raw: sig,
      });

      exec.notify({
        type: 'pending_armed',
        title: `📋 ${direction.toUpperCase()} 开仓计划已锁定 (待价回踩 entry)`,
        lines: [
          `symbol: ${cfg.symbol}`,
          `信号来源: ${callerSource}`,
          `价位来源: ${sourceZh}` + (planAgeSec != null ? ` · plan 距今 ${planAgeSec}s` : ''),
          confidence ? `置信度: ${confidence}` : null,
          `📍 当下市价: ${marketPrice.toFixed(2)}`,
          `🚪 待触发 entry: ${Number(entryPrice).toFixed(2)} ${alreadyTouched ? '(⚡ 已穿透, 下一 tick 立即 fill)' : ''}`,
          `仓位: ${positionSize} / 杠杆: ${pos.pendingPlan.leverage}x`,
          `TP1: ${tp1.toFixed(2)} (50%) · TP2: ${tp2.toFixed(2)} (30%) · TP3: ${tp3.toFixed(2)} (20%)`,
          `SL : ${sl.toFixed(2)} (100%)`,
          `⏳ 不会自动过期, 等待价格触达 entry 或反向信号`,
          `❎ 取消挂单: POST /api/auto-trade/cancel-pending {"direction":"${direction}"}`,
        ].filter(Boolean),
      });

      // ========== 推送到「交易点位监控系统」(挂单 = 完整 payload) ==========
      // 用户硬性要求: 自动/手动/手动追单 的开仓 与 TP1-3 / SL 都要推这个独立通道
      exec.fireMonitorOpen({
        direction, entry: entryPrice, tp1, tp2, tp3, sl,
        comment: `挂单待触发 · ${callerSource} · ${source}`,
      });

      // ========== 手动来源 → TG 推送限价挂单已锁定 (regime 自身已 sendTradeSignal, 不重复) ==========
      if (isManualCaller) {
        tg.fireAndForget(tg.sendOpenArmed({
          direction,
          symbol: cfg.symbol,
          entry: entryPrice,
          currentPrice: marketPrice,
          tp1, tp2, tp3,
          stopLoss: sl,
          positionSize,
          leverage: pos.pendingPlan.leverage,
          priceSource: source,
          callerSource,
        }));
      }

      return { status: 200, body: { ok: true, action, mode: 'pending', position: pos, priceSource: source } };
    }

    // ============ immediate 模式 (旧行为, 完整保留) ============
    // 此模式下 entry 用当下市价, 立即推 forwardOpen webhook + 写 active 仓位.
    if (source === 'regime_plan') entryPrice = marketPrice;  // immediate 走市价

    const pos = state.openPosition(direction, {
      entryPrice,
      planEntry: planEntry || null,
      entryAt: new Date().toISOString(),
      leverage: sig.leverage ?? cfg.defaultLeverage,
      positionSize,
      tp1, tp2, tp3,
      initialStopLoss: sl,
      currentStopLoss: sl,
      raw: sig,
      priceSource: source,
    });

    const slipPct = (planEntry && planEntry > 0)
      ? (((entryPrice - planEntry) / planEntry * 100) * (isLong ? 1 : -1)).toFixed(3)
      : null;

    // ========== 推送到「交易点位监控系统」(立即开仓 = 完整 payload) ==========
    // 不等 forwardOpen 完成, 第一时间通知监控端登记点位 — 即便下单端 webhook 失败,
    // 监控端也能拿到一份"我们以为已开仓"的快照, 便于人工核对.
    exec.fireMonitorOpen({
      direction, entry: entryPrice, tp1, tp2, tp3, sl,
      comment: `市价开仓 · ${callerSource} · ${source}`,
    });

    exec.forwardOpen(sig).then((r) => {
      exec.notify({
        type: 'open_ok',
        title: `${direction === 'long' ? '🟢' : '🔴'} ${direction.toUpperCase()} 开仓成功 (市价 immediate)`,
        lines: [
          `symbol: ${cfg.symbol}`,
          `信号来源: ${callerSource}`,
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
          ...exec.formatPayloadLines(action, r.payload),
        ].filter(Boolean),
      });

      // 实际开仓 → 同步推送 TG (与 regime 喊单 sendTradeSignal 区分: 这条是真成交了)
      tg.fireAndForget(tg.sendOpenFilled({
        direction,
        symbol: cfg.symbol,
        mode: 'immediate',
        entryPrice,
        plannedEntry: planEntry || null,
        fillPrice: entryPrice,         // immediate 模式 entry 就是市价
        tp1, tp2, tp3,
        stopLoss: sl,
        positionSize,
        leverage: pos.leverage,
        tp1Protection: cfg.tp1Protection !== false,
        priceSource: source,
        webhookOk: r.res.ok,
      }));
    });

    return { status: 200, body: { ok: true, action, mode: 'immediate', position: pos, priceSource: source } };
  }

  if (action === 'take_profit' || action === 'stop_loss') {
    const direction = sig.direction;
    if (!['long', 'short'].includes(direction)) {
      return { status: 400, body: { ok: false, error: 'missing_direction' } };
    }
    // 抓取触发前的快照, 用于推送监控 webhook + 通知 (close/markTp 后 state 会被改写)
    const pBefore = state.getPosition(direction);
    if (!pBefore || !pBefore.active) {
      // 关键幂等防线: 仓位未 active = 不可能再 close/take-profit. 拒绝外部重复请求,
      // 否则会出现"内部 riskEngine 已 fire SL → 外部又来一次 stop_loss" 双发 webhook 的事故.
      return { status: 409, body: { ok: false, error: 'no_active_position', direction } };
    }

    if (action === 'stop_loss') {
      // ⚠️ 与 riskEngine.fireSl 共享同一把幂等锁 (state.closeAndUnlock):
      // 第一次调用 → 写盘成功返回 closed snapshot, 后续任何重复请求 / 内部 fire 都返回 null.
      // 必须**先写盘 (closeAndUnlock) 再发 webhook**, 顺序与 riskEngine 一致.
      const closed = state.closeAndUnlock(direction, sig.trigger || 'sl');
      if (!closed) {
        return { status: 409, body: { ok: false, error: 'already_closed', direction } };
      }
      const r = await exec.fireStopLoss(direction, { trigger: sig.trigger || 'sl' });
      exec.notify({
        type: 'sl',
        title: `🔻 ${direction.toUpperCase()} 外部触发止损 (100% 全平)`,
        lines: [
          `来源: ${callerSource}`,
          `webhook: ${r.res.ok ? '✅' : '❌ ' + (r.res.error || '')}`,
          ...exec.formatPayloadLines(sig.trigger || 'sl', r.payload),
        ],
        isAlert: true,
      });
      if (Number.isFinite(pBefore.entryPrice)) {
        exec.fireMonitorOpen({
          direction,
          entry: pBefore.entryPrice,
          tp1: pBefore.tp1, tp2: pBefore.tp2, tp3: pBefore.tp3,
          sl: pBefore.currentStopLoss,
          comment: `SL 触发 · external · ${sig.trigger || 'sl'}`,
        });
      }
      return { status: 200, body: { ok: true, ...r.res } };
    }

    // ===== action === 'take_profit' =====
    const lvl = sig.trigger || 'tp';
    const tpKey = lvl === 'tp_1' ? 'tp1' : lvl === 'tp_2' ? 'tp2' : lvl === 'tp_3' ? 'tp3' : null;
    if (!tpKey) {
      return { status: 400, body: { ok: false, error: `invalid_trigger: ${lvl}` } };
    }
    const setProt = !!sig.set_protection_sl;
    const newSl = setProt ? pBefore.entryPrice : undefined;
    // ⚠️ 与 riskEngine.fireTp 共享同一把幂等锁 (state.markTpHit):
    // 第一次调用 → 写盘成功返回更新后 position; 重复请求 / 内部 fire / 不同入口 race
    // 都返回 null, 此时直接拒绝, 不发 webhook / 不发通知 / 不推监控.
    const marked = state.markTpHit(direction, tpKey, { newStopLoss: newSl, armProtection: setProt });
    if (!marked) {
      return { status: 409, body: { ok: false, error: `${tpKey}_already_fired`, direction } };
    }
    const r = await exec.fireTakeProfit(direction, lvl, { setProtectionSl: setProt });
    exec.notify({
      type: 'tp',
      title: `📤 ${direction.toUpperCase()} 外部触发止盈 (${lvl})`,
      lines: [
        `来源: ${callerSource}`,
        `webhook: ${r.res.ok ? '✅' : '❌ ' + (r.res.error || '')}`,
        ...exec.formatPayloadLines(lvl, r.payload),
      ],
    });
    if (Number.isFinite(pBefore.entryPrice)) {
      exec.fireMonitorOpen({
        direction,
        entry: pBefore.entryPrice,
        tp1: pBefore.tp1, tp2: pBefore.tp2, tp3: pBefore.tp3,
        sl: setProt ? pBefore.entryPrice : pBefore.currentStopLoss,
        comment: `${String(lvl).toUpperCase()} 触发 · external` + (setProt ? ' · 保本止损已上移' : ''),
      });
    }
    // TP3 后由 closeAndUnlock 解锁
    if (lvl === 'tp_3') {
      const closed3 = state.closeAndUnlock(direction, 'tp_3');
      if (closed3) {
        exec.notify({
          type: 'unlock',
          title: `🔓 ${direction.toUpperCase()} 已自动解锁 (外部触发 TP3)`,
          lines: [`方向 ${direction} 现可重新接收开仓信号`],
        });
      }
    }
    return { status: 200, body: { ok: true, ...r.res } };
  }

  return { status: 400, body: { ok: false, error: `unknown_action: ${action}` } };
}

// ============ POST /signal: 核心入口 ============
router.post('/signal', async (req, res) => {
  const r = await processSignal(req.body || {}, { source: 'http' });
  res.status(r.status).json(r.body);
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
  const cfg = config.get();
  res.json({
    ok: true,
    enabled: cfg.enabled,
    symbol: cfg.symbol,
    pendingMode: PENDING_MODE,
    // 暴露给前端: TP1 保本止损是否开启 (用户可点击切换 → POST /config { tp1Protection })
    tp1Protection: cfg.tp1Protection !== false,
    priceFeed: priceFeed.getStatus(),
    positions: state.get(),
  });
});

// ============ GET /price-stream (SSE 实时价格流) ============
//
// 把 priceFeed (Binance WS aggTrade) 的 tick 通过 Server-Sent Events 实时下发给浏览器,
// 取代前端 5s 轮询 /status 才刷新一次价格的体验. 数据源仍是同一 priceFeed 单例,
// 不会创建新的 Binance WS 连接, 也与现有 /status 接口完全独立 — 不影响任何调用方.
//
// 协议:
//   event: snapshot     连接成功后立即下发一次完整状态 (与 /status.priceFeed 一致)
//   event: tick         每个 (节流后) tick 下发一次最新状态
//   event: feed_open    底层 WS 重连成功
//   event: feed_close   底层 WS 关闭
//   event: feed_error   底层 WS 报错
//   :heartbeat <ts>     SSE 注释行心跳, 防代理 idle 断流; 浏览器 EventSource 自动忽略
//
// 节流:
//   PRICE_STREAM_THROTTLE_MS 控制下发频率 (默认 200ms ≈ 5fps), 既保留实时观感
//   又避免 BTC 剧烈波动期 aggTrade 一秒 200~500 帧把 DOM/带宽打爆.
//   注意 priceFeed.lastPrice 始终是最新值, 节流只是合并 emit 频率.
//
// 多客户端组播:
//   所有 SSE 客户端共享同一组 priceFeed 监听器 (通过 sseClients Set 组播),
//   避免每开一个浏览器 tab 就给 priceFeed 加 4 条监听器, 触发 MaxListenersExceededWarning.
//
// 鉴权:
//   与 /status 一致: 不需要 token. 只读流, 不下单, 不暴露任何敏感字段.
const PRICE_STREAM_THROTTLE_MS = parseInt(process.env.PRICE_STREAM_THROTTLE_MS, 10) || 200;
const PRICE_STREAM_HEARTBEAT_MS = 15 * 1000;
const sseClients = new Set();
let sseListenersInstalled = false;

function _installSseListeners() {
  if (sseListenersInstalled) return;
  sseListenersInstalled = true;

  // 节流广播 — "取最新价"模式: 任何 tick 进来都只更新计时器,
  // 到点后从 priceFeed.getStatus() 取一次最新快照广播
  let lastBroadcastAt = 0;
  let pendingTimer = null;

  const broadcast = (event, payload) => {
    if (sseClients.size === 0) return; // 无客户端时不序列化, 省 CPU
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch (_) { /* 客户端中途崩了, cleanup 会移除 */ }
    }
  };

  const broadcastTick = () => {
    pendingTimer = null;
    lastBroadcastAt = Date.now();
    broadcast('tick', priceFeed.getStatus());
  };

  priceFeed.on('tick', () => {
    if (sseClients.size === 0) return;
    const since = Date.now() - lastBroadcastAt;
    if (since >= PRICE_STREAM_THROTTLE_MS) {
      broadcastTick();
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(broadcastTick, PRICE_STREAM_THROTTLE_MS - since);
    }
  });
  priceFeed.on('open',  () => broadcast('feed_open',  priceFeed.getStatus()));
  priceFeed.on('close', () => broadcast('feed_close', priceFeed.getStatus()));
  priceFeed.on('error', (err) => broadcast('feed_error', { ...priceFeed.getStatus(), error: String(err?.message || err) }));

  // 心跳: SSE 注释行 (以 ":" 开头, 浏览器忽略, 但够刷新代理/防火墙的 idle 计时器)
  const hb = setInterval(() => {
    if (sseClients.size === 0) return;
    const data = `: heartbeat ${Date.now()}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch (_) {}
    }
  }, PRICE_STREAM_HEARTBEAT_MS);
  if (typeof hb.unref === 'function') hb.unref();
}

router.get('/price-stream', (req, res) => {
  _installSseListeners();

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // 关键: 反向代理 (nginx/cloudflare) 默认会缓冲响应, 必须显式禁用 buffering
    // 否则浏览器要等 4KB 凑齐才能见到第一帧, "实时"就名不副实
    'X-Accel-Buffering': 'no',
  });
  // Express 5+ 不暴露 flushHeaders, 但 Node 原生 res 一直支持
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 立刻下发一次快照, 避免新连接首屏空白
  res.write(`retry: 3000\n`);  // 客户端断流后 3s 自动重连 (浏览器默认 3s, 此处显式声明)
  res.write(`event: snapshot\ndata: ${JSON.stringify(priceFeed.getStatus())}\n\n`);

  sseClients.add(res);
  console.log(`[price-stream] 新客户端接入, 当前 ${sseClients.size} 个`);

  const cleanup = () => {
    if (!sseClients.has(res)) return;
    sseClients.delete(res);
    try { res.end(); } catch (_) {}
    console.log(`[price-stream] 客户端断开, 剩余 ${sseClients.size} 个`);
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
  res.on('error', cleanup);
});

/**
 * 反向信号取消挂单 — 公共内部函数, 供:
 *   1) HTTP 入口 POST /api/auto-trade/fvg-signal
 *   2) regimeModule.dispatchWebhookSignals 检测到 MACD 金/死叉 / RSI 超买/超卖时直接调用
 *
 * 信号方向语义 (反方向 = 警告信号, 取消同方向挂单):
 *   - signalKind='fvg' / 'macd_cross' / 'rsi_zone' (仅作日志区分)
 *   - signalDir='short'  → 取消 LONG  pending  (短期看空, 多头挂单失去依据)
 *   - signalDir='long'   → 取消 SHORT pending  (短期看多, 空头挂单失去依据)
 *
 * @param {string} signalKind     'fvg' | 'macd_cross' | 'rsi_zone' | 自定义
 *   仅作日志/通知归类用, 不影响行为
 * @param {'long'|'short'} signalDir
 * @param {object} [opts]
 *   @param {string} opts.label   信号详情, 写入 cancelPending 的 reason 字段
 * @returns {{cancelled:string|null, prev?:object, reason:string}}
 */
function cancelPendingByReverseSignal(signalKind, signalDir, opts = {}) {
  if (signalDir !== 'long' && signalDir !== 'short') {
    return { cancelled: null, reason: 'invalid_signal_dir' };
  }
  // 反方向 = 取消方向: signal=short → 取消 long; signal=long → 取消 short
  const cancelDir = signalDir === 'short' ? 'long' : 'short';
  const positions = state.get();
  const p = positions[cancelDir];
  if (!p || !p.pending) {
    return { cancelled: null, reason: 'no_pending', direction: cancelDir };
  }
  const reasonTag = `reverse_signal:${signalKind}:${signalDir}` + (opts.label ? `:${opts.label}` : '');
  const prev = state.cancelPending(cancelDir, reasonTag);
  if (!prev) return { cancelled: null, reason: 'no_pending', direction: cancelDir };

  const cfg = config.get();
  const titleEmoji = signalKind === 'fvg' ? '📡'
    : signalKind === 'macd_cross' ? '📊'
    : signalKind === 'rsi_zone' ? '🌡️'
    : '🛑';
  exec.notify({
    type: 'pending_cancelled',
    title: `${titleEmoji} ${cancelDir.toUpperCase()} 挂单已自动取消 (反向信号: ${signalKind} ${signalDir})`,
    lines: [
      `symbol: ${cfg.symbol}`,
      `取消方向: ${cancelDir}`,
      `信号类型: ${signalKind}`,
      `信号方向: ${signalDir}` + (opts.label ? ` (${opts.label})` : ''),
      `原 entry: ${prev.pendingPlan?.entry}`,
      `原 SL/TP1: ${prev.pendingPlan?.sl} / ${prev.pendingPlan?.tp1}`,
      `arm 时间: ${cnTime(prev.pendingArmedAt)}`,
      `逻辑: 反向信号出现, 同方向挂单失去依据, 自动撤销`,
    ],
  });
  // 推送到「交易点位监控系统」: 取消挂单 = 精简 payload
  exec.fireMonitorCancel({ direction: cancelDir });
  return { cancelled: cancelDir, prev, reason: reasonTag };
}

// ============ POST /fvg-signal: 接收 FVG 信号取消反向挂单 ============
//   body: { fvg: 'long' | 'short' }
//   - fvg: 'short'   → 取消 LONG  pending
//   - fvg: 'long'    → 取消 SHORT pending
//
// 不需要 X-Auth-Token 鉴权 (与 /cancel-pending 一致, 因为只是撤单, 不会真下单).
// 但需要 token 字段做最小防误调 (防外网随便 curl).
router.post('/fvg-signal', (req, res) => {
  const cfg = config.get();
  const body = req.body || {};
  // 与外部 webhook 信号一致, 用 cfg.token 做最小校验. 没 token 字段的请求直接 401.
  if (!body.token || body.token !== cfg.token) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
  const fvg = body.fvg;
  if (fvg !== 'long' && fvg !== 'short') {
    return res.status(400).json({ ok: false, error: 'fvg must be long|short' });
  }
  const r = cancelPendingByReverseSignal('fvg', fvg, { label: body.label || null });
  res.json({ ok: true, fvg, ...r });
});

// ============ POST /cancel-pending: 取消某方向的待触发挂单 ============
//   body: { direction: 'long' | 'short' }
//   仅取消 pending 计划; 已 active 的真实仓位不受影响.
//   不需要 X-Auth-Token, 因为 pending 没真正下单, 风险等价于"不下单".
router.post('/cancel-pending', (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  const prev = state.cancelPending(direction, req.body?.reason || 'manual_api');
  if (!prev) {
    return res.status(404).json({ ok: false, error: 'no_pending', direction });
  }
  exec.notify({
    type: 'pending_cancelled',
    title: `🛑 ${direction.toUpperCase()} pending 计划已手动取消`,
    lines: [
      `symbol: ${config.get().symbol}`,
      `方向: ${direction}`,
      `原 entry: ${prev.pendingPlan?.entry}`,
      `原 SL/TP1: ${prev.pendingPlan?.sl} / ${prev.pendingPlan?.tp1}`,
      `arm 时间: ${cnTime(prev.pendingArmedAt)}`,
      `操作: 手动 API 取消`,
    ],
  });
  // 推送到「交易点位监控系统」: 取消挂单 = 精简 payload
  exec.fireMonitorCancel({ direction });
  res.json({ ok: true, direction, prev });
});

// ============ POST /manual-open: 手动开仓 (挂单, 限价待触发) ============
//
// body: { direction: 'long' | 'short' }
//
// 用户硬性要求:
//   1) 有 regime tradePlan → 用 plan (entry/SL/TP/置信度仓位 全部锁定)
//   2) 无 regime tradePlan → 用「手动回退方案」: entry=当前市价, 每段 0.5%~1.2%,
//      仓位 MANUAL_FALLBACK_POSITION_PCT% (默认 10%)
//
// 整体走 pending 限价模式 (与 regime auto 同一通道), 价格触达 entry 才发 forwardOpen.
//
// ⚠️ 总开关关闭时直接拒绝, 避免"以为关了不下单, 手动一按又下了"的语义混乱.
router.post('/manual-open', requireAdmin, async (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return res.status(409).json({
      ok: false,
      error: 'auto_trade_disabled',
      hint: '请先开启「自动下单」总开关再手动开仓',
    });
  }

  const sig = {
    token: cfg.token,
    action: direction === 'long' ? 'open_long' : 'open_short',
    symbol: cfg.symbol,
  };

  // 优先尝试 regime tradePlan; 不可用时用手动回退方案 (0.5%~1.2% / 10% 仓位)
  const planLv = planLevelsFromRegime(direction);
  if (!planLv) {
    const marketPrice = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(marketPrice)) {
      return res.status(503).json({
        ok: false,
        error: 'price_feed_not_ready',
        hint: 'WS 行情尚未就绪, 无法计算手动回退方案的 entry',
      });
    }
    let lv;
    try {
      lv = computeManualFallbackLevels(direction, marketPrice);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    const validate = validateManualLevels(direction, marketPrice, lv.tp1, lv.tp2, lv.tp3, lv.sl);
    if (!validate.ok) {
      return res.status(400).json({ ok: false, error: 'manual_levels_invalid:' + validate.reason, segments: validate.segments });
    }
    sig.entry = marketPrice;
    sig.stop_loss = lv.sl;
    sig.tp1 = lv.tp1; sig.tp2 = lv.tp2; sig.tp3 = lv.tp3;
    sig.position_size = `${MANUAL_FALLBACK_POSITION_PCT}%`;
    sig._priceSource = 'manual_fallback';
  }

  const r = await processSignal(sig, { source: 'manual_ui' });
  res.status(r.status).json(r.body);
});

// ============ POST /manual-follow: 手动追单 (一键立即市价) ============
//
// body: { direction: 'long' | 'short' }
//
// 用户硬性要求:
//   - 不参考 regime tradePlan, 一律使用手动回退方案
//   - entry = 当前 WS 市价, TP/SL 按 0.5%~1.2% 阶梯派生
//   - 仓位固定 MANUAL_FALLBACK_POSITION_PCT% (默认 10%)
//   - 立即市价 (sig.market=true) → 走 immediate 分支, forwardOpen 立刻出站
//   - 同步推送 TG + 飞书
//
// 复用 processSignal 的所有现有 防重复/冷却/方向校验/价位校验/通知 逻辑.
router.post('/manual-follow', requireAdmin, async (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return res.status(409).json({
      ok: false,
      error: 'auto_trade_disabled',
      hint: '请先开启「自动下单」总开关再手动追单',
    });
  }

  const marketPrice = priceFeed.getStatus().lastPrice;
  if (!Number.isFinite(marketPrice)) {
    return res.status(503).json({
      ok: false,
      error: 'price_feed_not_ready',
      hint: 'WS 行情尚未就绪, 无法以市价进行手动追单',
    });
  }

  let lv;
  try {
    lv = computeManualFallbackLevels(direction, marketPrice);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const validate = validateManualLevels(direction, marketPrice, lv.tp1, lv.tp2, lv.tp3, lv.sl);
  if (!validate.ok) {
    return res.status(400).json({ ok: false, error: 'manual_levels_invalid:' + validate.reason, segments: validate.segments });
  }

  const sig = {
    token: cfg.token,
    action: direction === 'long' ? 'open_long' : 'open_short',
    symbol: cfg.symbol,
    // 强制 immediate (跳过 pending 限价分支), 立即按市价 forwardOpen
    market: true,
    immediate: true,
    entry: marketPrice,
    stop_loss: lv.sl,
    tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
    position_size: `${MANUAL_FALLBACK_POSITION_PCT}%`,
    _priceSource: 'manual_fallback',
  };

  // skipRegimePlan: 即便 regime 有 plan 也不查/不替换, 严格按手动追单语义
  const r = await processSignal(sig, { source: 'manual_follow', skipRegimePlan: true });
  res.status(r.status).json(r.body);
});

// ============ POST /close-all-positions: 一键全平 ============
//
// 遍历 long/short 两个 slot, 对 active=true 的方向:
//   1) 先 state.closeAndUnlock 写盘 (active=false), 后续 tick 立即不再 evaluate
//   2) 再 exec.fireStopLoss(trigger='manual_close_all') 把 100% market 平仓 webhook 发出去
//   3) notify 飞书 + 控制台
//
// 顺序与 riskEngine.fireSl 保持一致 (先写盘后发 webhook), 即便 webhook 失败也不会
// 因 _inFlight 异常没释放而陷入僵尸状态. 该方向被解锁, 用户可重新接信号.
async function manualCloseAllImpl({ source = 'manual_ui' } = {}) {
  const positions = state.get();
  const cfg = config.get();
  const results = [];

  for (const dir of ['long', 'short']) {
    const before = positions[dir];
    if (!before || !before.active) {
      results.push({ direction: dir, skipped: true, reason: 'no_position' });
      continue;
    }
    const snapshot = {
      entryPrice: before.entryPrice,
      positionSize: before.positionSize,
      leverage: before.leverage,
      currentStopLoss: before.currentStopLoss,
    };

    // closeAndUnlock 已是幂等的 - 第二次按"全平"按钮 / 与内部 fireSl race 时返回 null,
    // 此时跳过 webhook + 通知, 防止"同一仓位被全平 N 次"
    const closed = state.closeAndUnlock(dir, 'manual_close_all');
    if (!closed) {
      results.push({ direction: dir, skipped: true, reason: 'already_closed_race' });
      continue;
    }
    const r = await exec.fireStopLoss(dir, { trigger: 'manual_close_all' });

    // 推送到「交易点位监控系统」: 一键全平 = 取消该方向监控
    exec.fireMonitorCancel({ direction: dir });

    results.push({
      direction: dir,
      ok: !!r.res.ok,
      error: r.res.error || null,
      ...snapshot,
    });

    exec.notify({
      type: 'sl',
      title: `🛑 ${dir.toUpperCase()} 一键全平 (manual_close_all)`,
      lines: [
        `symbol: ${cfg.symbol}`,
        `方向: ${dir}`,
        `入场价: ${snapshot.entryPrice ?? '--'}`,
        `当时止损价: ${snapshot.currentStopLoss ?? '--'}`,
        `仓位/杠杆: ${snapshot.positionSize ?? '--'} / ${snapshot.leverage ?? '--'}x`,
        `操作来源: ${source}`,
        `平仓 webhook: ${r.res.ok ? '✅ 已发送' : '❌ ' + (r.res.error || r.res.skipped || '')}`,
        ...exec.formatPayloadLines('manual_close_all', r.payload),
      ],
      isAlert: !r.res.ok,
    });
    exec.notify({
      type: 'unlock',
      title: `🔓 ${dir.toUpperCase()} 已自动解锁 (一键全平)`,
      lines: [`方向 ${dir} 现可重新接收开仓信号`],
    });

    console.log(`[trade.manual] close-all dir=${dir} ok=${r.res.ok} entry=${snapshot.entryPrice}`);
  }

  const closed = results.filter(r => !r.skipped).length;
  const allOk = results.every(r => r.skipped || r.ok);
  return { ok: allOk, closed, results };
}

router.post('/close-all-positions', requireAdmin, async (req, res) => {
  const r = await manualCloseAllImpl({ source: req.body?.source || 'manual_ui' });
  res.json(r);
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
  const c = config.get();
  res.json({ ok: true, config: { ...c, token: c.token ? c.token.slice(0, 8) + '***' : '' } });
});

// ============ POST /config ============
router.post('/config', requireAdmin, (req, res) => {
  const updated = config.patch(req.body || {});
  res.json({ ok: true, config: { ...updated, token: updated.token ? updated.token.slice(0, 8) + '***' : '' } });
});

module.exports = router;
module.exports.processSignal = processSignal;
module.exports.manualCloseAllImpl = manualCloseAllImpl;
module.exports.requireAdmin = requireAdmin;
// 反向信号取消挂单 — regimeModule 在 dispatchWebhookSignals 里 in-process 调用
// 避免绕 HTTP, 也与 fvg-signal 路由共享同一段逻辑/通知/日志格式.
module.exports.cancelPendingByReverseSignal = cancelPendingByReverseSignal;
