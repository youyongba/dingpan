/**
 * ============================================================
 *  trading/router.js
 *  自动平仓引擎 - Express 路由
 *
 *  对外接口：
 *    POST /api/auto-trade/signal          接收外部 webhook 入仓/平仓信号 (body.token 校验)
 *    POST /api/auto-trade/pending-order   ⭐ 对外挂单交易信号 (body.direction, X-Auth-Token 鉴权)
 *                                          - 限价挂单, 价格回踩到 entry 才真下单
 *                                          - 价位用 regime plan 优先 / ATR 回退 (与 manual-open 同源)
 *                                          - 同方向已有 pending → 默认自动覆盖 (replace=false 时拒绝)
 *                                          - 同方向已有 active 真实仓位 → 直接 409 拒绝, 不允许覆盖
 *    POST/GET /api/auto-trade/market-order   ⚡ 对外市价立即开仓信号
 *    POST/GET /api/auto-trade/marker-order   (拼写兼容, 同源)
 *                                          - 鉴权: Header X-Auth-Token / Authorization: Bearer / ?token= / body.token 任一
 *                                          - 参数: direction (必填) / source / label / position_size, body 或 query 任一
 *                                          - 不等回踩, 收到信号立即按当下 WS 市价 forwardOpen
 *                                          - 价位用 regime plan 优先 / ATR 回退 (TP/SL 来自 plan, entry=市价)
 *                                          - 同方向已有 pending → 自动取消后立即市价开仓 (覆盖式)
 *                                          - 同方向已有 active 真实仓位 → 直接 409 拒绝
 *                                          - 示例 (热力图工具直拼 URL):
 *                                              GET https://monitor.24os.cn/api/auto-trade/marker-order?direction=long&token=<CONFIG_AUTH_TOKEN>&source=heatmap&label=L_Max_24H
 *    POST /api/auto-trade/reset           手动重置 { direction:'long'|'short' } (鉴权)
 *    POST /api/auto-trade/toggle           切换总开关 enabled (无需鉴权, 只切布尔)
 *    POST /api/auto-trade/toggle-direction 方向开关 { direction, disabled } 禁止做多/做空 (无需鉴权)
 *                                          仅拦新开仓信号; 不影响 active 持仓 TP/SL / pending 触达 fill / 平仓
 *    POST /api/auto-trade/direction-guard  ⭐ 价格围栏 (自动方向开关, 无需鉴权)
 *                                          { direction, enabled, threshold, hysteresisPct?, minSwitchIntervalMs? }
 *                                          riskEngine 每帧 tick 评估, 价格跨越基准时自动切换
 *                                          autoDisable*; 与手动 disable* 取或拦截新信号
 *    POST /api/auto-trade/regime-guard     ⭐ Regime 守卫 (基于 1H 趋势状态自动方向开关, 无需鉴权)
 *                                          { enabled, blockLongOnStrongBear?, blockShortOnStrongBull?,
 *                                            blockBothOnPanic?, blockBothOnUnclear?, minConfidence? }
 *                                          riskEngine 每 30s 评估 regimeModule.subRegime,
 *                                          STRONG_BULL→拦空 / STRONG_BEAR→拦多 / PANIC→双向禁
 *                                          → 写 regimeAutoDisable*; 与 manual + priceGuard 三重取或
 *    GET  /api/auto-trade/status          查询当前仓位 + WS 状态 + 方向开关 + 价格围栏 + Regime 守卫
 *    GET  /api/auto-trade/config          读取当前配置
 *    POST /api/auto-trade/config          局部更新配置 (鉴权)
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
const riskEngine = require('./riskEngine');
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
function computeManualFallbackLevels(direction, entryPrice, isPending = false) {
  let getLatestPlan;
  try {
    getLatestPlan = require('../regimeModule').getLatestPlan;
  } catch (e) {}
  const planInfo = getLatestPlan ? getLatestPlan() : null;
  const atr = planInfo?.latest?.atr;

  if (!atr || atr <= 0) {
    throw new Error('当前无有效的 ATR 数据，无法计算动态止盈止损');
  }

  const sign = direction === 'long' ? 1 : -1;
  // 如果是挂单 (isPending=true)，入场价回踩 0.5 ATR；否则直接用市价
  const entry = isPending
    ? (direction === 'long' ? entryPrice - 0.5 * atr : entryPrice + 0.5 * atr)
    : entryPrice;

  const risk = 1.5 * atr;
  const tp1 = entry + sign * 1 * risk;
  const tp2 = entry + sign * 2 * risk;
  const tp3 = entry + sign * 3 * risk;
  const sl = direction === 'long' ? entry - risk : entry + risk;

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    entry: round2(entry),
    tp1: round2(tp1),
    tp2: round2(tp2),
    tp3: round2(tp3),
    sl: round2(sl),
  };
}

/**
 * 校验一组 entry/TP/SL 是否合法 (方向与大小关系)
 *
 * ⚠️ 仅适用于"新开仓 / pending 挂单"场景 (尚无 TP 触发).
 * active 持仓 (尤其是 TP1 已触发后) 的调整请用 validateAdjustActiveLevels — 那里允许:
 *   - SL 上移到 entry 之上 (TP1 已触发后的 trailing/锁利)
 *   - 已触发的 TPN 不参与排序校验
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
  
  return { ok: true, segments: [] };
}

/**
 * 持仓中 (active) 的 TP/SL 调整专用校验.
 *
 * 与 validateManualLevels 的关键区别 (修复 TP1 触发后无法上移 SL 的 bug):
 *   1) 已触发的 TPN (tpHit.tpN=true) 完全不参与校验 — 它们是历史价位, 改了也会被
 *      state.updateActiveLevels 跳过
 *   2) 未触发的 TP 之间保持升序 (多头) / 降序 (空头)
 *   3) 第一个未触发的 TP 必须在 entry 反侧 (多头 > entry, 空头 < entry)
 *      — 否则 riskEngine.evaluate 进入死分支永远摸不到
 *   4) SL 必须严格在第一个未触发的 TP **反侧** (多头 SL < firstTp, 空头 SL > firstTp)
 *      — 否则 SL 永远先触发, TP 永无机会
 *   5) SL 与 entry 的关系**有条件放宽**:
 *      - TP1 未触发: SL 仍必须保护本金 (多头 SL < entry)
 *      - TP1 已触发: SL 任意 — 允许 trailing 上移到 entry 之上 (用户锁 TP1 后的利润),
 *        甚至允许 SL > entry 但 < TP2 (合理的"半保本+锁利"策略)
 *
 * @param {'long'|'short'} direction
 * @param {number} entry
 * @param {{tp1, tp2, tp3, sl}} merged
 * @param {{tp1?:boolean, tp2?:boolean, tp3?:boolean}} tpHit
 * @returns {{ok:boolean, reason?:string, hint?:string}}
 */
function validateAdjustActiveLevels(direction, entry, merged, tpHit) {
  const isLong = direction === 'long';
  const safe = (v) => Number.isFinite(Number(v));
  const { tp1, tp2, tp3, sl } = merged;
  if (![entry, tp1, tp2, tp3, sl].every(safe)) {
    return { ok: false, reason: 'non_numeric_levels' };
  }
  const hit = tpHit || {};
  // 未触发 TP 列表 (按级别顺序). 已触发的不参与校验
  const unfired = [];
  if (!hit.tp1) unfired.push({ key: 'tp1', value: Number(tp1) });
  if (!hit.tp2) unfired.push({ key: 'tp2', value: Number(tp2) });
  if (!hit.tp3) unfired.push({ key: 'tp3', value: Number(tp3) });

  // 1. 未触发 TP 之间的顺序
  for (let i = 1; i < unfired.length; i++) {
    const prev = unfired[i - 1];
    const curr = unfired[i];
    const ok = isLong ? curr.value > prev.value : curr.value < prev.value;
    if (!ok) {
      return {
        ok: false,
        reason: 'tp_wrong_order',
        hint: isLong
          ? `${curr.key.toUpperCase()} (${curr.value.toFixed(2)}) 必须高于 ${prev.key.toUpperCase()} (${prev.value.toFixed(2)})`
          : `${curr.key.toUpperCase()} (${curr.value.toFixed(2)}) 必须低于 ${prev.key.toUpperCase()} (${prev.value.toFixed(2)})`,
      };
    }
  }

  // 2/3. 第一个未触发 TP 必须在 entry 反侧, 且 SL 必须在它的反侧
  if (unfired.length > 0) {
    const first = unfired[0];
    const tpVsEntryOk = isLong ? first.value > entry : first.value < entry;
    if (!tpVsEntryOk) {
      return {
        ok: false,
        reason: 'tp_wrong_side_vs_entry',
        hint: isLong
          ? `${first.key.toUpperCase()} (${first.value.toFixed(2)}) 必须高于入场价 (${entry.toFixed(2)})`
          : `${first.key.toUpperCase()} (${first.value.toFixed(2)}) 必须低于入场价 (${entry.toFixed(2)})`,
      };
    }
    const slVsTpOk = isLong ? sl < first.value : sl > first.value;
    if (!slVsTpOk) {
      return {
        ok: false,
        reason: 'sl_wrong_side_vs_tp',
        hint: isLong
          ? `止损 (${sl.toFixed(2)}) 必须低于下一个 ${first.key.toUpperCase()} (${first.value.toFixed(2)}), 否则 SL 永远先触发`
          : `止损 (${sl.toFixed(2)}) 必须高于下一个 ${first.key.toUpperCase()} (${first.value.toFixed(2)}), 否则 SL 永远先触发`,
      };
    }
  }

  // 4. SL 与 entry: 仅 TP1 未触发时强制保护本金; TP1 已触发后允许 trailing
  if (!hit.tp1) {
    const slOk = isLong ? sl < entry : sl > entry;
    if (!slOk) {
      return {
        ok: false,
        reason: 'sl_wrong_side_vs_entry',
        hint: isLong
          ? `TP1 尚未触发, 止损 (${sl.toFixed(2)}) 必须低于入场价 (${entry.toFixed(2)}) 以保护本金`
          : `TP1 尚未触发, 止损 (${sl.toFixed(2)}) 必须高于入场价 (${entry.toFixed(2)}) 以保护本金`,
      };
    }
  }
  // 若所有 TP 都已触发 (理论上 TP3 触发即解锁, 不会走到这里), 无任何 TP 约束, 仅校验数值合法 — 已 pass

  return { ok: true };
}

/**
 * 管理接口鉴权中间件.
 *
 * 兼容三种 token 传递方式 (优先级 header > query > body), 命中任一即放行:
 *   1. HTTP Header  X-Auth-Token: <token>      (UI / 自家 admin 工具用)
 *   2. URL Query    ?token=<token>             (外部信号源 / GET 友好 / 拼到 URL 直接喊单)
 *   3. JSON Body    { "token": "<token>" }     (兼容老脚本)
 *
 * 同时还支持 Authorization: Bearer <token> (与 monitor webhook 风格一致).
 */
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'CONFIG_AUTH_TOKEN 未配置, 管理接口已禁用' });
  const headerTok = req.headers['x-auth-token'];
  const bearerHdr = req.headers['authorization'] || '';
  const bearerTok = /^Bearer\s+(.+)$/i.test(bearerHdr) ? bearerHdr.replace(/^Bearer\s+/i, '').trim() : null;
  const queryTok = req.query?.token;
  const bodyTok = req.body?.token;
  const provided = headerTok || bearerTok || queryTok || bodyTok;
  if (provided !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: '鉴权失败', hint: '可通过 Header X-Auth-Token / Authorization: Bearer / ?token= / body.token 任一方式提供' });
  }
  next();
}

/**
 * ⭐ 风控套件: 入场前强制 SL 距离上限.
 *
 * 100x × 50% 下爆仓距离 ≈ 0.50%, 若 ATR 算的 SL 距离 > 0.40% (留 0.10% buffer),
 * 必爆仓在前 SL 在后 — SL 等于失效. 此函数把 SL 强制收紧到 maxDistancePct% 内,
 * 让外部交易所那边的 SL 永远早于爆仓触发.
 *
 * 工具内部的"软止损"会先于这个硬 SL 触发 (软SL 0.15%/0.30% < 0.40%),
 * 这层是兜底 — 万一软SL 因网络延迟漏触发, 这层兜住.
 *
 * @param {string} direction
 * @param {number} entry
 * @param {number} sl       原 SL (ATR 算的)
 * @param {number} maxDistancePct  上限百分比 (例如 0.40)
 * @returns {{capped: boolean, sl: number, originalSl: number, distancePct: number}}
 */
function applyHardSlCap(direction, entry, sl, maxDistancePct) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(sl) || sl <= 0) {
    return { capped: false, sl, originalSl: sl, distancePct: null };
  }
  if (!Number.isFinite(maxDistancePct) || maxDistancePct <= 0) {
    return { capped: false, sl, originalSl: sl, distancePct: null };
  }
  const isLong = direction === 'long';
  const distancePct = Math.abs((entry - sl) / entry) * 100;
  if (distancePct <= maxDistancePct) {
    return { capped: false, sl, originalSl: sl, distancePct };
  }
  // 收紧 SL 到 maxDistancePct% 内
  const newSl = isLong
    ? entry * (1 - maxDistancePct / 100)
    : entry * (1 + maxDistancePct / 100);
  // 数值精度: 与 computeManualFallbackLevels 的 round2 保持一致
  const round2 = (n) => Math.round(n * 100) / 100;
  return { capped: true, sl: round2(newSl), originalSl: sl, distancePct };
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

    // ⭐ 方向开关 (与 cfg.enabled 总开关同级, 但**仅拦新开仓信号**):
    //   三条独立位取或 — 任意一个 true 都拒绝该方向的 open_long/open_short 新信号:
    //     a) cfg.disableLong/Short          — 用户手动开关 (UI / /toggle-direction)
    //     b) cfg.autoDisableLong/Short      — 价格围栏自动 (riskEngine.evaluateDirectionGuard)
    //     c) cfg.regimeAutoDisableLong/Short — 📊 Regime 守卫自动 (riskEngine.evaluateRegimeGuard)
    //   不影响 take_profit / stop_loss / close-all-positions, 也不影响已有 pending 触达 entry 的 fill.
    //   想彻底撤已有 pending 请 POST /api/auto-trade/cancel-pending. 想拦 active 仓位 TP/SL 请关 cfg.enabled.
    const manualKey   = direction === 'long' ? 'disableLong' : 'disableShort';
    const priceKey    = direction === 'long' ? 'autoDisableLong' : 'autoDisableShort';
    const regimeKey   = direction === 'long' ? 'regimeAutoDisableLong' : 'regimeAutoDisableShort';
    const manualDisabled = !!cfg[manualKey];
    const priceDisabled  = !!cfg[priceKey];
    const regimeDisabled = !!cfg[regimeKey];
    if (manualDisabled || priceDisabled || regimeDisabled) {
      const directionZh = direction === 'long' ? '做多' : '做空';
      const reasons = [];
      if (manualDisabled) reasons.push('手动开关');
      if (priceDisabled)  reasons.push('价格围栏');
      if (regimeDisabled) reasons.push('Regime 守卫');
      const reasonStr = reasons.join(' + ');
      const guardCfg = cfg.directionGuard?.[direction];
      const priceLine = priceDisabled && guardCfg?.enabled
        ? `🤖 价格围栏: 基准价=${guardCfg.threshold ?? '--'}, 当前 lastPrice 已${direction === 'long' ? '跌破' : '涨破'}基准 → 自动拦截`
        : null;
      const regimeLine = regimeDisabled
        ? `📊 Regime 守卫: subRegime=${cfg.regimeAutoLastSubRegime || '?'} (置信度 ${cfg.regimeAutoLastConfidence || '?'}) → 该方向被趋势状态拦截`
        : null;
      exec.notify({
        type: 'open_blocked',
        title: `🚫 ${direction.toUpperCase()} 开仓被「禁止${directionZh}」拦截 (${reasonStr})`,
        lines: [
          `symbol: ${sig.symbol || cfg.symbol}`,
          `来源: ${callerSource}`,
          manualDisabled ? `🚫 手动开关 ${manualKey}=true (POST /toggle-direction 切换)` : null,
          priceLine,
          regimeLine,
          `已有 ${direction.toUpperCase()} 持仓的 TP/SL 不受影响; 已有 pending 不会自动撤`,
        ].filter(Boolean),
      });
      console.warn(`[trade.router] 🚫 ${direction} 信号被方向开关拦截 (manual=${manualDisabled}, price=${priceDisabled}, regime=${regimeDisabled}, source=${callerSource})`);
      return {
        status: 409,
        body: {
          ok: false,
          error: 'direction_disabled',
          direction,
          reason: reasonStr,
          [manualKey]: manualDisabled,
          [priceKey]: priceDisabled,
          [regimeKey]: regimeDisabled,
          regimeAutoLastSubRegime: cfg.regimeAutoLastSubRegime || null,
          hint: `「禁止${directionZh}」拦截原因: ${reasonStr}; 手动→/toggle-direction, 价格围栏→/direction-guard, Regime→/regime-guard`,
        },
      };
    }

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

    // ⭐ 风控套件: hardSlCap — 入场前强制 SL 距离 ≤ maxDistancePct%
    //   对 100x × 50% 滚仓, 爆仓距离 ≈ 0.50%, ATR 算的 SL 距离 0.6%+ 就必爆仓在前.
    //   此处把 SL 收紧到 0.40% (留 0.10% buffer), 让外部交易所 SL 早于爆仓触发.
    //   pending 模式: 用 planEntry 应用一次, 直接落到 plan.sl
    //   immediate 模式: 由于 entryPrice 后续会变成 marketPrice, 还会在 line ~634 之后再应用一次
    let hardSlCapApplied = null;
    if (cfg.riskGuardEnabled !== false && cfg.hardSlCap?.enabled
        && Number.isFinite(sl) && Number.isFinite(entryPrice)) {
      const cap = applyHardSlCap(direction, entryPrice, sl, cfg.hardSlCap.maxDistancePct);
      if (cap.capped) {
        console.log(`[trade.router] 🛡 hardSlCap (pending phase): ${direction} entry=${entryPrice} 原SL=${cap.originalSl}(距${cap.distancePct.toFixed(3)}%) → 收紧到 SL=${cap.sl}(距${cfg.hardSlCap.maxDistancePct}%)`);
        sl = cap.sl;
        // sig.stop_loss 同步收紧, 让 plan.raw 与 plan.sl 一致, firePendingFill 时 webhook 推出去的 SL 也是收紧后的
        sig.stop_loss = sl;
        hardSlCapApplied = cap;
      }
    }

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
      if (source === 'manual_fallback_atr') return `🛠 手动挂单 (ATR动态计算 / 动态仓位)`;
      if (source === 'manual_follow_atr') return `⚡ 手动追单 (ATR动态计算 / 动态仓位)`;
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

    // ⭐ 风控套件: hardSlCap (immediate phase) — entryPrice 已变成 marketPrice,
    //   plan 的 sl 是基于 planEntry (回踩 0.5×ATR 后) 算的, 距离 marketPrice 实际 = 2.0×ATR,
    //   往往超过 maxDistancePct%. 这里再应用一次, 用真实入场价收紧 sl.
    if (cfg.riskGuardEnabled !== false && cfg.hardSlCap?.enabled
        && Number.isFinite(sl) && Number.isFinite(entryPrice)) {
      const cap = applyHardSlCap(direction, entryPrice, sl, cfg.hardSlCap.maxDistancePct);
      if (cap.capped) {
        console.log(`[trade.router] 🛡 hardSlCap (immediate phase): ${direction} entry=${entryPrice} 原SL=${cap.originalSl}(距${cap.distancePct.toFixed(3)}%) → 收紧到 SL=${cap.sl}(距${cfg.hardSlCap.maxDistancePct}%)`);
        sl = cap.sl;
        hardSlCapApplied = cap;
      }
    }

    // sig.stop_loss 也要同步, 这样 forwardOpen webhook 推给外部下单端的 SL 是收紧后的
    if (hardSlCapApplied) sig.stop_loss = sl;

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
    // ⭐ 方向开关: 前端 UI 用这两个字段渲染"禁止做多/禁止做空"按钮状态
    // 切换走 POST /toggle-direction 或 POST /config { disableLong | disableShort }
    disableLong: !!cfg.disableLong,
    disableShort: !!cfg.disableShort,
    // ⭐ 价格围栏 (自动方向开关) — 配置 + 实时自动状态:
    //   directionGuard:    { long:{enabled,threshold}, short:{enabled,threshold}, hysteresisPct, minSwitchIntervalMs }
    //   autoDisableLong/Short: riskEngine 实时评估写入, 与手动 disable* 取或决定 processSignal 是否拦截
    // UI 用这些字段渲染"价格围栏"输入框 + 实时状态标签.
    directionGuard: cfg.directionGuard || null,
    autoDisableLong: !!cfg.autoDisableLong,
    autoDisableShort: !!cfg.autoDisableShort,
    // ⭐ Regime 守卫 — 配置 + 实时趋势状态 + 实时拦截标志:
    //   regimeGuard:                 { enabled, blockLongOnStrongBear, blockShortOnStrongBull, blockBothOnPanic, blockBothOnUnclear, minConfidence, minSwitchIntervalMs }
    //   regimeAutoDisableLong/Short: riskEngine.evaluateRegimeGuard 写入, 与 manual + price 三重取或
    //   regimeAutoLastSubRegime:     最近一次评估到的 subRegime 状态
    //   regimeAutoLastConfidence:    最近一次评估到的置信度
    //   regimeAutoLastEvalAt:        最近一次评估时间 (ms)
    regimeGuard: cfg.regimeGuard || null,
    regimeAutoDisableLong: !!cfg.regimeAutoDisableLong,
    regimeAutoDisableShort: !!cfg.regimeAutoDisableShort,
    regimeAutoLastSubRegime: cfg.regimeAutoLastSubRegime || null,
    regimeAutoLastConfidence: cfg.regimeAutoLastConfidence || null,
    regimeAutoLastEvalAt: cfg.regimeAutoLastEvalAt || null,
    // ⭐ 风控套件 — 配置 + 实时状态:
    //   softStopLoss / timeExit / hardSlCap / profitWithdraw / lossStreakBrake / balanceGuard 配置
    //   lossStreak / pausedUntilMs / pausedReason / accountBalanceUSD 实时状态
    //   UI 用这些字段渲染"风控套件"卡片 + 输入框热更新.
    riskGuard: {
      // ⭐ 总开关: false 时所有子模块逻辑都跳过 (子模块 .enabled 配置保留, 切回 true 立即恢复)
      enabled: cfg.riskGuardEnabled !== false,
      softStopLoss: cfg.softStopLoss || null,
      timeExit: cfg.timeExit || null,
      hardSlCap: cfg.hardSlCap || null,
      profitWithdraw: cfg.profitWithdraw || null,
      lossStreakBrake: cfg.lossStreakBrake || null,
      balanceGuard: cfg.balanceGuard || null,
      // 实时状态 (riskEngine 自动写入)
      lossStreak: cfg.lossStreak || 0,
      pausedUntilMs: cfg.pausedUntilMs || null,
      pausedReason: cfg.pausedReason || null,
      accountBalanceUSD: Number.isFinite(cfg.accountBalanceUSD) ? cfg.accountBalanceUSD : null,
    },
    priceFeed: priceFeed.getStatus(),
    positions: state.get(),
    // ⭐ 价格触发器 (后端 WS 监听 + disk 持久化, 浏览器关掉也会触发)
    priceTriggers: state.getPriceTriggers(),
    // ⭐ 风控引擎遥测: fire 延迟 + near-miss (价格 hit 但被节流挡的计数 + 最近一次详情),
    // 帮助用户在 UI 直接看到"为什么 TP2/TP3 没触发" — 如果 tpSkippedByCooldown 一直涨,
    // 说明 cooldown 偶尔挡住, 但链式接力(_chainEvaluate)应该已经自动补触发了
    risk: typeof riskEngine.getRiskTelemetry === 'function'
      ? riskEngine.getRiskTelemetry()
      : null,
  });
});

// ============ 价格触发器路由 (后端版, 取代浏览器 localStorage) ============
//
// 设计:
//   - 状态由 trading/state.js 持久化, 浏览器关闭/刷新都保留
//   - riskEngine 每帧 tick evaluate, 命中调 manualOpenImpl / manualFollowImpl
//   - arm 需要 admin token (与开仓动作同级); cancel 不需要 (撤销等价于不下单)
//
// 与 pending 限价单的区别: trigger 是"第一级闸门 — 价格到 X 才开始挂单/追单",
// 命中后才进入 pending (action='open') 或立即市价 (action='follow').

/**
 * POST /price-trigger/arm
 *
 * 追加一条触发器到指定方向的 items[] (允许多条同时启用).
 *
 * body: {
 *   direction: 'long' | 'short',
 *   triggerPrice: number,            必填
 *   action: 'open' | 'follow',       必填
 *   baselinePrice?: number           可选, 不传则用当前 WS 市价
 * }
 *
 * 校验:
 *   - direction / triggerPrice / action 合法
 *   - 触发价与当前价差 ≥ 0.05% (避免立即命中误触)
 *   - 必须能拿到 baselinePrice (传入 或 priceFeed.lastPrice)
 *   - 同方向若已有等价触发器 (同价同 action) → 409 拒绝, 防止误点重复 arm
 *
 * 副作用:
 *   - arm 新条会自动解开同方向 locked=true (相当于"重新启用监听").
 *   - 同步推送一条「交易点位监控系统」webhook (fireMonitorOpen, comment 标"价格触发器待命"),
 *     让监控端在触发器命中前就能登记该方向的待命点位; 命中后真正挂单/追单时还会再推真实点位.
 */
router.post('/price-trigger/arm', requireAdmin, (req, res) => {
  const direction = req.body?.direction;
  const triggerPrice = Number(req.body?.triggerPrice);
  const action = req.body?.action === 'follow' ? 'follow' : (req.body?.action === 'open' ? 'open' : null);
  let baselinePrice = Number(req.body?.baselinePrice);

  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    return res.status(400).json({ ok: false, error: 'invalid_trigger_price' });
  }
  if (!action) {
    return res.status(400).json({ ok: false, error: "action must be 'open' or 'follow'" });
  }
  if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) {
    const px = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(px)) {
      return res.status(503).json({
        ok: false, error: 'price_feed_not_ready',
        hint: 'WS 行情未就绪, 无法推导触发方向, 请稍候重试 (或显式传 baselinePrice)',
      });
    }
    baselinePrice = Number(px);
  }
  if (Math.abs(baselinePrice - triggerPrice) / baselinePrice < 0.0005) {
    return res.status(400).json({
      ok: false, error: 'trigger_too_close_to_baseline',
      hint: `触发价 ${triggerPrice.toFixed(2)} 与当前价 ${baselinePrice.toFixed(2)} 相差 < 0.05%, 易立即触发, 请调远`,
    });
  }

  let trigger;
  try {
    trigger = state.armPriceTrigger(direction, { triggerPrice, action, baselinePrice });
  } catch (e) {
    if (e?.message === 'duplicate_trigger') {
      return res.status(409).json({
        ok: false, error: 'duplicate_trigger',
        hint: `同方向已存在等价触发器 (价 ${triggerPrice.toFixed(2)} · ${action}), 请先取消或换一个价/动作`,
        existing: e.existing,
      });
    }
    return res.status(400).json({ ok: false, error: e?.message || 'arm_failed' });
  }

  const cfg = config.get();
  const titleEmoji = direction === 'long' ? '📈' : '📉';
  const actZh = action === 'follow' ? '🚀 立即追单 (市价)' : '📋 挂单 (限价待触发)';
  const sideZh = trigger.side === 'above' ? '上涨到' : '下跌到';
  // 显示该方向当前共有多少条 (含本条)
  const allItems = state.getPriceTriggers()[direction].items;
  exec.notify({
    type: 'wait',
    title: `${titleEmoji} ${direction.toUpperCase()} 价格触发器已添加 (共 ${allItems.length} 条)`,
    lines: [
      `symbol: ${cfg.symbol}`,
      `触发方向: ${direction}`,
      `当前价: ${baselinePrice.toFixed(2)}`,
      `本条触发价: ${triggerPrice.toFixed(2)} (价格${sideZh})`,
      `本条动作: ${actZh}`,
      `本条 id: ${trigger.id}`,
      `运行位置: 后端 WS 监听 (浏览器关闭照样触发)`,
      `📐 成交锁: 该方向任意一条 fire 成功后, 剩余触发器全部清除并锁定`,
      `❎ 取消单条: POST /api/auto-trade/price-trigger/cancel {"direction":"${direction}","id":"${trigger.id}"}`,
      `❎ 清空该方向: POST /api/auto-trade/price-trigger/cancel-all {"direction":"${direction}"}`,
    ],
  });

  // ⭐ 推送到「交易点位监控系统」: arm 价格触发器时就让监控端登记这条"待命点位".
  //    arm 阶段 TP/SL 尚未最终确定, 这里用与 fire 时同源的逻辑预算一套预览点位:
  //      1) 优先 regime tradePlan (与方向匹配且未过期) → 用 plan 的 entry/TP/SL
  //      2) 否则按触发价 ATR 回退 (挂单回踩 0.5×ATR, 追单直接用触发价)
  //      3) 连 ATR 都拿不到 → 退化为仅登记 entry=触发价, TP/SL 留空
  //    命中后真正挂单/追单时 processSignal 还会再推一次"真实点位" (comment 不同, 监控端可区分).
  //    全程 try/catch + fire-and-forget, 任何异常都不影响 arm 主流程.
  try {
    const preview = planLevelsFromRegime(direction);
    let monEntry, monTp1, monTp2, monTp3, monSl;
    if (preview) {
      monEntry = preview.planEntry;
      monTp1 = preview.tp1; monTp2 = preview.tp2; monTp3 = preview.tp3; monSl = preview.sl;
    } else {
      try {
        const lv = computeManualFallbackLevels(direction, triggerPrice, action === 'open');
        monEntry = lv.entry; monTp1 = lv.tp1; monTp2 = lv.tp2; monTp3 = lv.tp3; monSl = lv.sl;
      } catch (_) {
        monEntry = triggerPrice; // ATR 不可用: 仅登记触发价, TP/SL 由 fireMonitorOpen 序列化成 null
      }
    }
    exec.fireMonitorOpen({
      direction,
      entry: monEntry,
      tp1: monTp1, tp2: monTp2, tp3: monTp3, sl: monSl,
      comment: `价格触发器待命 · ${action === 'follow' ? '追单' : '挂单'} · 触发价${triggerPrice.toFixed(2)}`,
    });
  } catch (e) {
    console.error('[trade.router] price-trigger arm monitor 推送失败 (已忽略, 不影响 arm):', e?.message || e);
  }

  res.json({ ok: true, direction, trigger, total: allItems.length });
});

/**
 * POST /price-trigger/cancel
 *
 * body: { direction: 'long' | 'short', id: string }
 *
 * 按 id 取消单条触发器. 不需要 admin token (取消 = 不下单).
 */
router.post('/price-trigger/cancel', (req, res) => {
  const direction = req.body?.direction;
  const id = req.body?.id;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  if (!id || typeof id !== 'string') {
    return res.status(400).json({
      ok: false, error: 'missing_id',
      hint: '现支持多触发器, 取消必须指定 id; 一键清空请用 /price-trigger/cancel-all',
    });
  }
  const prev = state.cancelPriceTrigger(direction, id, req.body?.reason || 'manual_api');
  if (!prev) {
    return res.status(404).json({ ok: false, error: 'trigger_not_found', direction, id });
  }
  const cfg = config.get();
  const titleEmoji = direction === 'long' ? '📈' : '📉';
  const remaining = state.getPriceTriggers()[direction].items.length;
  exec.notify({
    type: 'wait',
    title: `🚫 ${titleEmoji} ${direction.toUpperCase()} 已取消单条触发器 (剩余 ${remaining} 条)`,
    lines: [
      `symbol: ${cfg.symbol}`,
      `原触发价: ${Number(prev.triggerPrice).toFixed(2)} (${prev.side})`,
      `原动作: ${prev.action === 'follow' ? '追单' : '挂单'}`,
      `id: ${prev.id}`,
      `启用时间: ${cnTime(prev.armedAt)}`,
      `取消原因: ${prev.cancelReason || 'manual'}`,
    ],
  });
  res.json({ ok: true, direction, prev, remaining });
});

/**
 * POST /price-trigger/cancel-all
 *
 * body: { direction: 'long' | 'short' }
 *
 * 一键清空某方向所有触发器 (UI 上"全部取消"按钮 / 反向信号场景).
 * 不需要 admin token. 不影响 locked 标记 (locked 由 fire 成功设置, 由 arm 重置).
 */
router.post('/price-trigger/cancel-all', (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  const prev = state.cancelAllPriceTriggers(direction, req.body?.reason || 'manual_all');
  if (!prev || prev.length === 0) {
    return res.status(404).json({ ok: false, error: 'no_active_triggers', direction });
  }
  const cfg = config.get();
  const titleEmoji = direction === 'long' ? '📈' : '📉';
  exec.notify({
    type: 'wait',
    title: `🚫 ${titleEmoji} ${direction.toUpperCase()} 已清空全部 ${prev.length} 条触发器`,
    lines: [
      `symbol: ${cfg.symbol}`,
      `方向: ${direction}`,
      ...prev.map(t => `  · ${Number(t.triggerPrice).toFixed(2)} (${t.side}) · ${t.action === 'follow' ? '追单' : '挂单'}`),
    ],
  });
  res.json({ ok: true, direction, prev });
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
/**
 * /manual-open 的可复用实现: 抽出来供:
 *   1) HTTP 端点 POST /api/auto-trade/manual-open (用户点击 UI 按钮)
 *   2) riskEngine.firePriceTrigger 价格触发器命中后 in-process 调用 (浏览器关掉也能下单)
 *
 * @param {object} opts
 * @param {'long'|'short'} opts.direction
 * @param {string} [opts.source='manual_ui']  传给 processSignal 的来源标记
 * @returns {Promise<{status:number, body:object}>}
 */
async function manualOpenImpl(opts = {}) {
  const direction = opts.direction;
  if (!['long', 'short'].includes(direction)) {
    return { status: 400, body: { ok: false, error: 'direction must be long|short' } };
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return {
      status: 409,
      body: { ok: false, error: 'auto_trade_disabled', hint: '请先开启「自动下单」总开关再手动开仓' },
    };
  }

  const sig = {
    token: cfg.token,
    action: direction === 'long' ? 'open_long' : 'open_short',
    symbol: cfg.symbol,
  };

  // 优先尝试 regime tradePlan; 不可用时用动态 ATR 方案
  const planLv = planLevelsFromRegime(direction);
  if (!planLv) {
    const marketPrice = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(marketPrice)) {
      return {
        status: 503,
        body: { ok: false, error: 'price_feed_not_ready', hint: 'WS 行情尚未就绪, 无法计算动态 ATR 方案的 entry' },
      };
    }
    let lv;
    try {
      lv = computeManualFallbackLevels(direction, marketPrice, true);
    } catch (e) {
      return { status: 400, body: { ok: false, error: e.message } };
    }
    const validate = validateManualLevels(direction, lv.entry, lv.tp1, lv.tp2, lv.tp3, lv.sl);
    if (!validate.ok) {
      return { status: 400, body: { ok: false, error: 'manual_levels_invalid:' + validate.reason, segments: validate.segments } };
    }
    sig.entry = lv.entry;
    sig.stop_loss = lv.sl;
    sig.tp1 = lv.tp1; sig.tp2 = lv.tp2; sig.tp3 = lv.tp3;

    let getLatestPlan;
    try { getLatestPlan = require('../regimeModule').getLatestPlan; } catch (e) {}
    const planInfo = getLatestPlan ? getLatestPlan() : null;
    const posPct = planInfo?.tradePlan?.suggestedPositionPct || 50;
    sig.position_size = `${posPct}%`;
    sig._priceSource = 'manual_fallback_atr';
  }

  return processSignal(sig, { source: opts.source || 'manual_ui' });
}

router.post('/manual-open', requireAdmin, async (req, res) => {
  const r = await manualOpenImpl({ direction: req.body?.direction, source: 'manual_ui' });
  res.status(r.status).json(r.body);
});

// ============ POST /pending-order: 对外挂单交易信号入口 ============
//
// 与 /manual-open 的关系:
//   - /manual-open  : 给前端 UI 按钮用 (source='manual_ui'), 同方向已有 pending 时直接 409 拒绝
//   - /pending-order: 对外暴露给第三方策略源/TradingView/N8N 等 (source='pending_order_api'),
//                     同方向已有 pending 时**默认自动覆盖** (取消旧 → arm 新), 与 firePriceTrigger
//                     覆盖式语义对齐, 让外部策略每轮推新信号都能成功落单, 不会因为上一轮的旧
//                     pending 没成交而被静默拦掉.
//
// body: {
//   direction: 'long' | 'short',                   // 必填
//   source?: string,                                // 可选, 调用方标记 (写入飞书/日志, 长度<=32)
//   label?: string,                                 // 可选, 描述信号源 (如 "TV-BTC-Strategy")
//   replace?: boolean (默认 true)                   // false 时, 同方向有 pending → 409 拒绝, 不覆盖
// }
//
// 价位策略 (与 manual-open 完全一致):
//   1) 有 regime tradePlan 且方向匹配 → 用 plan (entry/SL/TP/置信度仓位 全部锁定)
//   2) 否则 → 用 ATR 动态回退 (回踩 0.5×ATR 入场, 1.5×ATR 止损步长)
//
// 安全:
//   - X-Auth-Token (CONFIG_AUTH_TOKEN) 鉴权, 与 /manual-open 同级 (会真实下单, 不能裸奔)
//   - 同方向已有 active 真实持仓 → **绝不覆盖** (语义太危险), 直接 409, 让调用方先 close-all 再下
//
// 返回 body 在覆盖发生时会附加 `overrode: {...}` 字段, 让调用方能感知到旧 pending 被替换.
/**
 * /pending-order 的可复用实现.
 *
 * @param {object} opts
 * @param {'long'|'short'} opts.direction
 * @param {string} [opts.source='pending_order_api']
 * @param {string} [opts.label]
 * @param {boolean} [opts.replace=true]   false 时同方向有 pending 直接 409, 不自动覆盖
 * @returns {Promise<{status:number, body:object}>}
 */
async function pendingOrderImpl(opts = {}) {
  const direction = opts.direction;
  if (!['long', 'short'].includes(direction)) {
    return { status: 400, body: { ok: false, error: 'direction must be long|short' } };
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return {
      status: 409,
      body: { ok: false, error: 'auto_trade_disabled', hint: '请先开启「自动下单」总开关再下挂单信号' },
    };
  }

  // 来源标记 sanitize: 防外部传特殊字符破坏飞书/日志, 仅留 [a-zA-Z0-9_\-.], 长度上限 32
  const rawSource = typeof opts.source === 'string' ? opts.source : '';
  const cleanedSource = rawSource.trim().replace(/[^a-zA-Z0-9_\-.]/g, '').slice(0, 32);
  const source = cleanedSource || 'pending_order_api';
  const label = typeof opts.label === 'string' ? opts.label.slice(0, 64) : null;
  const replace = opts.replace !== false;   // 默认 true

  // 同方向 active 真实仓位 → 绝不覆盖 (会重复下单 / 改写实际持仓状态)
  const before = state.getPosition(direction);
  if (before && before.active) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'already_active',
        hint: `${direction} 已有真实持仓 (entry=${before.entryPrice}), /pending-order 不允许覆盖真实仓位; 请先 POST /api/auto-trade/close-all-positions 或 /reset 后重试`,
        position: before,
      },
    };
  }

  // 同方向 pending → 按 replace 决定: 默认覆盖, false 时 409 拒绝
  let overridden = null;
  if (before && before.pending) {
    if (!replace) {
      return {
        status: 409,
        body: {
          ok: false,
          error: 'already_pending',
          hint: `${direction} 已有 pending 计划 (entry=${before.pendingPlan?.entry}); 想覆盖请去掉 replace=false 或先 POST /cancel-pending`,
          position: before,
        },
      };
    }
    overridden = state.cancelPending(direction, 'pending_order_override');
    if (overridden) {
      console.log(`[trade.router] 🔄 /pending-order ${direction} 覆盖式生效: 取消旧 pending entry=${overridden.pendingPlan?.entry} armed=${overridden.pendingArmedAt} (source=${source}${label ? ` label=${label}` : ''})`);
      try { exec.fireMonitorCancel({ direction }); } catch (_) {}
      const titleEmoji = direction === 'long' ? '📈' : '📉';
      exec.notify({
        type: 'pending_cancelled',
        title: `🔄 ${titleEmoji} ${direction.toUpperCase()} 旧 pending 被新挂单信号覆盖`,
        lines: [
          `symbol: ${cfg.symbol}`,
          `来源: ${source}` + (label ? ` (${label})` : ''),
          `原 entry: ${overridden.pendingPlan?.entry}`,
          `原 SL/TP1: ${overridden.pendingPlan?.sl} / ${overridden.pendingPlan?.tp1}`,
          `arm 时间: ${cnTime(overridden.pendingArmedAt)}`,
          `逻辑: 外部 API 收到新挂单信号 → 自动取消旧 pending → 即将按新 plan arm`,
        ],
      });
    }
  }

  // 真正的下单逻辑: 与 manual-open 同源, 走 regime plan 优先 / ATR 回退 → processSignal arm pending
  const r = await manualOpenImpl({ direction, source });

  // 把 override 信息回传给调用方 (上游策略源能感知"上一笔 pending 被这条信号替换掉了")
  if (overridden && r.body && typeof r.body === 'object') {
    r.body.overrode = {
      direction,
      previousEntry: overridden.pendingPlan?.entry ?? null,
      previousSl: overridden.pendingPlan?.sl ?? null,
      previousTp1: overridden.pendingPlan?.tp1 ?? null,
      previousTp2: overridden.pendingPlan?.tp2 ?? null,
      previousTp3: overridden.pendingPlan?.tp3 ?? null,
      armedAt: overridden.pendingArmedAt,
    };
  }
  if (label && r.body && typeof r.body === 'object') {
    r.body.label = label;
  }
  return r;
}

router.post('/pending-order', requireAdmin, async (req, res) => {
  const r = await pendingOrderImpl({
    direction: req.body?.direction,
    source: req.body?.source,
    label: req.body?.label,
    replace: req.body?.replace,
  });
  res.status(r.status).json(r.body);
});

// ============ POST /market-order: 对外市价立即开仓信号入口 ============
//
// 与 /pending-order 的差异:
//   - /pending-order: 限价挂单 — 价格回踩到 entry 才真下单 (sig.market 不传, 走 PENDING 分支)
//   - /market-order : ⚡ **立即市价** — 不等回踩, 收到信号就以当下 WS 市价 forwardOpen + 写 active 仓位
//
// 价位策略 (用户硬性要求 plan_first):
//   1) 有 regime tradePlan 且方向匹配 → TP/SL/仓位 用 plan, entry 由 immediate 分支自动覆盖为市价
//      (processSignal line "if (source==='regime_plan') entryPrice = marketPrice" 已处理)
//   2) 否则 → ATR 动态回退 (computeManualFallbackLevels(direction, marketPrice, false))
//
// 冲突处理 (用户硬性要求 block_active_only):
//   - 同方向 active 真实持仓 → 直接 409 (绝不在已有仓位上叠加, 防止误触发双开)
//   - 同方向 pending → 自动取消旧 pending 后立即市价开仓 (覆盖式, 与 firePriceTrigger / pending-order 对齐)
//
// body: {
//   direction: 'long' | 'short',                   // 必填
//   source?: string,                                // 可选, 调用方标记 (sanitize 后写入飞书/日志, 长度<=32)
//   label?: string,                                 // 可选, 描述信号源 (如 "TV-BTC-Strategy")
//   position_size?: string|number                   // 可选, 覆盖默认 / regime 置信度仓位 (如 "20%")
// }
//
// 鉴权: X-Auth-Token (CONFIG_AUTH_TOKEN), 与 /pending-order 同级 — 会真实下单, 不能裸奔.
/**
 * /market-order 的可复用实现.
 *
 * @param {object} opts
 * @param {'long'|'short'} opts.direction
 * @param {string} [opts.source='market_order_api']
 * @param {string} [opts.label]
 * @param {string|number} [opts.position_size]   覆盖默认 / regime 置信度仓位
 * @returns {Promise<{status:number, body:object}>}
 */
async function marketOrderImpl(opts = {}) {
  const direction = opts.direction;
  if (!['long', 'short'].includes(direction)) {
    return { status: 400, body: { ok: false, error: 'direction must be long|short' } };
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return {
      status: 409,
      body: { ok: false, error: 'auto_trade_disabled', hint: '请先开启「自动下单」总开关再下市价信号' },
    };
  }

  const rawSource = typeof opts.source === 'string' ? opts.source : '';
  const cleanedSource = rawSource.trim().replace(/[^a-zA-Z0-9_\-.]/g, '').slice(0, 32);
  const source = cleanedSource || 'market_order_api';
  const label = typeof opts.label === 'string' ? opts.label.slice(0, 64) : null;

  // 同方向 active 真实仓位 → 绝不叠加 (会重复下单 / 改写实际持仓状态)
  const before = state.getPosition(direction);
  if (before && before.active) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'already_active',
        hint: `${direction} 已有真实持仓 (entry=${before.entryPrice}), /market-order 不允许在已有仓位上叠加; 请先 POST /api/auto-trade/close-all-positions 或 /reset 后重试`,
        position: before,
      },
    };
  }

  // 同方向 pending → 自动取消 (覆盖式, 与 /pending-order / firePriceTrigger 一致)
  let overridden = null;
  if (before && before.pending) {
    overridden = state.cancelPending(direction, 'market_order_override');
    if (overridden) {
      console.log(`[trade.router] 🔄 /market-order ${direction} 覆盖式生效: 取消旧 pending entry=${overridden.pendingPlan?.entry} armed=${overridden.pendingArmedAt} (source=${source}${label ? ` label=${label}` : ''})`);
      try { exec.fireMonitorCancel({ direction }); } catch (_) {}
      const titleEmoji = direction === 'long' ? '📈' : '📉';
      exec.notify({
        type: 'pending_cancelled',
        title: `🔄 ${titleEmoji} ${direction.toUpperCase()} 旧 pending 被新市价信号覆盖`,
        lines: [
          `symbol: ${cfg.symbol}`,
          `来源: ${source}` + (label ? ` (${label})` : ''),
          `原 entry: ${overridden.pendingPlan?.entry}`,
          `原 SL/TP1: ${overridden.pendingPlan?.sl} / ${overridden.pendingPlan?.tp1}`,
          `arm 时间: ${cnTime(overridden.pendingArmedAt)}`,
          `逻辑: 外部 API 收到新市价信号 → 自动取消旧 pending → 即将立即市价开仓`,
        ],
      });
    }
  }

  // 构造信号: market=true 强制 processSignal 走 immediate 分支 (无视 PENDING_MODE 默认值)
  // 价位策略 plan_first: 有 plan → TP/SL/仓位用 plan; 无 plan → ATR 回退
  const sig = {
    token: cfg.token,
    action: direction === 'long' ? 'open_long' : 'open_short',
    symbol: cfg.symbol,
    market: true,
  };
  if (opts.position_size != null) sig.position_size = opts.position_size;

  const planLv = planLevelsFromRegime(direction);
  if (!planLv) {
    // 无 regime plan: ATR 动态回退 (与 manualOpenImpl 同算法, 但 isPending=false 不回踩入场)
    const marketPrice = priceFeed.getStatus().lastPrice;
    if (!Number.isFinite(marketPrice)) {
      return {
        status: 503,
        body: { ok: false, error: 'price_feed_not_ready', hint: 'WS 行情尚未就绪, 无法以市价开仓' },
      };
    }
    let lv;
    try {
      lv = computeManualFallbackLevels(direction, marketPrice, false);
    } catch (e) {
      return { status: 400, body: { ok: false, error: e.message } };
    }
    const validate = validateManualLevels(direction, lv.entry, lv.tp1, lv.tp2, lv.tp3, lv.sl);
    if (!validate.ok) {
      return { status: 400, body: { ok: false, error: 'manual_levels_invalid:' + validate.reason, segments: validate.segments } };
    }
    sig.entry = lv.entry;
    sig.stop_loss = lv.sl;
    sig.tp1 = lv.tp1; sig.tp2 = lv.tp2; sig.tp3 = lv.tp3;
    if (sig.position_size == null) {
      let getLatestPlan;
      try { getLatestPlan = require('../regimeModule').getLatestPlan; } catch (e) {}
      const planInfo = getLatestPlan ? getLatestPlan() : null;
      const posPct = planInfo?.tradePlan?.suggestedPositionPct || 50;
      sig.position_size = `${posPct}%`;
    }
    sig._priceSource = 'market_order_atr';
  } else {
    // 有 regime plan: TP/SL/仓位 用 plan, entry 由 immediate 分支用 marketPrice 自动覆盖
    sig._priceSource = 'market_order_plan';
  }

  const r = await processSignal(sig, { source });

  if (overridden && r.body && typeof r.body === 'object') {
    r.body.overrode = {
      direction,
      previousEntry: overridden.pendingPlan?.entry ?? null,
      previousSl: overridden.pendingPlan?.sl ?? null,
      previousTp1: overridden.pendingPlan?.tp1 ?? null,
      previousTp2: overridden.pendingPlan?.tp2 ?? null,
      previousTp3: overridden.pendingPlan?.tp3 ?? null,
      armedAt: overridden.pendingArmedAt,
    };
  }
  if (label && r.body && typeof r.body === 'object') {
    r.body.label = label;
  }
  return r;
}

/**
 * 市价立即开仓信号 — 统一收集器.
 *
 * 兼容 5 种调用形态 (路径 × 方法 × 参数位置), 全部走同一个 marketOrderImpl:
 *   1. POST /market-order           body: { direction, source, label, position_size }   (旧, 与之前完全一致)
 *   2. POST /marker-order           body: 同上                                           (兼容拼写错误)
 *   3. GET  /market-order?direction=long&token=xxx                                        (URL 直接喊单)
 *   4. GET  /marker-order?direction=long&token=xxx                                        (热力图工具用)
 *   5. POST /market-order 带 query  混合传参 (header token + body params, 或反过来)
 *
 * 所有路径都走 requireAdmin (token 来源已扩展: header / Bearer / query / body 任一即可).
 *
 * 参数取值优先级: body > query (POST 时 body 优先, GET 时只有 query)
 *   - direction:     'long' | 'short'  必填
 *   - source:        审计标签 (默认 'market_order')
 *   - label:         任意字符串, 会回填到响应 body
 *   - position_size: 仓位百分比, 不传则用 cfg.defaultPositionSize 或 plan 置信度
 */
function _readMarketOrderParams(req) {
  return {
    direction: req.body?.direction || req.query?.direction,
    source: req.body?.source || req.query?.source,
    label: req.body?.label || req.query?.label,
    position_size: req.body?.position_size || req.query?.position_size,
  };
}

async function _handleMarketOrder(req, res) {
  const r = await marketOrderImpl(_readMarketOrderParams(req));
  res.status(r.status).json(r.body);
}

router.post('/market-order', requireAdmin, _handleMarketOrder);
router.get('/market-order',  requireAdmin, _handleMarketOrder);
// 拼写兼容 (热力图工具用的 URL 是 /marker-order, 与 /market-order 同源)
router.post('/marker-order', requireAdmin, _handleMarketOrder);
router.get('/marker-order',  requireAdmin, _handleMarketOrder);

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
/**
 * /manual-follow 的可复用实现: 抽出来供:
 *   1) HTTP 端点 POST /api/auto-trade/manual-follow (用户点击 UI 按钮)
 *   2) riskEngine.firePriceTrigger 价格触发器命中后 in-process 调用
 *
 * @param {object} opts
 * @param {'long'|'short'} opts.direction
 * @param {string} [opts.source='manual_follow']
 * @param {string|number} [opts.position_size]  覆盖默认 / regime 置信度仓位
 * @returns {Promise<{status:number, body:object}>}
 */
async function manualFollowImpl(opts = {}) {
  const direction = opts.direction;
  if (!['long', 'short'].includes(direction)) {
    return { status: 400, body: { ok: false, error: 'direction must be long|short' } };
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return {
      status: 409,
      body: { ok: false, error: 'auto_trade_disabled', hint: '请先开启「自动下单」总开关再手动追单' },
    };
  }

  const marketPrice = priceFeed.getStatus().lastPrice;
  if (!Number.isFinite(marketPrice)) {
    return {
      status: 503,
      body: { ok: false, error: 'price_feed_not_ready', hint: 'WS 行情尚未就绪, 无法以市价进行手动追单' },
    };
  }

  let lv;
  try {
    lv = computeManualFallbackLevels(direction, marketPrice, false);
  } catch (e) {
    return { status: 400, body: { ok: false, error: e.message } };
  }
  const validate = validateManualLevels(direction, lv.entry, lv.tp1, lv.tp2, lv.tp3, lv.sl);
  if (!validate.ok) {
    return { status: 400, body: { ok: false, error: 'manual_levels_invalid:' + validate.reason, segments: validate.segments } };
  }

  let getLatestPlan;
  try { getLatestPlan = require('../regimeModule').getLatestPlan; } catch (e) {}
  const planInfo = getLatestPlan ? getLatestPlan() : null;
  const posPct = opts.position_size != null
    ? parseFloat(opts.position_size)
    : (planInfo?.tradePlan?.suggestedPositionPct || 50);

  const sig = {
    token: cfg.token,
    action: direction === 'long' ? 'open_long' : 'open_short',
    symbol: cfg.symbol,
    market: true,
    immediate: true,
    entry: lv.entry,
    stop_loss: lv.sl,
    tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3,
    position_size: `${posPct}%`,
    _priceSource: 'manual_follow_atr',
  };

  return processSignal(sig, { source: opts.source || 'manual_follow', skipRegimePlan: true });
}

router.post('/manual-follow', requireAdmin, async (req, res) => {
  const r = await manualFollowImpl({
    direction: req.body?.direction,
    source: 'manual_follow',
    position_size: req.body?.position_size,
  });
  res.status(r.status).json(r.body);
});

// ============ POST /adjust-levels: 手动调整 TP1/TP2/TP3/SL ============
//
// body: { direction: 'long'|'short', tp1?:number, tp2?:number, tp3?:number, sl?:number, entry?:number }
//
// 适用场景:
//   - active 持仓: 改 TP/SL (entry 字段忽略). 已触发的 TP level 自动跳过 (skipped 字段返回)
//   - pending 挂单: 改 entry/TP/SL (任意字段)
//
// 自动按方向校验合法性 (tp 升降序 + sl 与 entry 关系), 不通过则 400 拒绝并保留旧值.
// 改完同步推送一条 fireMonitorOpen 把新点位刷给监控通道, 与 riskEngine 共享 state,
// 下一 tick 立即按新价位 evaluate.
router.post('/adjust-levels', requireAdmin, (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  const before = state.getPosition(direction);
  if (!before) return res.status(404).json({ ok: false, error: 'no_position' });

  // 解析 incoming levels (只取传了的字段, undefined 跳过)
  const incoming = {};
  ['tp1', 'tp2', 'tp3', 'sl', 'entry'].forEach((k) => {
    if (req.body && req.body[k] != null) incoming[k] = Number(req.body[k]);
  });
  if (Object.keys(incoming).length === 0) {
    return res.status(400).json({ ok: false, error: 'no_levels_provided' });
  }

  // ---------- pending 分支 ----------
  if (before.pending && before.pendingPlan) {
    const plan = before.pendingPlan;
    const merged = {
      entry: incoming.entry != null ? incoming.entry : Number(plan.entry),
      tp1:   incoming.tp1   != null ? incoming.tp1   : Number(plan.tp1),
      tp2:   incoming.tp2   != null ? incoming.tp2   : Number(plan.tp2),
      tp3:   incoming.tp3   != null ? incoming.tp3   : Number(plan.tp3),
      sl:    incoming.sl    != null ? incoming.sl    : Number(plan.sl),
    };
    const v = validateManualLevels(direction, merged.entry, merged.tp1, merged.tp2, merged.tp3, merged.sl);
    if (!v.ok) {
      return res.status(400).json({ ok: false, error: 'invalid_levels:' + v.reason, target: 'pending', merged });
    }
    const r = state.updatePendingLevels(direction, incoming);
    if (!r.ok) return res.status(409).json({ ok: false, error: r.error });

    exec.notify({
      type: 'pending_armed',
      title: `✏️ ${direction.toUpperCase()} 挂单价位已手动调整`,
      lines: [
        `symbol: ${config.get().symbol}`,
        `方向: ${direction} (pending)`,
        `entry: ${r.prev.entry} → ${r.next.entry}`,
        `SL  : ${r.prev.sl} → ${r.next.sl}`,
        `TP1 : ${r.prev.tp1} → ${r.next.tp1}`,
        `TP2 : ${r.prev.tp2} → ${r.next.tp2}`,
        `TP3 : ${r.prev.tp3} → ${r.next.tp3}`,
        `操作来源: ${req.body?.source || 'manual_ui'}`,
      ],
    });
    exec.fireMonitorOpen({
      direction,
      entry: r.next.entry,
      tp1: r.next.tp1, tp2: r.next.tp2, tp3: r.next.tp3,
      sl: r.next.sl,
      comment: `挂单点位调整 · manual_ui · entry=${r.next.entry}`,
    });
    return res.json({ ok: true, target: 'pending', prev: r.prev, next: r.next, skipped: r.skipped });
  }

  // ---------- active 分支 ----------
  if (!before.active) return res.status(409).json({ ok: false, error: 'no_active_or_pending_position' });

  // 校验时使用的 entry = 持仓 entryPrice (不可改)
  // tp/sl 用 incoming 优先, 缺省回退现值
  const entry = Number(before.entryPrice);
  const merged = {
    tp1: incoming.tp1 != null ? incoming.tp1 : Number(before.tp1),
    tp2: incoming.tp2 != null ? incoming.tp2 : Number(before.tp2),
    tp3: incoming.tp3 != null ? incoming.tp3 : Number(before.tp3),
    sl:  incoming.sl  != null ? incoming.sl  : Number(before.currentStopLoss),
  };
  // ⭐ 用 active 持仓专用校验 (考虑 tpHit, 修复 TP1 触发后无法上移 SL 的 bug)
  // 与 validateManualLevels 的差别见函数注释: 关键是 TP1 已触发后 SL 可以放飞到 entry 之上
  const v = validateAdjustActiveLevels(direction, entry, merged, before.tpHit || {});
  if (!v.ok) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_levels:' + v.reason,
      hint: v.hint,         // 中文化的具体冲突说明, 前端可直接显示
      target: 'active',
      entry,
      merged,
      tpHit: before.tpHit || {},
    });
  }
  // active 仓位不允许改 entry (改了就破坏成交价审计) — 显式提示
  if (incoming.entry != null && Number(incoming.entry) !== entry) {
    return res.status(400).json({ ok: false, error: 'cannot_change_entry_on_active', entry });
  }

  const r = state.updateActiveLevels(direction, {
    tp1: incoming.tp1, tp2: incoming.tp2, tp3: incoming.tp3, sl: incoming.sl,
  });
  if (!r.ok) return res.status(409).json({ ok: false, error: r.error });

  exec.notify({
    type: 'open_ok',
    title: `✏️ ${direction.toUpperCase()} 持仓 TP/SL 已手动调整`,
    lines: [
      `symbol: ${config.get().symbol}`,
      `方向: ${direction} (active)`,
      `入场价: ${entry}`,
      `SL : ${r.prev.currentStopLoss} → ${r.next.currentStopLoss}`,
      `TP1: ${r.prev.tp1} → ${r.next.tp1}` + (before.tpHit?.tp1 ? ' (已触发, 跳过)' : ''),
      `TP2: ${r.prev.tp2} → ${r.next.tp2}` + (before.tpHit?.tp2 ? ' (已触发, 跳过)' : ''),
      `TP3: ${r.prev.tp3} → ${r.next.tp3}` + (before.tpHit?.tp3 ? ' (已触发, 跳过)' : ''),
      r.skipped.length ? `跳过项: ${r.skipped.join(', ')}` : null,
      `操作来源: ${req.body?.source || 'manual_ui'}`,
    ].filter(Boolean),
  });
  exec.fireMonitorOpen({
    direction,
    entry,
    tp1: r.next.tp1, tp2: r.next.tp2, tp3: r.next.tp3,
    sl: r.next.currentStopLoss,
    comment: `持仓点位调整 · manual_ui · entry=${entry}`,
  });
  return res.json({
    ok: true, target: 'active', entry,
    prev: { tp1: r.prev.tp1, tp2: r.prev.tp2, tp3: r.prev.tp3, sl: r.prev.currentStopLoss },
    next: { tp1: r.next.tp1, tp2: r.next.tp2, tp3: r.next.tp3, sl: r.next.currentStopLoss },
    skipped: r.skipped,
  });
});

// ============ POST /manual-fire: 一键触发 TP1/TP2/TP3/SL ============
//
// body: { direction: 'long'|'short', level: 'tp_1'|'tp_2'|'tp_3'|'sl', set_protection_sl?:boolean }
//
// 设计:
//   - 完全复用 processSignal 的 take_profit/stop_loss 分支, 与外部 webhook / riskEngine
//     共享同一把幂等锁 (state.markTpHit / state.closeAndUnlock), 不会重复 fire
//   - level=tp_1 默认按当前 cfg.tp1Protection 决定是否同时设置保本止损; 也支持 body.set_protection_sl 强制覆盖
//   - 仅对 active 持仓有效; pending 不可触发 (没成交, 触发无意义), 直接 409
//   - 强制 cfg.token 校验通过 (与 webhook 一致)
router.post('/manual-fire', requireAdmin, async (req, res) => {
  const direction = req.body?.direction;
  const level = req.body?.level;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  if (!['tp_1', 'tp_2', 'tp_3', 'sl'].includes(level)) {
    return res.status(400).json({ ok: false, error: "level must be tp_1|tp_2|tp_3|sl" });
  }
  const cfg = config.get();
  if (!cfg.enabled) {
    return res.status(409).json({ ok: false, error: 'auto_trade_disabled', hint: '请先开启自动下单总开关' });
  }
  const p = state.getPosition(direction);
  if (!p || !p.active) {
    return res.status(409).json({ ok: false, error: 'no_active_position', direction });
  }

  let sig;
  if (level === 'sl') {
    sig = { token: cfg.token, action: 'stop_loss', symbol: cfg.symbol, direction, trigger: 'manual_fire' };
  } else {
    // TP1 默认跟随 cfg.tp1Protection; 用户可显式传 set_protection_sl 覆盖
    const setProt = req.body?.set_protection_sl != null
      ? !!req.body.set_protection_sl
      : (level === 'tp_1' && cfg.tp1Protection !== false);
    sig = {
      token: cfg.token, action: 'take_profit', symbol: cfg.symbol,
      direction, trigger: level, set_protection_sl: setProt,
    };
  }

  const r = await processSignal(sig, { source: 'manual_fire' });
  res.status(r.status).json({ ...r.body, level, direction });
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

// ============ POST /toggle-direction: 方向开关 (禁止做多 / 禁止做空) ============
// body: { direction: 'long'|'short', disabled: true|false }
//
// 与 /toggle 同级, 不强制 X-Auth-Token (只切单个布尔, 想切其它字段走 /config).
// 行为见 cfg.disableLong / cfg.disableShort 注释:
//   - 仅拦"新开仓信号" (processSignal open_long/open_short 分支前置 409)
//   - 不影响已有 active 持仓的 TP/SL 兜底
//   - 不影响已有 pending 的 fill (旧决策, 想撤请显式 /cancel-pending)
//   - 不影响平仓信号 (take_profit / stop_loss)
router.post('/toggle-direction', (req, res) => {
  const direction = req.body?.direction;
  if (!['long', 'short'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short' });
  }
  if (typeof req.body?.disabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'disabled must be boolean' });
  }
  const key = direction === 'long' ? 'disableLong' : 'disableShort';
  const next = !!req.body.disabled;
  const updated = config.patch({ [key]: next });
  const directionZh = direction === 'long' ? '做多' : '做空';

  // 给用户一个清晰的提示: 这个开关有什么影响, 同方向已有 pending/active 怎么办
  const before = state.getPosition(direction);
  const lines = [
    next
      ? `⛔ ${direction.toUpperCase()} 方向所有新开仓信号都会被拦截 (signal / pending-order / market-order / firePriceTrigger 全部覆盖)`
      : `✅ ${direction.toUpperCase()} 方向恢复接收新开仓信号`,
    `不影响: 已有 ${direction.toUpperCase()} 持仓的 TP/SL 兜底, 已有 pending 触达 entry 的 fill, 平仓信号`,
  ];
  if (next && before?.active) {
    lines.push(`⚠️ 当前 ${direction.toUpperCase()} 已有 active 持仓 (entry=${before.entryPrice}), TP/SL 仍会正常触发, 仅拦新信号`);
  }
  if (next && before?.pending) {
    lines.push(`⚠️ 当前 ${direction.toUpperCase()} 已有 pending 计划 (entry=${before.pendingPlan?.entry}), 不会自动撤; 想撤请 POST /api/auto-trade/cancel-pending`);
  }
  exec.notify({
    type: next ? 'reset' : 'unlock',
    title: next ? `⛔ 已禁止${directionZh}` : `✅ 已恢复${directionZh}`,
    lines,
  });
  console.log(`[trade.router] 方向开关切换: ${key}=${next} (${directionZh})`);
  res.json({
    ok: true,
    direction,
    [key]: updated[key],
    disableLong: !!updated.disableLong,
    disableShort: !!updated.disableShort,
  });
});

// ============ POST /direction-guard: 价格围栏配置 (自动方向开关) ============
//
// body: {
//   direction: 'long' | 'short',                 // 必填
//   enabled?: boolean,                            // 可选, 启停该方向的围栏
//   threshold?: number | null,                    // 可选, 基准价 (null = 清空)
//   hysteresisPct?: number,                       // 可选, 滞后缓冲 % (全局, 不分方向)
//   minSwitchIntervalMs?: number                  // 可选, 最小切换间隔 (全局)
// }
//
// 行为:
//   - patch 写盘后立即用 priceFeed.lastPrice 调一次 evaluateDirectionGuard,
//     不必等下一帧 tick — 用户能立刻看到状态切换 (autoDisableLong/Short).
//   - threshold 改成 null / 0 / NaN 视为清空, 该方向围栏自动禁用 (并复位 autoDisable*=false).
//   - hysteresisPct / minSwitchIntervalMs 是全局参数, 不写 direction 也能改.
//
// 与 /toggle-direction 同级, 不强制 X-Auth-Token (只切布尔/数值, 不会真实下单).
router.post('/direction-guard', (req, res) => {
  const body = req.body || {};
  const direction = body.direction;

  // 全局参数 patch (允许仅改 hysteresisPct / minSwitchIntervalMs 不传 direction)
  const guardPatch = {};
  if (body.hysteresisPct != null) {
    const v = parseFloat(body.hysteresisPct);
    if (!Number.isFinite(v) || v < 0 || v > 50) {
      return res.status(400).json({ ok: false, error: 'hysteresisPct must be 0~50' });
    }
    guardPatch.hysteresisPct = v;
  }
  if (body.minSwitchIntervalMs != null) {
    const v = parseInt(body.minSwitchIntervalMs, 10);
    if (!Number.isFinite(v) || v < 0 || v > 3600000) {
      return res.status(400).json({ ok: false, error: 'minSwitchIntervalMs must be 0~3600000' });
    }
    guardPatch.minSwitchIntervalMs = v;
  }

  // 单方向参数 patch
  if (direction != null) {
    if (!['long', 'short'].includes(direction)) {
      return res.status(400).json({ ok: false, error: 'direction must be long|short' });
    }
    const cur = config.get().directionGuard?.[direction] || {};
    const next = { enabled: !!cur.enabled, threshold: cur.threshold ?? null };
    if (body.enabled != null) next.enabled = !!body.enabled;
    if ('threshold' in body) {
      const tv = body.threshold === null || body.threshold === '' ? null : parseFloat(body.threshold);
      if (tv === null) {
        next.threshold = null;
        next.enabled = false;   // 阈值清空 → 强制禁用, 否则 evaluateDirectionGuard 会跳过, 导致开关"卡 ON"
      } else {
        if (!Number.isFinite(tv) || tv <= 0) {
          return res.status(400).json({ ok: false, error: 'threshold must be positive number or null' });
        }
        next.threshold = tv;
      }
    }
    guardPatch[direction] = next;
  }

  if (Object.keys(guardPatch).length === 0) {
    return res.status(400).json({ ok: false, error: 'no_changes', hint: '请提供 direction+enabled/threshold 或 hysteresisPct / minSwitchIntervalMs' });
  }

  const updated = config.patch({ directionGuard: guardPatch });

  // 立即用最新价跑一次评估, 让 autoDisableLong/Short 立刻反映新阈值的判定结果.
  // priceFeed 没就绪时静默跳过 (下一帧 tick 自然会评估).
  try {
    const lastPrice = priceFeed.lastPrice;
    if (Number.isFinite(lastPrice)) riskEngine.evaluateDirectionGuard(lastPrice);
  } catch (e) {
    console.warn('[trade.router] /direction-guard 立即评估失败:', e?.message || e);
  }

  // 重新读 cfg, 拿到 evaluateDirectionGuard 可能写入的最新 autoDisable* 状态
  const finalCfg = config.get();
  const dg = finalCfg.directionGuard || {};

  // 通知: 仅在用户改了 direction 启停/阈值时推; 改全局参数不推 (避免噪音)
  if (direction != null) {
    const dirZh = direction === 'long' ? '做多' : '做空';
    const slot = dg[direction] || {};
    const lines = [
      `symbol: ${finalCfg.symbol}`,
      `方向: ${direction}`,
      `启用: ${slot.enabled ? '✅ 是' : '⛔ 否'}`,
      slot.threshold != null ? `基准价: ${Number(slot.threshold).toFixed(2)}` : '基准价: -- (未设置)',
      `滞后缓冲: ${dg.hysteresisPct ?? '--'}% · 最小切换间隔: ${dg.minSwitchIntervalMs ?? '--'}ms`,
      direction === 'long'
        ? `逻辑: 市价 < 基准 → 自动禁多, 回升至 基准 × (1+${dg.hysteresisPct ?? 0}%) → 解除`
        : `逻辑: 市价 > 基准 → 自动禁空, 回落至 基准 × (1-${dg.hysteresisPct ?? 0}%) → 解除`,
    ];
    exec.notify({
      type: slot.enabled ? 'unlock' : 'reset',
      title: slot.enabled ? `🤖 价格围栏(${direction.toUpperCase()}) 已${slot.threshold != null ? '更新' : '启用但未设基准'}` : `🤖 价格围栏(${direction.toUpperCase()}) 已禁用`,
      lines,
    });
  }
  console.log(`[trade.router] /direction-guard updated: directionGuard=`, updated.directionGuard, 'autoDisableLong=', !!finalCfg.autoDisableLong, 'autoDisableShort=', !!finalCfg.autoDisableShort);
  res.json({
    ok: true,
    directionGuard: finalCfg.directionGuard,
    autoDisableLong: !!finalCfg.autoDisableLong,
    autoDisableShort: !!finalCfg.autoDisableShort,
  });
});

// ============ POST /regime-guard: Regime 守卫配置 (基于 1H 趋势状态自动方向开关) ============
//
// body 字段 (全部可选, 至少一个非空):
//   enabled?:                 boolean   总开关
//   blockLongOnStrongBear?:   boolean   STRONG_BEAR 时是否禁多
//   blockShortOnStrongBull?:  boolean   STRONG_BULL 时是否禁空
//   blockBothOnPanic?:        boolean   PANIC 时是否双向禁
//   blockBothOnUnclear?:      boolean   UNCLEAR 时是否双向禁 (默认 off, 太严)
//   minConfidence?:           'low' | 'medium' | 'high'
//   minSwitchIntervalMs?:     number    最小切换间隔
//
// 行为:
//   - patch 写盘后立即调一次 evaluateRegimeGuard, 不必等下一轮 30s 定时器
//   - 总开关 enabled=false → regimeAutoDisable* 自动复位为 false (在 evaluateRegimeGuard 里实现)
//   - 与 /toggle-direction、/direction-guard 同级, 不强制 X-Auth-Token
router.post('/regime-guard', (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.enabled != null)                  patch.enabled = !!body.enabled;
  if (body.blockLongOnStrongBear != null)    patch.blockLongOnStrongBear = !!body.blockLongOnStrongBear;
  if (body.blockShortOnStrongBull != null)   patch.blockShortOnStrongBull = !!body.blockShortOnStrongBull;
  if (body.blockBothOnPanic != null)         patch.blockBothOnPanic = !!body.blockBothOnPanic;
  if (body.blockBothOnUnclear != null)       patch.blockBothOnUnclear = !!body.blockBothOnUnclear;
  if (body.minConfidence != null) {
    if (!['low', 'medium', 'high'].includes(body.minConfidence)) {
      return res.status(400).json({ ok: false, error: 'minConfidence must be low|medium|high' });
    }
    patch.minConfidence = body.minConfidence;
  }
  if (body.minSwitchIntervalMs != null) {
    const v = parseInt(body.minSwitchIntervalMs, 10);
    if (!Number.isFinite(v) || v < 0 || v > 3600000) {
      return res.status(400).json({ ok: false, error: 'minSwitchIntervalMs must be 0~3600000' });
    }
    patch.minSwitchIntervalMs = v;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'no_changes', hint: '请提供 enabled / blockLong* / blockShort* / blockBoth* / minConfidence / minSwitchIntervalMs 中至少一个' });
  }

  const updated = config.patch({ regimeGuard: patch });
  // 立即重新评估一次 — 让 regimeAutoDisable* 立刻反映新规则
  try { riskEngine.evaluateRegimeGuard(); }
  catch (e) { console.warn('[trade.router] /regime-guard 立即评估失败:', e?.message || e); }

  const finalCfg = config.get();
  // 通知: 仅在 enabled 切换时推 (避免改 minConfidence 等小调整也刷屏)
  if (body.enabled != null) {
    exec.notify({
      type: body.enabled ? 'unlock' : 'reset',
      title: body.enabled ? `📊 Regime 守卫已启用` : `📊 Regime 守卫已禁用`,
      lines: [
        `symbol: ${finalCfg.symbol}`,
        `规则: STRONG_BEAR→${finalCfg.regimeGuard?.blockLongOnStrongBear ? '拦多' : '不拦'} · STRONG_BULL→${finalCfg.regimeGuard?.blockShortOnStrongBull ? '拦空' : '不拦'}`,
        `      PANIC→${finalCfg.regimeGuard?.blockBothOnPanic ? '双向禁' : '不拦'} · UNCLEAR→${finalCfg.regimeGuard?.blockBothOnUnclear ? '双向禁' : '不拦'}`,
        `置信度门槛: ${finalCfg.regimeGuard?.minConfidence || '?'}`,
        `当前 subRegime=${finalCfg.regimeAutoLastSubRegime || '? (暖机中)'}, regimeAutoDisableLong=${!!finalCfg.regimeAutoDisableLong}, regimeAutoDisableShort=${!!finalCfg.regimeAutoDisableShort}`,
      ],
    });
  }
  console.log(`[trade.router] /regime-guard updated:`, updated.regimeGuard, 'regimeAutoDisableLong=', !!finalCfg.regimeAutoDisableLong, 'regimeAutoDisableShort=', !!finalCfg.regimeAutoDisableShort);
  res.json({
    ok: true,
    regimeGuard: finalCfg.regimeGuard,
    regimeAutoDisableLong: !!finalCfg.regimeAutoDisableLong,
    regimeAutoDisableShort: !!finalCfg.regimeAutoDisableShort,
    regimeAutoLastSubRegime: finalCfg.regimeAutoLastSubRegime || null,
    regimeAutoLastConfidence: finalCfg.regimeAutoLastConfidence || null,
    regimeAutoLastEvalAt: finalCfg.regimeAutoLastEvalAt || null,
  });
});

// ============ POST /risk-guard ============
//
// 配置风控套件 — UI 热更新入口. body 任意子段都允许部分更新:
//   {
//     softStopLoss: { enabled?, fastWindowMs?, fastPct?, normalPct?, protectAfterTouchPct?,
//                     trailingAfterTp1: { enabled?, stepPct? } },
//     timeExit: { enabled?, beforeTp1Ms?, beforeTp2Ms?, onlyIfLossingPct? },
//     hardSlCap: { enabled?, maxDistancePct? },
//     profitWithdraw: { enabled?, baselineUSD?, thresholdUSD? },
//     lossStreakBrake: { enabled?, thresholds? },
//     balanceGuard: { enabled?, minUSD? },
//   }
//
// 校验关键: 数值字段必须正数, ms 字段必须是合理时长, 否则 400.
// 走 config.patch (deepMerge), 不会清空未提供的子字段.
router.post('/risk-guard', requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch = {};
  const issues = [];

  // ---------- ⭐ 总开关 ----------
  // 顶层 enabled 字段 → 写到 cfg.riskGuardEnabled (与各子模块 .enabled 是独立位)
  if (body.enabled != null) {
    patch.riskGuardEnabled = !!body.enabled;
  }

  // ---------- softStopLoss ----------
  if (body.softStopLoss && typeof body.softStopLoss === 'object') {
    const ssl = {};
    const s = body.softStopLoss;
    if (s.enabled != null) ssl.enabled = !!s.enabled;
    if (s.fastWindowMs != null) {
      const v = parseInt(s.fastWindowMs, 10);
      if (!Number.isFinite(v) || v < 0 || v > 600000) {
        issues.push('softStopLoss.fastWindowMs must be 0~600000');
      } else { ssl.fastWindowMs = v; }
    }
    if (s.fastPct != null) {
      const v = parseFloat(s.fastPct);
      if (!Number.isFinite(v) || v <= 0 || v > 5) {
        issues.push('softStopLoss.fastPct must be 0~5');
      } else { ssl.fastPct = v; }
    }
    if (s.normalPct != null) {
      const v = parseFloat(s.normalPct);
      if (!Number.isFinite(v) || v <= 0 || v > 5) {
        issues.push('softStopLoss.normalPct must be 0~5');
      } else { ssl.normalPct = v; }
    }
    if (s.protectAfterTouchPct != null) {
      const v = parseFloat(s.protectAfterTouchPct);
      if (!Number.isFinite(v) || v <= 0 || v > 5) {
        issues.push('softStopLoss.protectAfterTouchPct must be 0~5');
      } else { ssl.protectAfterTouchPct = v; }
    }
    if (s.trailingAfterTp1 && typeof s.trailingAfterTp1 === 'object') {
      const t = {};
      if (s.trailingAfterTp1.enabled != null) t.enabled = !!s.trailingAfterTp1.enabled;
      if (s.trailingAfterTp1.stepPct != null) {
        const v = parseFloat(s.trailingAfterTp1.stepPct);
        if (!Number.isFinite(v) || v <= 0 || v > 5) {
          issues.push('softStopLoss.trailingAfterTp1.stepPct must be 0~5');
        } else { t.stepPct = v; }
      }
      if (Object.keys(t).length > 0) ssl.trailingAfterTp1 = t;
    }
    if (Object.keys(ssl).length > 0) patch.softStopLoss = ssl;
  }

  // ---------- timeExit ----------
  if (body.timeExit && typeof body.timeExit === 'object') {
    const te = {};
    const t = body.timeExit;
    if (t.enabled != null) te.enabled = !!t.enabled;
    if (t.beforeTp1Ms != null) {
      const v = parseInt(t.beforeTp1Ms, 10);
      if (!Number.isFinite(v) || v < 60000 || v > 86400000) {
        issues.push('timeExit.beforeTp1Ms must be 60000~86400000');
      } else { te.beforeTp1Ms = v; }
    }
    if (t.beforeTp2Ms != null) {
      const v = parseInt(t.beforeTp2Ms, 10);
      if (!Number.isFinite(v) || v < 60000 || v > 86400000) {
        issues.push('timeExit.beforeTp2Ms must be 60000~86400000');
      } else { te.beforeTp2Ms = v; }
    }
    if (t.onlyIfLossingPct !== undefined) {
      if (t.onlyIfLossingPct === null) te.onlyIfLossingPct = null;
      else {
        const v = parseFloat(t.onlyIfLossingPct);
        if (!Number.isFinite(v) || v < 0 || v > 5) {
          issues.push('timeExit.onlyIfLossingPct must be null or 0~5');
        } else { te.onlyIfLossingPct = v; }
      }
    }
    if (Object.keys(te).length > 0) patch.timeExit = te;
  }

  // ---------- hardSlCap ----------
  if (body.hardSlCap && typeof body.hardSlCap === 'object') {
    const h = {};
    if (body.hardSlCap.enabled != null) h.enabled = !!body.hardSlCap.enabled;
    if (body.hardSlCap.maxDistancePct != null) {
      const v = parseFloat(body.hardSlCap.maxDistancePct);
      if (!Number.isFinite(v) || v <= 0 || v > 5) {
        issues.push('hardSlCap.maxDistancePct must be 0~5');
      } else { h.maxDistancePct = v; }
    }
    if (Object.keys(h).length > 0) patch.hardSlCap = h;
  }

  // ---------- profitWithdraw ----------
  if (body.profitWithdraw && typeof body.profitWithdraw === 'object') {
    const p = {};
    if (body.profitWithdraw.enabled != null) p.enabled = !!body.profitWithdraw.enabled;
    if (body.profitWithdraw.baselineUSD != null) {
      const v = parseFloat(body.profitWithdraw.baselineUSD);
      if (!Number.isFinite(v) || v <= 0 || v > 1e9) {
        issues.push('profitWithdraw.baselineUSD must be 0~1e9');
      } else { p.baselineUSD = v; }
    }
    if (body.profitWithdraw.thresholdUSD != null) {
      const v = parseFloat(body.profitWithdraw.thresholdUSD);
      if (!Number.isFinite(v) || v <= 0 || v > 1e9) {
        issues.push('profitWithdraw.thresholdUSD must be 0~1e9');
      } else { p.thresholdUSD = v; }
    }
    if (Object.keys(p).length > 0) patch.profitWithdraw = p;
  }

  // ---------- lossStreakBrake ----------
  if (body.lossStreakBrake && typeof body.lossStreakBrake === 'object') {
    const l = {};
    if (body.lossStreakBrake.enabled != null) l.enabled = !!body.lossStreakBrake.enabled;
    if (body.lossStreakBrake.thresholds && typeof body.lossStreakBrake.thresholds === 'object') {
      // 校验每个 key/value
      const cleaned = {};
      let bad = false;
      for (const k of Object.keys(body.lossStreakBrake.thresholds)) {
        if (!/^\d+$/.test(k) || parseInt(k, 10) < 1 || parseInt(k, 10) > 100) { bad = true; break; }
        const v = body.lossStreakBrake.thresholds[k];
        const vNum = parseInt(v, 10);
        if (!Number.isFinite(vNum) || (vNum !== -1 && (vNum < 0 || vNum > 30 * 86400000))) { bad = true; break; }
        cleaned[k] = vNum;
      }
      if (bad) issues.push('lossStreakBrake.thresholds keys must be "1"~"100", values -1 or 0~30days(ms)');
      else l.thresholds = cleaned;
    }
    if (Object.keys(l).length > 0) patch.lossStreakBrake = l;
  }

  // ---------- balanceGuard ----------
  if (body.balanceGuard && typeof body.balanceGuard === 'object') {
    const b = {};
    if (body.balanceGuard.enabled != null) b.enabled = !!body.balanceGuard.enabled;
    if (body.balanceGuard.minUSD != null) {
      const v = parseFloat(body.balanceGuard.minUSD);
      if (!Number.isFinite(v) || v < 0 || v > 1e9) {
        issues.push('balanceGuard.minUSD must be 0~1e9');
      } else { b.minUSD = v; }
    }
    if (Object.keys(b).length > 0) patch.balanceGuard = b;
  }

  if (issues.length > 0) {
    return res.status(400).json({ ok: false, errors: issues });
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'no_changes' });
  }

  const cfgBefore = config.get();
  const masterToggled = patch.riskGuardEnabled != null
    && (!!patch.riskGuardEnabled) !== (cfgBefore.riskGuardEnabled !== false);
  config.patch(patch);
  const finalCfg = config.get();
  console.log('[trade.router] /risk-guard updated:', JSON.stringify(patch));

  // 总开关切换 → 推飞书 (其他子项调整不推, 避免刷屏)
  if (masterToggled) {
    const masterOn = finalCfg.riskGuardEnabled !== false;
    exec.notify({
      type: masterOn ? 'unlock' : 'reset',
      title: masterOn
        ? `🛡 风控套件已开启 (总开关)`
        : `⚠️ 风控套件已关闭 (总开关)`,
      lines: masterOn ? [
        `所有子模块按各自配置生效:`,
        `  · softStopLoss = ${finalCfg.softStopLoss?.enabled ? 'on' : 'off'}`,
        `  · timeExit = ${finalCfg.timeExit?.enabled ? 'on' : 'off'}`,
        `  · hardSlCap = ${finalCfg.hardSlCap?.enabled ? 'on' : 'off'}`,
        `  · lossStreakBrake = ${finalCfg.lossStreakBrake?.enabled ? 'on' : 'off'}`,
        `  · balanceGuard = ${finalCfg.balanceGuard?.enabled ? 'on' : 'off'}`,
        `  · profitWithdraw = ${finalCfg.profitWithdraw?.enabled ? 'on' : 'off'}`,
      ] : [
        `所有保护逻辑都被跳过 (软SL / 保本 / trailing / 时间退出 / hardSlCap / 连亏熔断 / 本金保护 / 提利润提醒)`,
        `子模块 .enabled 配置已保留, 重新打开总开关时立刻恢复`,
        `⚠️ 100x × 50% 滚仓裸奔风险极高, 仅在测试 / 临时调试时关闭`,
      ],
      isAlert: !masterOn,
    });
  }
  res.json({
    ok: true,
    riskGuard: {
      enabled: finalCfg.riskGuardEnabled !== false,
      softStopLoss: finalCfg.softStopLoss,
      timeExit: finalCfg.timeExit,
      hardSlCap: finalCfg.hardSlCap,
      profitWithdraw: finalCfg.profitWithdraw,
      lossStreakBrake: finalCfg.lossStreakBrake,
      balanceGuard: finalCfg.balanceGuard,
      lossStreak: finalCfg.lossStreak || 0,
      pausedUntilMs: finalCfg.pausedUntilMs || null,
      pausedReason: finalCfg.pausedReason || null,
      accountBalanceUSD: Number.isFinite(finalCfg.accountBalanceUSD) ? finalCfg.accountBalanceUSD : null,
    },
  });
});

// ============ POST /risk-guard/balance ============
//
// 用户上报当前账户余额 (USDT). 用于 balanceGuard / profitWithdraw 判定.
//
// body: { balance: <number> }
//
// ⚠️ 工具不会自动从交易所 API 拉余额 — 用户需要主动 POST 这个端点 (UI 上有"同步余额"按钮),
//   或者每次 fill/close 后自己估算. 工具内部不维护"自动估算余额", 因为接收方协议不一致,
//   工具不知道实际成交价/手续费. 让用户做 source of truth, 工具只用它做判定.
router.post('/risk-guard/balance', requireAdmin, (req, res) => {
  const v = parseFloat(req.body?.balance);
  if (!Number.isFinite(v) || v < 0 || v > 1e9) {
    return res.status(400).json({ ok: false, error: 'balance must be 0~1e9 (USDT)' });
  }
  config.patch({ accountBalanceUSD: v });
  console.log(`[trade.router] /risk-guard/balance updated: accountBalanceUSD=${v}`);
  res.json({ ok: true, accountBalanceUSD: v });
});

// ============ POST /risk-guard/resume ============
//
// 手动恢复风控暂停. 用于 lossStreakBrake -1 (手动暂停) 或 balanceGuard 触发后的恢复.
// body: { resetLossStreak?: boolean (默认 true) }
router.post('/risk-guard/resume', requireAdmin, (req, res) => {
  const cfg = config.get();
  if (cfg.enabled && !cfg.pausedUntilMs && !cfg.pausedReason) {
    return res.json({ ok: true, message: '已经处于运行状态, 无需恢复', enabled: true });
  }
  const resetLossStreak = req.body?.resetLossStreak !== false;
  const patch = {
    enabled: true,
    pausedUntilMs: null,
    pausedReason: null,
  };
  if (resetLossStreak) patch.lossStreak = 0;
  config.patch(patch);
  console.log(`[trade.router] /risk-guard/resume: enabled=true, lossStreak ${resetLossStreak ? 'reset' : 'kept'}`);
  exec.notify({
    type: 'unlock',
    title: `✅ 风控套件已手动恢复`,
    lines: [
      `先前暂停原因: ${cfg.pausedReason || '--'}`,
      `状态: enabled=true · lossStreak=${resetLossStreak ? 0 : (cfg.lossStreak || 0)}`,
      `继续接收交易信号`,
    ],
  });
  const finalCfg = config.get();
  res.json({
    ok: true,
    enabled: finalCfg.enabled,
    lossStreak: finalCfg.lossStreak || 0,
    pausedUntilMs: finalCfg.pausedUntilMs || null,
    pausedReason: finalCfg.pausedReason || null,
  });
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
// 价格触发器命中后由 riskEngine in-process 调用, 完全复用 HTTP 端点的逻辑
// 这样浏览器关掉, 价格触发器照样能从 WS tick 命中 → manual-open / manual-follow
module.exports.manualOpenImpl = manualOpenImpl;
module.exports.manualFollowImpl = manualFollowImpl;
// 对外挂单 API (/pending-order) 的可复用实现, 与 manualOpenImpl 同源
// 但叠加了"覆盖式语义" — 同方向已有 pending 时自动取消旧 → arm 新, 与 firePriceTrigger 对齐.
// 暴露便于未来给其他 in-process 模块直接调用 (无需绕 HTTP).
module.exports.pendingOrderImpl = pendingOrderImpl;
// 对外市价立即开仓 API (/market-order) 的可复用实现.
// 价位策略 plan_first: regime plan 优先 / ATR 回退; immediate 分支让 entry 自动用当下市价.
// 冲突处理: active 持仓 → 409; 同方向 pending → 自动取消后立即市价开仓.
module.exports.marketOrderImpl = marketOrderImpl;
// 校验函数对外暴露 — 给冲烟测试 / 未来单测用. 前端不应该 import 这些, 浏览器侧
// 在 regime.html 内有 validateAdjustLevelsClient 同算法实现 (UX 提前拦截)
module.exports.validateManualLevels = validateManualLevels;
module.exports.validateAdjustActiveLevels = validateAdjustActiveLevels;
