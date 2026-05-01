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
    updatedAt: disk?.updatedAt || null,
  };
  // 兼容旧字段
  ['long', 'short'].forEach(k => {
    state[k].tpHit = state[k].tpHit || { tp1: false, tp2: false, tp3: false };
  });
  console.log(`[trade.state] 已加载: long.locked=${state.long.locked}, short.locked=${state.short.locked}`);
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

load();

module.exports = {
  get, getPosition,
  canOpen, openPosition,
  markTpHit, closeAndUnlock, manualReset,
  // pending 限价待触发
  armPending, cancelPending, markPendingFilled,
};
