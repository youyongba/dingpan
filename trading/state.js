/**
 * ============================================================
 *  trading/state.js
 *  自动平仓引擎 - 多空独立仓位状态机
 *
 *  关键设计：
 *  - 多空两个 slot 完全独立 (positions.long / positions.short)
 *  - 每个 slot 自带：locked / entryPrice / 计算好的 tp/sl 价位 /
 *    各 TP 是否已触发 / 当前有效 stopLoss（保本时会被改写）
 *  - 状态变更立即落盘到 data/auto_trade_state.json
 *
 *  解锁规则：
 *  - SL 触发 → unlock
 *  - TP3 触发 → unlock
 *  - TP1 已触发但 TP2/TP3 未触发，价格回到入场价 → 触发"保本止损" → unlock
 *  - 手动重置 → unlock + 取消所有待触发 TP/SL
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.AUTO_TRADE_STATE_PATH
  || path.join(__dirname, '..', 'data', 'auto_trade_state.json');

// ============ 价格触发器 (PriceTrigger) ============
// 与 pending 独立的"一级闸门": 用户先设"价格到 X 我才挂单/追单",
// 价格触达后, riskEngine 调 processSignal 走 manual-open (action='open' 挂单)
// 或 manual-follow (action='follow' 立即市价追单). 命中后该 slot 立即变成
// EMPTY_PRICE_TRIGGER, 与 pending 限价单同样 disk 持久化, 与浏览器无关.
const EMPTY_PRICE_TRIGGER = () => ({
  enabled: false,
  triggerPrice: null,          // 触发价 (USDT)
  side: null,                  // 'above' | 'below'  (arm 时根据 baseline vs trigger 决定)
  action: null,                // 'open' (挂单 → /manual-open) | 'follow' (追单 → /manual-follow)
  baselinePrice: null,         // arm 时的市价 (审计)
  armedAt: null,               // ISO string, 启用时间
  lastFiredAt: null,           // ISO string, 上一次成功 fire 时间 (审计)
  lastError: null,             // 上一次 fire 失败的原因 (字符串), 用户可在 UI 看见
});

const EMPTY_POSITION = () => ({
  active: false,         // 是否持仓中
  locked: false,         // 是否锁定 (拒绝同方向再开)
  direction: null,       // 'long' | 'short'
  entryPrice: null,
  entryAt: null,
  leverage: null,
  positionSize: null,    // 字符串保留原样, e.g. '1%'
  // 触发价位 (绝对价)
  tp1: null, tp2: null, tp3: null,
  initialStopLoss: null,
  currentStopLoss: null, // 触发 TP1 后改成 entryPrice (保本)
  // 触发标记
  tpHit: { tp1: false, tp2: false, tp3: false },
  slHit: false,
  closedAt: null,
  // 用于"价格回到入场价"判定：仅在 TP1 触发后开启
  protectionArmed: false,
  raw: null,             // 保留原始入仓信号（调试用）
  // ----- pending 限价待触发 (新增) -----
  // 开仓信号到达后, 不立即推 webhook, 而是把方案的 entry/SL/TP 落到 pendingPlan,
  // 由 riskEngine 监听价格触达 entry 时再 fill (推 forwardOpen webhook + 转 active).
  pending: false,
  pendingPlan: null,     // {entry, sl, tp1, tp2, tp3, positionSize, leverage, source, ...}
  pendingArmedAt: null,  // ISO string
  pendingExpireAt: null, // ⚠️ 已废弃: pending 不再自动过期, 字段保留仅为兼容旧 disk state
  fillPrice: null,       // 实际触发 fill 时的市价 (与 entryPrice 区分, 仅供 audit)
});

let state = null;

function ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  let disk = null;
  try {
    if (fs.existsSync(STATE_FILE)) {
      disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[trade.state] 读取状态失败, 使用空状态:', e.message);
  }
  state = {
    long: { ...EMPTY_POSITION(), ...(disk?.long || {}) },
    short: { ...EMPTY_POSITION(), ...(disk?.short || {}) },
    // 价格触发器与 long/short 仓位独立, 两侧各一个 slot, 互不影响
    priceTriggers: {
      long:  { ...EMPTY_PRICE_TRIGGER(), ...(disk?.priceTriggers?.long  || {}) },
      short: { ...EMPTY_PRICE_TRIGGER(), ...(disk?.priceTriggers?.short || {}) },
    },
    updatedAt: disk?.updatedAt || null,
  };
  // 兼容旧字段
  ['long', 'short'].forEach(k => {
    state[k].tpHit = state[k].tpHit || { tp1: false, tp2: false, tp3: false };
  });
  // 旧 disk state 没 priceTriggers, load 后正常为空; armPriceTrigger 时再写盘
  console.log(
    `[trade.state] 已加载: long.locked=${state.long.locked}, short.locked=${state.short.locked}` +
    ` | priceTriggers.long.enabled=${state.priceTriggers.long.enabled}` +
    ` priceTriggers.short.enabled=${state.priceTriggers.short.enabled}`
  );
  return state;
}

function save() {
  try {
    ensureDir();
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[trade.state] 保存失败:', e.message);
  }
}

function get() { if (!state) load(); return state; }

function getPosition(direction) {
  if (!state) load();
  return state[direction] || null;
}

/**
 * 是否允许开新仓
 * 规则：同方向已 active 且 locked → 拒绝；
 *       同方向已 pending (限价待触发) → 拒绝, 防重复 (新增);
 *       反方向状态完全不影响（多空独立）
 */
function canOpen(direction) {
  const p = getPosition(direction);
  if (!p) return { ok: false, reason: 'invalid_direction' };
  if (p.active && p.locked) {
    return { ok: false, reason: `${direction}_locked`, position: p };
  }
  if (p.pending) {
    return { ok: false, reason: `${direction}_pending`, position: p };
  }
  return { ok: true };
}

/** 登记一笔新仓位 */
function openPosition(direction, payload) {
  if (!state) load();
  const next = { ...EMPTY_POSITION(), ...payload, direction, active: true, locked: true };
  state[direction] = next;
  save();
  return next;
}

/**
 * 登记一笔 pending (限价待触发) 计划.
 * 价格触达 plan.entry 之前, webhook 不会发, 只有内存 + 落盘记录.
 *
 * ⚠️ 历史: 之前会自动 30min TTL 过期, 现已**完全移除** — pending 不会自己取消,
 *    只有以下三种方式才会清除 pending:
 *      a) 价格触达 plan.entry → fill 成功后转 active
 *      b) 反向信号 (FVG / 反向开仓) → cancelPendingByReverseSignal
 *      c) 用户手动调用 POST /cancel-pending
 *    pendingExpireAt 字段保留为 null, 仅用于兼容老 disk state, 不再起作用.
 *
 * @param {'long'|'short'} direction
 * @param {object} plan      {entry, sl, tp1, tp2, tp3, positionSize, leverage, source, raw, ...}
 * @param {object} [opts]   保留参数对象供以后扩展, 当前所有字段已忽略
 */
function armPending(direction, plan, opts = {}) {
  if (!state) load();
  const next = {
    ...EMPTY_POSITION(),
    direction,
    pending: true,
    pendingPlan: plan,
    pendingArmedAt: new Date().toISOString(),
    pendingExpireAt: null,
    raw: plan?.raw || null,
  };
  state[direction] = next;
  save();
  return next;
}

/**
 * 取消 pending 计划 (手动取消 / 超时 / 主动撤单).
 * 旧的 active 仓位字段不会被影响 — 因为 pending 只在 EMPTY 仓位上 arm.
 */
function cancelPending(direction, reason = 'manual') {
  if (!state) load();
  const prev = state[direction];
  if (!prev || !prev.pending) return null;
  state[direction] = { ...EMPTY_POSITION() };
  state[direction].lastPendingCancel = {
    reason,
    plan: prev.pendingPlan,
    armedAt: prev.pendingArmedAt,
    cancelledAt: new Date().toISOString(),
  };
  save();
  return prev;
}

/**
 * pending → active: 价格触达 plan.entry, 已发出 forwardOpen webhook 之后调用.
 * entryPrice 用 plan.entry (限价语义, TP/SL 与方案完全对齐),
 * fillPrice  存当下市价 (滑点审计).
 *
 * @param {'long'|'short'} direction
 * @param {number} fillPrice    实际触发时的市价
 */
function markPendingFilled(direction, fillPrice) {
  if (!state) load();
  const prev = state[direction];
  if (!prev || !prev.pending || !prev.pendingPlan) return null;
  const plan = prev.pendingPlan;
  const next = {
    ...EMPTY_POSITION(),
    direction,
    active: true,
    locked: true,
    entryPrice: plan.entry,
    entryAt: new Date().toISOString(),
    leverage: plan.leverage,
    positionSize: plan.positionSize,
    tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3,
    initialStopLoss: plan.sl,
    currentStopLoss: plan.sl,
    raw: plan.raw,
    priceSource: plan.source,
    planEntry: plan.entry,
    fillPrice,
    pendingArmedAt: prev.pendingArmedAt,  // 保留审计
  };
  state[direction] = next;
  save();
  return next;
}

/**
 * 标记某 TP 已触发；可同时改写 currentStopLoss (保本).
 *
 * ⚠️ 幂等保护 (核心安全语义):
 *   - 仓位非 active     → 返回 null (没有开仓, 不可能 TP)
 *   - 该 level 已触发过 → 返回 null (防重复 fire 的 last-line-of-defense)
 *   - 写盘成功         → 返回更新后的 position
 *
 * 调用方 (riskEngine.fireTp / router 外部 take_profit) 必须检查返回值,
 * null 时直接放弃 fire, 不发 webhook / 不发通知 / 不推监控. 这样即便上游
 * (_inFlight / cooldown / external race) 有缝, state 层兜住"绝对一次".
 */
function markTpHit(direction, level, opts = {}) {
  const p = getPosition(direction);
  if (!p) return null;
  if (!p.active) return null;
  p.tpHit = p.tpHit || { tp1: false, tp2: false, tp3: false };
  if (p.tpHit[level]) return null;
  p.tpHit[level] = true;
  if (opts.newStopLoss != null) p.currentStopLoss = opts.newStopLoss;
  if (opts.armProtection) p.protectionArmed = true;
  save();
  return p;
}

/**
 * 触发止损或 TP3 → 关闭 + 解锁.
 *
 * ⚠️ 幂等保护:
 *   - 仓位非 active → 返回 null (已经 closed, 拒绝再次 close-and-unlock)
 *   - 写盘成功     → 返回 closed 快照
 *
 * 调用方必须检查返回值, null 时跳过 webhook / 通知 / 监控推送.
 * 这样防住"重复止损"在多入口场景下被 fire 第二次.
 */
function closeAndUnlock(direction, reason) {
  if (!state) load();
  const prev = state[direction];
  if (!prev || !prev.active) return null;
  const closed = { ...prev, active: false, locked: false, closedAt: new Date().toISOString(), closeReason: reason };
  state[direction] = { ...EMPTY_POSITION() };
  save();
  return closed;
}

/** 手动重置：清空 + 解锁 + 取消所有待触发 TP/SL */
function manualReset(direction) {
  if (!state) load();
  const prev = state[direction];
  state[direction] = { ...EMPTY_POSITION() };
  save();
  return prev;
}

/**
 * 修改 active 持仓的 TP1/TP2/TP3/SL 价位 (用户手动调整止盈止损).
 *
 * 设计要点:
 *   - 只允许修改未触发的 TP (tpHit.tpN=false) — 已触发的 level 直接忽略, 防止改动
 *     已成交的级别造成审计混乱
 *   - sl 总是同步更新 currentStopLoss; initialStopLoss 不变 (保留审计原值)
 *   - 即便 protectionArmed=true (TP1 已触发, SL 已上移到 entry), 也允许用户覆盖,
 *     用户改完之后 protectionArmed 状态保持不变 (用户知道在做什么)
 *   - 与 riskEngine 共享同一份 state, 改完的下一个 tick 立即按新价位 evaluate
 *
 * @param {'long'|'short'} direction
 * @param {{tp1?:number, tp2?:number, tp3?:number, sl?:number}} levels
 * @returns {{ok:true, prev:object, next:object} | {ok:false, error:string}}
 */
function updateActiveLevels(direction, levels) {
  if (!state) load();
  const p = state[direction];
  if (!p || !p.active) return { ok: false, error: 'no_active_position' };

  const next = { ...p };
  const prevSnapshot = { tp1: p.tp1, tp2: p.tp2, tp3: p.tp3,
    initialStopLoss: p.initialStopLoss, currentStopLoss: p.currentStopLoss };
  const tpHit = p.tpHit || { tp1: false, tp2: false, tp3: false };
  const skipped = [];

  ['tp1', 'tp2', 'tp3'].forEach((k) => {
    if (levels[k] == null) return;
    const v = Number(levels[k]);
    if (!Number.isFinite(v) || v <= 0) {
      skipped.push(`${k}_invalid`);
      return;
    }
    if (tpHit[k]) {
      skipped.push(`${k}_already_hit`);
      return;
    }
    next[k] = v;
  });

  if (levels.sl != null) {
    const v = Number(levels.sl);
    if (Number.isFinite(v) && v > 0) {
      next.currentStopLoss = v;
    } else {
      skipped.push('sl_invalid');
    }
  }

  state[direction] = next;
  save();
  return { ok: true, prev: prevSnapshot, next, skipped };
}

/**
 * 修改 pending 挂单的 entry/TP1/TP2/TP3/SL 价位.
 *
 * 设计要点:
 *   - pending 还没成交, 全部字段都允许改 (entry / sl / tp1-3)
 *   - 改完后 riskEngine 下一 tick 会按新 entry 重新判断是否触发 fill
 *   - leverage / positionSize 不允许通过此接口改 (走 cancel + 重新 manual-open)
 *
 * @param {'long'|'short'} direction
 * @param {{entry?:number, tp1?:number, tp2?:number, tp3?:number, sl?:number}} levels
 * @returns {{ok:true, prev:object, next:object} | {ok:false, error:string}}
 */
function updatePendingLevels(direction, levels) {
  if (!state) load();
  const p = state[direction];
  if (!p || !p.pending || !p.pendingPlan) return { ok: false, error: 'no_pending' };

  const plan = { ...p.pendingPlan };
  const prev = { entry: plan.entry, tp1: plan.tp1, tp2: plan.tp2, tp3: plan.tp3, sl: plan.sl };
  const skipped = [];

  ['entry', 'tp1', 'tp2', 'tp3', 'sl'].forEach((k) => {
    if (levels[k] == null) return;
    const v = Number(levels[k]);
    if (!Number.isFinite(v) || v <= 0) {
      skipped.push(`${k}_invalid`);
      return;
    }
    plan[k] = v;
  });

  state[direction] = { ...p, pendingPlan: plan };
  save();
  return { ok: true, prev, next: plan, skipped };
}

// ============================================================
// ============ 价格触发器 (PriceTrigger) API ==================
// ============================================================
//
// 设计目标: 把原本前端浏览器 localStorage 维护的"价格到 X 才挂单/追单"
// 整体搬到后端, 由 riskEngine 每帧 tick evaluate. 浏览器关掉也照样触发.
//
// 状态: state.priceTriggers.{long,short}, 与仓位完全独立, 与 disk 同步落盘.
//
// 与 pending 限价单的区别:
//   - pending  → 已经决定要开仓, 等价格回踩 entry 才 fill 真正下单 webhook
//   - trigger  → 第一级闸门, 价格到 X 才"开始"挂单/追单流程; 触发后才进入
//                 pending (action='open') 或立即市价 (action='follow').
//   - 两者可以串联: trigger 命中 → 调 manual-open → pending → 价格回踩 → 真正下单

/**
 * 启用价格触发器 (一个方向 slot).
 *
 * ⚠️ 幂等 / 覆盖语义:
 *   - 同方向已有 enabled trigger → 直接覆盖 (用户重设触发价)
 *   - 与该方向仓位的 active/pending 完全独立, 不影响开/平
 *
 * @param {'long'|'short'} direction
 * @param {object} args
 * @param {number} args.triggerPrice   触发价 (必填, USDT)
 * @param {'open'|'follow'} args.action  触发后动作 (必填)
 * @param {number} args.baselinePrice  启用时的市价 (必填, 用于推导 side)
 * @returns {object} 已 arm 的 trigger 快照
 */
function armPriceTrigger(direction, args) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') throw new Error('invalid_direction');
  const triggerPrice = Number(args?.triggerPrice);
  const baselinePrice = Number(args?.baselinePrice);
  const action = args?.action === 'follow' ? 'follow' : 'open';
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) throw new Error('invalid_trigger_price');
  if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) throw new Error('invalid_baseline_price');
  // side: trigger > baseline → 'above' (价格上涨到 trigger 触发); 反之 'below'
  // 与原前端 armPriceTrigger 语义完全一致
  const side = triggerPrice > baselinePrice ? 'above' : 'below';
  const next = {
    ...EMPTY_PRICE_TRIGGER(),
    enabled: true,
    triggerPrice,
    side,
    action,
    baselinePrice,
    armedAt: new Date().toISOString(),
  };
  state.priceTriggers[direction] = next;
  save();
  return { ...next };
}

/**
 * 取消价格触发器 (手动 / 触发后清除 / 反向信号).
 *
 * @param {'long'|'short'} direction
 * @param {string} [reason]   仅作日志/审计
 * @returns {object|null} prev 触发器快照, 或 null (本来就没启用)
 */
function cancelPriceTrigger(direction, reason = 'manual') {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return null;
  const prev = state.priceTriggers[direction];
  if (!prev || !prev.enabled) return null;
  state.priceTriggers[direction] = {
    ...EMPTY_PRICE_TRIGGER(),
    lastFiredAt: prev.lastFiredAt,    // 保留审计字段
    lastError: reason === 'manual' ? null : (prev.lastError || null),
  };
  save();
  return { ...prev, cancelReason: reason };
}

/**
 * 原子触发并清除. 与 markTpHit / closeAndUnlock 同样的幂等模式:
 *   - 已被消费 / 未启用 → 返回 null (拦住"两个 tick 同帧 evaluate 都看到 hit"的 race)
 *   - 成功消费         → 把 priceTriggers[dir] 写成 disabled (firedAt 标记), 返回 prev
 *
 * 调用方 (riskEngine.firePriceTrigger) 必须检查返回值,
 * null 时直接退出, 不调 processSignal, 不发通知.
 *
 * @param {'long'|'short'} direction
 * @param {number} hitPrice    实际触发时的市价 (用于审计与通知)
 * @returns {object|null}      原 trigger 快照 (含 action / triggerPrice 等)
 */
function consumePriceTrigger(direction, hitPrice) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return null;
  const prev = state.priceTriggers[direction];
  if (!prev || !prev.enabled) return null;
  state.priceTriggers[direction] = {
    ...EMPTY_PRICE_TRIGGER(),
    lastFiredAt: new Date().toISOString(),
  };
  save();
  return { ...prev, hitPrice: Number(hitPrice) };
}

/**
 * 触发失败时, 把 lastError 写盘 (UI 可读), 不改 enabled.
 * ⚠️ 注意: 当前实现是"触发即消费", consumePriceTrigger 已经把 enabled=false 了.
 * 这里仅在 fire 整体失败时附加错误信息 (用户在 /status 里能看见原因).
 *
 * @param {'long'|'short'} direction
 * @param {string} errorMsg
 */
function recordPriceTriggerError(direction, errorMsg) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return;
  const cur = state.priceTriggers[direction];
  if (!cur) return;
  state.priceTriggers[direction] = { ...cur, lastError: String(errorMsg || '').slice(0, 240) };
  save();
}

/** 返回 priceTriggers 状态 (供 /status 输出 / 内部读取) */
function getPriceTriggers() {
  if (!state) load();
  return {
    long:  { ...state.priceTriggers.long },
    short: { ...state.priceTriggers.short },
  };
}

load();

module.exports = {
  get, getPosition,
  canOpen, openPosition,
  markTpHit, closeAndUnlock, manualReset,
  // pending 限价待触发
  armPending, cancelPending, markPendingFilled,
  // 手动调整止盈止损
  updateActiveLevels, updatePendingLevels,
  // ⭐ 价格触发器 (与浏览器无关, 由 riskEngine 监听 WS 直接 evaluate)
  armPriceTrigger, cancelPriceTrigger, consumePriceTrigger,
  recordPriceTriggerError, getPriceTriggers,
};
