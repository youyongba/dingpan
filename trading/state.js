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
// 或 manual-follow (action='follow' 立即市价追单). 与浏览器无关, disk 持久化.
//
// 支持多触发器 + 成交锁 (用户硬性需求迭代):
//   - 同方向可以同时启用多条触发价 (多 slot 数组)
//   - 任意一条 fire 成功 → 该方向 locked=true, 清空剩余, 不再 evaluate
//   - 用户重新 armPriceTrigger → 自动 locked=false (重置监听)
//
// 数据结构:
//   priceTriggers[dir] = {
//     items: [ Trigger, Trigger, ... ],       // 已启用的多条触发器
//     locked: false,                          // 成交锁: fire 成功后 true, arm 时重置 false
//     lastFiredAt: ISO,                       // 上一次 fire 时间 (审计)
//     lastFiredTrigger: { ... } | null,       // 上一次 fire 成功的 Trigger 快照
//     lastError: string | null,               // 上一次 fire 失败原因 (UI 可读)
//   }
const EMPTY_DIRECTION_TRIGGERS = () => ({
  items: [],
  locked: false,
  lastFiredAt: null,
  lastFiredTrigger: null,
  lastError: null,
});

const EMPTY_TRIGGER = () => ({
  id: null,
  triggerPrice: null,          // 触发价 (USDT)
  side: null,                  // 'above' | 'below'  (arm 时根据 baseline vs trigger 决定)
  action: null,                // 'open' (挂单 → /manual-open) | 'follow' (追单 → /manual-follow)
  baselinePrice: null,         // arm 时的市价 (审计)
  armedAt: null,               // ISO string, 启用时间
});

// 用单调时间 + 随机短码生成 id, 不需要外部依赖
function _newTriggerId() {
  return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 向后兼容: 旧 disk state 是单条 { enabled, triggerPrice, ... } 格式,
 * load 时检测到 (无 items 字段 + 有 enabled 字段) 就迁移成新数组格式.
 * 仅在 load 阶段调用一次, 兼容旧用户数据.
 */
function _migrateLegacyTrigger(legacy) {
  const next = EMPTY_DIRECTION_TRIGGERS();
  if (!legacy || typeof legacy !== 'object') return next;
  // 已是新格式 (含 items 数组) → 透传, 仅做防御性补全
  if (Array.isArray(legacy.items)) {
    return {
      items: legacy.items
        .filter(t => t && Number.isFinite(Number(t.triggerPrice)))
        .map(t => ({
          ...EMPTY_TRIGGER(),
          id: t.id || _newTriggerId(),
          triggerPrice: Number(t.triggerPrice),
          side: t.side === 'above' || t.side === 'below' ? t.side : null,
          action: t.action === 'follow' ? 'follow' : 'open',
          baselinePrice: Number.isFinite(Number(t.baselinePrice)) ? Number(t.baselinePrice) : null,
          armedAt: t.armedAt || null,
        }))
        .filter(t => t.side != null),
      locked: !!legacy.locked,
      lastFiredAt: legacy.lastFiredAt || null,
      lastFiredTrigger: legacy.lastFiredTrigger || null,
      lastError: legacy.lastError || null,
    };
  }
  // 旧格式: 单条 enabled 标记
  if (legacy.enabled && Number.isFinite(Number(legacy.triggerPrice))) {
    next.items.push({
      ...EMPTY_TRIGGER(),
      id: _newTriggerId(),
      triggerPrice: Number(legacy.triggerPrice),
      side: legacy.side === 'above' || legacy.side === 'below' ? legacy.side : null,
      action: legacy.action === 'follow' ? 'follow' : 'open',
      baselinePrice: Number.isFinite(Number(legacy.baselinePrice)) ? Number(legacy.baselinePrice) : null,
      armedAt: legacy.armedAt || null,
    });
    console.log('[trade.state] 迁移旧 priceTrigger 单条 → items[]:', JSON.stringify(next.items[0]));
  }
  // 保留旧的审计字段 (如果有)
  next.lastFiredAt = legacy.lastFiredAt || null;
  next.lastError = legacy.lastError || null;
  return next;
}

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
  // ⭐ 手动编辑标记: 用户通过 adjust-levels 改过的价位永久锁定,
  //    动态止盈止损 (dynamicLevelsTick, 按 regime ATR 实时重算) 只调整未锁定的价位
  manualLevels: { tp1: false, tp2: false, tp3: false, sl: false },
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
    // 价格触发器与 long/short 仓位独立, 两侧各一个 slot (items[] 数组), 互不影响
    // _migrateLegacyTrigger 兼容旧单条格式 {enabled,triggerPrice,...} → 新数组格式
    priceTriggers: {
      long:  _migrateLegacyTrigger(disk?.priceTriggers?.long),
      short: _migrateLegacyTrigger(disk?.priceTriggers?.short),
    },
    updatedAt: disk?.updatedAt || null,
  };
  // 兼容旧字段
  ['long', 'short'].forEach(k => {
    state[k].tpHit = state[k].tpHit || { tp1: false, tp2: false, tp3: false };
    // 旧 disk state 无 manualLevels → 视为全部未手动编辑 (允许动态调整)
    state[k].manualLevels = state[k].manualLevels || { tp1: false, tp2: false, tp3: false, sl: false };
  });
  console.log(
    `[trade.state] 已加载: long.locked=${state.long.locked}, short.locked=${state.short.locked}` +
    ` | priceTriggers long.items=${state.priceTriggers.long.items.length}(locked=${state.priceTriggers.long.locked})` +
    ` short.items=${state.priceTriggers.short.items.length}(locked=${state.priceTriggers.short.locked})`
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
    // pending 阶段手动改过的价位, 转 active 后继续锁定 (不被动态止盈止损调整)
    manualLevels: { tp1: false, tp2: false, tp3: false, sl: false, ...(plan.manualLevels || {}) },
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

/**
 * ⭐ 风控套件专用: 直接改 active 持仓的 currentStopLoss (不做方向校验).
 *
 * 与 updateActiveLevels 的区别:
 *   - updateActiveLevels 会校验 SL 必须严格在第一个未触发 TP 反侧, TP1 未触发时强制 sl < entry,
 *     适用于"用户手动改价位"场景, 避免误操作.
 *   - setRiskGuardSl 是 riskEngine 的"保本触发"和"trailing"专用 — 这两个场景需要把 SL 上移到
 *     entry (TP1 未触发时, sl 不再 < entry) 或 trailing 后超过 entry (TP1 触发后允许).
 *     这是工具内部精确计算后的合规调整, 不能被通用校验阻拦.
 *
 * 安全约束:
 *   - 仓位非 active → 返回 null
 *   - newSl 必须是有限正数 → 否则返回 null
 *   - 不会改 initialStopLoss (保留审计原始值)
 *
 * @param {'long'|'short'} direction
 * @param {number} newSl  新的 currentStopLoss 价格
 * @param {object} [opts]
 * @param {string} [opts.reason]  审计标签 ('protect_after_touch' / 'trailing' / etc.)
 * @returns {object|null}  返回更新后的 position, 或 null
 */
function setRiskGuardSl(direction, newSl, opts = {}) {
  if (!state) load();
  const p = state[direction];
  if (!p || !p.active) return null;
  if (!Number.isFinite(newSl) || newSl <= 0) return null;
  p.currentStopLoss = newSl;
  // 在仓位上记一条审计字段, 便于 UI/日志区分 SL 是怎么变到当前值的
  p.lastSlAdjustReason = opts.reason || 'risk_guard';
  p.lastSlAdjustAt = new Date().toISOString();
  save();
  return p;
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
function updateActiveLevels(direction, levels, opts = {}) {
  if (!state) load();
  const p = state[direction];
  if (!p || !p.active) return { ok: false, error: 'no_active_position' };

  // markManual=true (默认, 手动编辑入口): 改过的价位打上锁定标记
  // markManual=false (动态止盈止损): 已锁定的价位跳过不改
  const markManual = opts.markManual !== false;
  const flags = { tp1: false, tp2: false, tp3: false, sl: false, ...(p.manualLevels || {}) };

  const next = { ...p };
  const prevSnapshot = { tp1: p.tp1, tp2: p.tp2, tp3: p.tp3,
    initialStopLoss: p.initialStopLoss, currentStopLoss: p.currentStopLoss };
  const tpHit = p.tpHit || { tp1: false, tp2: false, tp3: false };
  const skipped = [];
  let applied = 0;

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
    if (!markManual && flags[k]) {
      skipped.push(`${k}_manual_locked`);
      return;
    }
    next[k] = v;
    applied += 1;
    if (markManual) flags[k] = true;
  });

  if (levels.sl != null) {
    const v = Number(levels.sl);
    if (!Number.isFinite(v) || v <= 0) {
      skipped.push('sl_invalid');
    } else if (!markManual && flags.sl) {
      skipped.push('sl_manual_locked');
    } else {
      next.currentStopLoss = v;
      applied += 1;
      if (markManual) flags.sl = true;
    }
  }

  next.manualLevels = flags;
  state[direction] = next;
  save();
  return { ok: true, prev: prevSnapshot, next, skipped, applied };
}

/**
 * 清除 active 持仓的全部手动编辑锁定标记 (manualLevels 全 false).
 * 「♻️ 恢复自动更新TP/SL」按钮用: 清锁后所有价位重新交给动态/手动重算管理.
 * ⚠️ 只清锁定标记, 不改价位本身; 已触发 TP / 保本 SL 的保护约束不受影响 (那在重算层判定).
 */
function clearManualLevelFlags(direction) {
  if (!state) load();
  const p = state[direction];
  if (!p || !p.active) return { ok: false, error: 'no_active_position' };
  const prev = { tp1: false, tp2: false, tp3: false, sl: false, ...(p.manualLevels || {}) };
  state[direction] = { ...p, manualLevels: { tp1: false, tp2: false, tp3: false, sl: false } };
  save();
  return { ok: true, prev };
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
  // 手动改过的 TP/SL 打锁定标记, fill 转 active 后动态止盈止损不再调整这些价位
  const flags = { tp1: false, tp2: false, tp3: false, sl: false, ...(plan.manualLevels || {}) };

  ['entry', 'tp1', 'tp2', 'tp3', 'sl'].forEach((k) => {
    if (levels[k] == null) return;
    const v = Number(levels[k]);
    if (!Number.isFinite(v) || v <= 0) {
      skipped.push(`${k}_invalid`);
      return;
    }
    plan[k] = v;
    if (k !== 'entry') flags[k] = true;
  });

  plan.manualLevels = flags;
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
 * 追加一条价格触发器到指定方向的 items[].
 *
 * 语义:
 *   - 与该方向已有触发器**叠加** (允许同时挂多条触发价)
 *   - 同方向若处于 locked=true (上一次 fire 成功的锁), arm 会自动解锁 + 清 lastError
 *   - 触发器与仓位的 active/pending 状态完全独立, 不影响 canOpen
 *
 * @param {'long'|'short'} direction
 * @param {object} args
 * @param {number} args.triggerPrice
 * @param {'open'|'follow'} args.action
 * @param {number} args.baselinePrice
 * @returns {object} 新增的 trigger 快照 (含 id)
 */
function armPriceTrigger(direction, args) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') throw new Error('invalid_direction');
  const triggerPrice = Number(args?.triggerPrice);
  const baselinePrice = Number(args?.baselinePrice);
  const action = args?.action === 'follow' ? 'follow' : 'open';
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) throw new Error('invalid_trigger_price');
  if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) throw new Error('invalid_baseline_price');
  const side = triggerPrice > baselinePrice ? 'above' : 'below';
  const slot = state.priceTriggers[direction];

  // 防重复: 同方向已存在等价 trigger (同价同 action) → 拒绝, 避免误点重复 arm
  const dup = slot.items.find(t =>
    Math.abs(Number(t.triggerPrice) - triggerPrice) < 1e-9 && t.action === action
  );
  if (dup) {
    const e = new Error('duplicate_trigger');
    e.existing = { ...dup };
    throw e;
  }

  const newTrigger = {
    ...EMPTY_TRIGGER(),
    id: _newTriggerId(),
    triggerPrice, side, action, baselinePrice,
    armedAt: new Date().toISOString(),
  };
  // ⭐ arm 新触发器 = 用户重启监听, 解开成交锁 + 清掉旧错误
  state.priceTriggers[direction] = {
    ...slot,
    items: [...slot.items, newTrigger],
    locked: false,
    lastError: null,
  };
  save();
  return { ...newTrigger };
}

/**
 * 按 id 取消单条触发器 (UI 上每条触发器右侧的 ❎ 按钮).
 *
 * @param {'long'|'short'} direction
 * @param {string} id
 * @param {string} [reason='manual']
 * @returns {object|null} 被删除的 trigger 快照; 找不到返回 null
 */
function cancelPriceTrigger(direction, id, reason = 'manual') {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return null;
  if (!id) return null;
  const slot = state.priceTriggers[direction];
  const idx = slot.items.findIndex(t => t && t.id === id);
  if (idx < 0) return null;
  const removed = slot.items[idx];
  const nextItems = [...slot.items.slice(0, idx), ...slot.items.slice(idx + 1)];
  state.priceTriggers[direction] = { ...slot, items: nextItems };
  save();
  return { ...removed, cancelReason: reason };
}

/**
 * 清空某方向所有触发器 (一键全部取消 / 反向信号).
 * 用 reason='fired_lock' 时会同时 locked=true (供 markPriceTriggerFiredLock 复用).
 *
 * @param {'long'|'short'} direction
 * @param {string} [reason='manual_all']
 * @returns {object[]} 被清空的 items 列表 (副本)
 */
function cancelAllPriceTriggers(direction, reason = 'manual_all') {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return [];
  const slot = state.priceTriggers[direction];
  const prev = slot.items.map(t => ({ ...t }));
  state.priceTriggers[direction] = {
    ...slot,
    items: [],
    // manual_all / reverse_signal 不锁; 仅 fired_lock 锁
    locked: reason === 'fired_lock' ? true : slot.locked,
    // 手动清空 → 顺便清 lastError, 让 UI 不再红字
    lastError: reason === 'manual_all' ? null : slot.lastError,
  };
  save();
  return prev;
}

/**
 * 原子按 id 消费一条 trigger (riskEngine.firePriceTrigger 调).
 *
 * ⚠️ 幂等保护 (与 markTpHit / closeAndUnlock 同模式):
 *   - 找不到 id (已被取消 / 已被消费 / 整方向已 locked-clear) → 返回 null
 *   - 成功消费 → 从 items[] 移除并落盘, 返回 prev 快照
 *
 * 调用方必须检查返回值, null 时直接放弃 fire — 这是最后一道防线,
 * 即便 _ptInFlight 异常未释放, items 已空就拦得住"重复 fire 已 fire 的那条".
 *
 * @param {'long'|'short'} direction
 * @param {string} id
 * @param {number} hitPrice
 * @returns {object|null}
 */
function consumePriceTrigger(direction, id, hitPrice) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return null;
  if (!id) return null;
  const slot = state.priceTriggers[direction];
  if (slot.locked) return null;              // 已锁 = 不再消费 (双保险)
  const idx = slot.items.findIndex(t => t && t.id === id);
  if (idx < 0) return null;
  const removed = slot.items[idx];
  const nextItems = [...slot.items.slice(0, idx), ...slot.items.slice(idx + 1)];
  state.priceTriggers[direction] = { ...slot, items: nextItems };
  save();
  return { ...removed, hitPrice: Number(hitPrice) };
}

/**
 * 标记某方向已 fire 成功 → 锁定 + 清空剩余触发器 (核心成交锁逻辑).
 *
 * 用户硬性要求: "同方向有一个成交就锁定不再触发".
 * 这里在 riskEngine.firePriceTrigger 返回 ok 后调用:
 *   - 清空 items (剩下未触发的触发价直接作废)
 *   - locked=true (本帧后续 evaluate 直接跳过该方向, 即便 items 被外力填回)
 *   - 记 lastFiredAt / lastFiredTrigger 供 UI 显示与审计
 *
 * 解锁方式:
 *   - 用户重新 armPriceTrigger → 该函数会自动 locked=false
 *   - 用户调 cancelAllPriceTriggers (reason='manual_all') → 不解锁但清空 items
 *
 * @param {'long'|'short'} direction
 * @param {object} firedTrigger    刚 fire 成功的那条 (用于审计 lastFiredTrigger)
 * @returns {{cleared:number, lockedItems:object[]}}  cleared=被锁定时清掉的剩余条数
 */
function markPriceTriggerFiredLock(direction, firedTrigger) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return { cleared: 0, lockedItems: [] };
  const slot = state.priceTriggers[direction];
  const lockedItems = slot.items.map(t => ({ ...t }));
  state.priceTriggers[direction] = {
    ...slot,
    items: [],
    locked: true,
    lastFiredAt: new Date().toISOString(),
    lastFiredTrigger: firedTrigger ? { ...firedTrigger } : null,
    lastError: null,
  };
  save();
  return { cleared: lockedItems.length, lockedItems };
}

/**
 * 记录某方向上一次 fire 失败的原因 (manualOpenImpl 返回非 2xx 时).
 * 不动 items / locked, 仅写 lastError 字段供 UI 红字提示.
 *
 * @param {'long'|'short'} direction
 * @param {string} errorMsg
 */
function recordPriceTriggerError(direction, errorMsg) {
  if (!state) load();
  if (direction !== 'long' && direction !== 'short') return;
  const slot = state.priceTriggers[direction];
  state.priceTriggers[direction] = {
    ...slot,
    lastError: String(errorMsg || '').slice(0, 240),
  };
  save();
}

/** 返回 priceTriggers 状态 (供 /status 输出 / 内部读取); items 是 deep copy */
function getPriceTriggers() {
  if (!state) load();
  return {
    long:  { ...state.priceTriggers.long,  items: state.priceTriggers.long.items.map(t => ({ ...t })) },
    short: { ...state.priceTriggers.short, items: state.priceTriggers.short.items.map(t => ({ ...t })) },
  };
}

load();

module.exports = {
  get, getPosition,
  canOpen, openPosition,
  markTpHit, closeAndUnlock, manualReset,
  setRiskGuardSl,
  // pending 限价待触发
  armPending, cancelPending, markPendingFilled,
  // 手动调整止盈止损
  updateActiveLevels, updatePendingLevels, clearManualLevelFlags,
  // ⭐ 价格触发器 (与浏览器无关, 由 riskEngine 监听 WS 直接 evaluate)
  // 多触发器 + 成交锁: items[] 数组, fire 成功 → markPriceTriggerFiredLock 锁整方向
  armPriceTrigger,
  cancelPriceTrigger,        // 按 id 取消单条
  cancelAllPriceTriggers,    // 一键清空某方向
  consumePriceTrigger,       // 原子按 id 消费 (riskEngine 用)
  markPriceTriggerFiredLock, // fire 成功后调: 清空 + 锁定 (riskEngine 用)
  recordPriceTriggerError,
  getPriceTriggers,
};
