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
 *       反方向状态完全不影响（多空独立）
 */
function canOpen(direction) {
  const p = getPosition(direction);
  if (!p) return { ok: false, reason: 'invalid_direction' };
  if (p.active && p.locked) {
    return { ok: false, reason: `${direction}_locked`, position: p };
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

/** 标记某 TP 已触发；可同时改写 currentStopLoss (保本) */
function markTpHit(direction, level, opts = {}) {
  const p = getPosition(direction);
  if (!p) return null;
  p.tpHit = p.tpHit || { tp1: false, tp2: false, tp3: false };
  p.tpHit[level] = true;
  if (opts.newStopLoss != null) p.currentStopLoss = opts.newStopLoss;
  if (opts.armProtection) p.protectionArmed = true;
  save();
  return p;
}

/** 触发止损或 TP3 → 关闭 + 解锁 */
function closeAndUnlock(direction, reason) {
  if (!state) load();
  const closed = { ...state[direction], active: false, locked: false, closedAt: new Date().toISOString(), closeReason: reason };
  // 重置为干净的空仓位
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
};
