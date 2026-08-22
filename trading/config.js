/**
 * ============================================================
 *  trading/config.js
 *  自动平仓引擎 - 动态配置中心
 *
 *  - 启动时按优先级加载：磁盘 JSON > 环境变量 > 内置默认
 *  - 提供 get / patch 方法，patch 后立即写盘并触发订阅回调
 *  - 后台/接口可通过 patch() 动态修改任意字段
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.AUTO_TRADE_CONFIG_PATH
  || path.join(__dirname, '..', 'data', 'auto_trade_config.json');

// 内置默认（最低保险）
const DEFAULT_CONFIG = {
  enabled: true,                              // 总开关
  // 方向开关 (与 enabled 总开关同级, 但只拦新开仓信号):
  //   disableLong=true  → 所有 open_long  / firePriceTrigger long  / pending-order long  / market-order long  被 409 拒绝
  //   disableShort=true → 所有 open_short / firePriceTrigger short / pending-order short / market-order short 被 409 拒绝
  // ⚠️ 不影响:
  //   - 已有 active 持仓的 TP/SL 兜底 (用户开关时持仓会继续到达 TP/SL)
  //   - 已有 pending 触达 entry 的 fill (旧决策, 想撤请显式 /cancel-pending)
  //   - 平仓信号 (take_profit / stop_loss / close-all-positions)
  // 想恢复: POST /api/auto-trade/config { disableLong:false } 或 POST /toggle-direction.
  disableLong: false,
  disableShort: false,
  // ⭐ HV/ROC 增强止盈止损 (默认关闭, regime 页面可开关):
  //   开启后 ATR 价位公式加入两个有界因子 (作用于手动开仓回退/追单/动态止盈止损):
  //     volFactor = clamp(HV / HV近120根均值, 0.8~1.3)  → 缩放风险距离 (高波动放宽 SL/TP, 低波动收紧)
  //     tpStretch = clamp(1 + 0.25 * 方向 * (ROC/2%), 0.75~1.25) → 动量同向拉伸止盈, 逆向收缩 (SL 不受影响)
  //   ⚠️ 对胜率的影响未经回测验证, 属实验性开关, 建议自行 A/B 对比
  hvRocLevels: false,
  // ⭐ 价格围栏 (自动方向开关) — riskEngine 每帧 tick 评估, 自动切换 autoDisableLong/Short:
  //   long.threshold  (做多基准价): 市价 < threshold → 自动禁止做多 (跌破不追低)
  //                                  市价 ≥ threshold * (1 + hysteresisPct/100) → 自动解除
  //   short.threshold (做空基准价): 市价 > threshold → 自动禁止做空 (涨破不追高)
  //                                  市价 ≤ threshold * (1 - hysteresisPct/100) → 自动解除
  //   hysteresisPct        : 滞后缓冲百分比, 防止价格在阈值附近抖动导致开关频繁切换
  //   minSwitchIntervalMs  : 切换一次后, 该方向 N ms 内不再换状态 (双重防抖)
  //
  // 与手动 disableLong/disableShort 是**独立位**, 最终拦截 = 手动 || 自动 (任意一个开都拦).
  // UI 用两个不同视觉标记区分: 🚫 手动禁止 vs 🤖 价格围栏自动禁止.
  directionGuard: {
    long:  { enabled: false, threshold: null },
    short: { enabled: false, threshold: null },
    hysteresisPct: 0.2,
    minSwitchIntervalMs: 30000,
  },
  // 由 riskEngine.evaluateDirectionGuard 自动写入, 用户不应直接 patch:
  //   true  → 价格围栏判定该方向应被拦截 (与手动 disable* 取或)
  //   false → 围栏判定该方向放行 (但手动 disable* 仍可独立拦)
  autoDisableLong: false,
  autoDisableShort: false,
  // ⭐ Regime 守卫 (自动方向开关 — 基于 1H Regime/subRegime 的趋势状态):
  //   STRONG_BULL  (强多头) → blockShortOnStrongBull=true 时, 自动禁止做空
  //                            (强趋势中"前高做空"必死, 用 Regime 拦掉所有空头新信号)
  //   STRONG_BEAR  (强空头) → blockLongOnStrongBear=true 时, 自动禁止做多
  //                            (强趋势中"接刀子"必死, 拦掉所有多头新信号)
  //   PANIC        (恐慌)   → blockBothOnPanic=true     时, 自动双向禁
  //   UNCLEAR      (未明)   → blockBothOnUnclear=true   时, 自动双向禁 (默认 off, 太严)
  //   minConfidence         → 'low' | 'medium' | 'high', 低于这个置信度时不参考
  //                            confidenceLabel 在 enhancedJudge 里返回 '低/中/高',
  //                            这里映射为 low/medium/high.
  //
  // 与 manual disableLong/Short + priceGuard autoDisableLong/Short 是**独立位**:
  //   最终拦截 = manual || priceGuard || regimeGuard (任意一个 true 都拦).
  // UI 用三种不同视觉区分: 🚫 手动 / 🤖 价格围栏 / 📊 Regime 守卫.
  regimeGuard: {
    enabled: false,                          // 总开关 (默认 off, 用户主动启用)
    blockLongOnStrongBear: true,             // STRONG_BEAR → 拦多 (默认 on, 最有共识)
    blockShortOnStrongBull: true,            // STRONG_BULL → 拦空 (默认 on)
    blockBothOnPanic: true,                  // PANIC → 双向禁 (默认 on, 安全)
    blockBothOnUnclear: false,               // UNCLEAR → 双向禁 (默认 off, 太严)
    minConfidence: 'low',                    // low/medium/high — 低于此置信度不应用
    minSwitchIntervalMs: 60000,              // 最小切换间隔 (1H Regime 本身就慢, 60s 防误切)
  },
  // 由 riskEngine.evaluateRegimeGuard 自动写入, 用户不应直接 patch:
  regimeAutoDisableLong: false,
  regimeAutoDisableShort: false,
  // 当前评估到的 Regime 状态快照 (供 /status 暴露给 UI 用, 不参与决策):
  regimeAutoLastSubRegime: null,             // 'STRONG_BULL' / 'STRONG_BEAR' / 'PANIC' / ...
  regimeAutoLastConfidence: null,            // 'low' / 'medium' / 'high'
  regimeAutoLastEvalAt: null,                // 上次评估时间 (ms)
  // ============================================================
  // ⭐ 风控套件 (riskGuard) — 100x × 50% 滚仓 + 24H/4H 清算密集区策略专用保护
  // ============================================================
  // 设计目标: 在不改杠杆/仓位的前提下, 用代码层把"必爆仓"事件砍到 < 3%,
  // 单笔最大常规亏损从 -50% (爆仓) 降到 -15% / -30% (主动软止损).
  //
  // ⭐ 双层开关设计:
  //   - 总开关 riskGuardEnabled: 一键关掉整个套件 (所有 8 个保护逻辑都跳过)
  //                              关掉后子模块 .enabled 配置保留, 再打开总开关时立刻恢复
  //                              用户场景: "我现在想测试一下不带保护的纯信号, 临时关一下"
  //   - 子模块 .enabled (softStopLoss/timeExit/hardSlCap/.../balanceGuard):
  //                              独立开关, 各自决定是否生效
  //                              用户场景: "我只想要软SL, 不要时间退出"
  //   最终是否生效 = riskGuardEnabled && 子模块.enabled (两者都 true 才生效)
  // ============================================================
  riskGuardEnabled: true,                       // 总开关 (默认 on, 强烈建议保持开启)
  softStopLoss: {
    enabled: true,
    // 阶段 1 (假插针窗口): 入场后 fastWindowMs 毫秒内, 价格反向 ≥ fastPct% → 主动市价平仓.
    // 默认 3 分钟, 0.15% — 70% 的有效反弹在前 3min 启动, 还在亏 0.15% 大概率假信号.
    fastWindowMs: 180000,
    fastPct: 0.15,
    // 阶段 2 (标准窗口): fastWindowMs 之后, 价格反向 ≥ normalPct% → 主动平仓.
    // 离 100x × 50% 爆仓距离 0.50% 还有 0.20% buffer.
    normalPct: 0.30,
    // 阶段 3 (保本触发): 价格走我方向 ≥ protectAfterTouchPct% 后,
    //   把工具内部的 currentStopLoss 上移到 entryPrice (保本).
    //   后续若回踩 entry → fireSl(soft_sl_protect) 主动平仓, 不会亏本金.
    protectAfterTouchPct: 0.10,
    // TP1 触发后的 trailing: 价格每多走 stepPct% 顺势 → SL 跟着上移 stepPct%
    trailingAfterTp1: {
      enabled: true,
      stepPct: 0.20,
    },
  },
  // ⭐ 时间退出 (密集区策略专属): 反弹窗口过了就主动平仓, 释放保证金给下个信号.
  timeExit: {
    enabled: true,
    beforeTp1Ms: 600000,       // 10min 未触 TP1 → 全平仓
    beforeTp2Ms: 3600000,      // 60min 未触 TP2 → 平剩余仓位
    // 若设为数字, 仅当浮亏 > 该% 时退出 (避免浮赢窗口被切)
    // null = 任意盈亏都按时间退出
    onlyIfLossingPct: null,
  },
  // ⭐ 硬 SL 上限: 入场前强制 SL 距离 ≤ maxDistancePct%.
  // 覆盖 ATR 算的 SL — 100x × 50% 下 ATR 0.27%+ 时 1.5×ATR 已超爆仓距离 0.50%.
  hardSlCap: {
    enabled: true,
    maxDistancePct: 0.40,      // 比爆仓距离 0.50% 紧 0.10%
  },
  // ⭐ 半滚提利润提醒: 平仓后余额 > baselineUSD + thresholdUSD → 推送飞书 + TG.
  // 配合用户严格执行"赚了就提走, 留场永远 baselineUSD"的纪律, 把"几何含 0 的纯滚仓"
  // 改成"固定本金累积法".
  profitWithdraw: {
    enabled: true,
    baselineUSD: 10,           // 留场基线 (用户的 10U 滚仓本金)
    thresholdUSD: 0.5,         // 超过基线 0.5U 即推送
  },
  // ⭐ 连亏熔断: 连续 N 次软SL/爆仓 → 自动 cfg.enabled=false 暂停 X 毫秒.
  // key = 连亏次数 (字符串, JSON 友好), value = 暂停毫秒数; -1 = 暂停到手动恢复.
  // 任意一次 TP 命中重置 lossStreak=0.
  lossStreakBrake: {
    enabled: true,
    thresholds: { '2': 28800000, '3': 86400000, '4': -1 },
  },
  // ⭐ 本金保护线: 余额 < minUSD → cfg.enabled=false (强制停, 等手动恢复).
  // 防止把 10U 全亏完, 留种子重启.
  balanceGuard: {
    enabled: true,
    minUSD: 3.0,
  },
  // 由 riskEngine 自动写入, 用户不应直接 patch:
  lossStreak: 0,                              // 连续亏损笔数 (软SL/硬SL/爆仓)
  pausedUntilMs: null,                        // 暂停到该时间戳 (ms), 超过后 enabled 自动恢复
  pausedReason: null,                         // 'loss_streak_2' / 'balance_guard' / etc.
  // 账户余额 (USDT) — 由用户通过 POST /risk-guard/balance 上报, 或在 fill/close 时手动 patch.
  // riskEngine 用它做 balanceGuard / profitWithdraw 判定.
  accountBalanceUSD: null,
  symbol: 'BTCUSDT',                          // 监听符号
  // ↓↓↓ 用户在需求里固定的两条默认配置
  webhookUrl: 'https://transpenetrable-shantel-unabortively.ngrok-free.dev/webhook/wh_d113d9b4d838dbd635d4c19c3f0c51d9',
  token: 'wh_d113d9b4d838dbd635d4c19c3f0c51d9',
  // 默认杠杆与仓位（信号未带时兜底）
  defaultLeverage: 100,
  defaultPositionSize: '1%',
  // ⭐ 手动仓位覆盖 (单位 %, 数字): 设置后所有新开仓 (regime 自动 / 手动挂单 / 手动追单 /
  //    价格触发器 / 外部信号) 一律按该比例开仓, 覆盖按置信度的 1%/2%/3% 与信号显式仓位.
  //    null = 不覆盖 (按 regime 置信度自动: 高 3% / 中 2% / 低 1%).
  //    上限 MAX_MANUAL_POSITION_PCT (10%), patch 时自动 clamp.
  //    热更新: POST /api/auto-trade/position-size { pct: 5 }; { pct: null } 恢复自动.
  //    ⚠️ 只影响之后的新开仓, 已有 active 持仓 / pending 挂单不受影响.
  manualPositionPct: null,
  // 是否将开仓信号转发到 webhookUrl（外部下单端）
  forwardOpenOrders: true,
  // 出站 HTTP 超时
  webhookTimeoutMs: 15000,                    // 8s→15s, 减少"接收方已下单但响应慢被误判超时"的概率
  webhookRetry: 2,                            // 失败重试次数 (不含首次), ⚠️ 仅作用于平仓 (TP/SL); forwardOpen 始终 retry=0
  // 开仓后 cooldown: 同方向 forwardOpen 在该时间内重复触发会被拒绝, 防止极端情况下的二次下单
  openForwardCooldownMs: 15000,
  // TP/SL 模板：在 open_long/open_short 信号没有显式价位时按此计算
  // mode: 'percent'  → 用 % 距离
  //       'absolute' → 信号必须自带价位
  template: {
    mode: 'percent',
    long:  { sl: 1.5, tp1: 1.5, tp2: 3.0, tp3: 4.5 },  // 单位 % (正数, 方向自动反转)
    short: { sl: 1.5, tp1: 1.5, tp2: 3.0, tp3: 4.5 },
  },
  // TP1 触发后是否自动启动保本止损 (把 SL 上移到 entry 价).
  //   true  (默认): 触发 TP1 → webhook 同时携带 set_protection_sl=true 等字段, 接收方在交易所改 SL
  //                + riskEngine 把 currentStopLoss 改成 entryPrice.
  //   false      : 触发 TP1 仅 50% 平仓, 不改 SL, webhook 不携带 set_protection_sl 等三字段.
  // 前端开关切换 / POST /api/auto-trade/config { tp1Protection: false }
  tp1Protection: true,
  // 价格源
  // 默认 aggTrade: 每笔成交都推 (高峰可达 500+ tps), 毫秒级触发 entry/TP/SL,
  // 优先保障"交易安全 - 必须在到价的瞬间触发"这一核心需求.
  // 想用低频标记价 (1帧/秒): 在 .env 设 AUTO_TRADE_STREAM=btcusdt@markPrice@1s
  //   ⚠️ 此时极端瞬时插针可能在 1 秒空窗内回落, 错过 TP/SL 触发, 不推荐
  // 风控路径 (riskEngine.evaluate) 已**完全去节流**, 旧 AUTO_TRADE_EVAL_THROTTLE_MS 不再生效.
  priceFeed: {
    stream: process.env.AUTO_TRADE_STREAM || 'btcusdt@aggTrade',
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
    // ⚠️ 已废弃 (保留字段仅为兼容旧 disk config 不报错). riskEngine 不再节流, 每帧立即 evaluate.
    evalThrottleMs: parseInt(process.env.AUTO_TRADE_EVAL_THROTTLE_MS, 10) || 0,
  },
  // 鉴权 token：来自外部 webhook 信号的 token 必须与之相符
  // 默认与 webhook URL 末段一致，也可单独修改
  // （这里使用 token 字段作为校验值，复用同名）
  // 多通道推送开关
  // ⚠️ telegram 默认 false：trading 引擎所有事件 (开仓/止盈/止损/WS/重置)
  //    都不推 TG, 仅飞书 + 日志. TG 只接收 regime 喊单信号.
  //    如确实想让 trading 事件也发 TG, 在 .env 设 TRADING_NOTIFY_TG=1 同时打开此处
  notify: {
    feishu: true,
    telegram: false,
  },
};

// 手动仓位覆盖的硬上限 (%): 无论 disk / env / patch 传什么, 都 clamp 到 ≤ 10%
const MAX_MANUAL_POSITION_PCT = 10;

/** 把 manualPositionPct 规整为 null 或 (0, MAX_MANUAL_POSITION_PCT] 内的数字 */
function sanitizeManualPositionPct(cfg) {
  const n = Number(cfg.manualPositionPct);
  cfg.manualPositionPct = (Number.isFinite(n) && n > 0)
    ? Math.min(n, MAX_MANUAL_POSITION_PCT)
    : null;
}

// 在内存中持有的活动配置
let active = null;
const subscribers = new Set();

function ensureDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 深合并（浅层够用，但模板下还有一层） */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return { ...base };
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  let fromDisk = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fromDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('[trade.config] 读取配置失败, 回退默认:', e.message);
  }
  // env 覆盖
  const fromEnv = {};
  if (process.env.AUTO_TRADE_WEBHOOK_URL) fromEnv.webhookUrl = process.env.AUTO_TRADE_WEBHOOK_URL;
  if (process.env.AUTO_TRADE_WEBHOOK_TOKEN) fromEnv.token = process.env.AUTO_TRADE_WEBHOOK_TOKEN;
  if (process.env.AUTO_TRADE_ENABLED === '0') fromEnv.enabled = false;
  // 方向开关: .env 设 1 → 强制禁用; 不设或 0 → 走 disk / 默认值
  if (process.env.AUTO_TRADE_DISABLE_LONG === '1') fromEnv.disableLong = true;
  if (process.env.AUTO_TRADE_DISABLE_SHORT === '1') fromEnv.disableShort = true;

  // 价格围栏: .env 提供启动默认值 (disk 优先级仍然更低 — 这里 fromEnv 覆盖 fromDisk).
  // 想 UI 热更新走 POST /direction-guard, 不要靠 .env (改 .env 要重启).
  const guardLongThreshold  = parseFloat(process.env.AUTO_TRADE_GUARD_LONG_THRESHOLD);
  const guardShortThreshold = parseFloat(process.env.AUTO_TRADE_GUARD_SHORT_THRESHOLD);
  const guardHysteresisPct  = parseFloat(process.env.AUTO_TRADE_GUARD_HYSTERESIS_PCT);
  const guardMinSwitchMs    = parseInt(process.env.AUTO_TRADE_GUARD_MIN_SWITCH_MS, 10);
  if (Number.isFinite(guardLongThreshold) && guardLongThreshold > 0) {
    fromEnv.directionGuard = fromEnv.directionGuard || {};
    fromEnv.directionGuard.long = { enabled: process.env.AUTO_TRADE_GUARD_LONG_ENABLED === '1', threshold: guardLongThreshold };
  }
  if (Number.isFinite(guardShortThreshold) && guardShortThreshold > 0) {
    fromEnv.directionGuard = fromEnv.directionGuard || {};
    fromEnv.directionGuard.short = { enabled: process.env.AUTO_TRADE_GUARD_SHORT_ENABLED === '1', threshold: guardShortThreshold };
  }
  if (Number.isFinite(guardHysteresisPct) && guardHysteresisPct >= 0) {
    fromEnv.directionGuard = fromEnv.directionGuard || {};
    fromEnv.directionGuard.hysteresisPct = guardHysteresisPct;
  }
  if (Number.isFinite(guardMinSwitchMs) && guardMinSwitchMs >= 0) {
    fromEnv.directionGuard = fromEnv.directionGuard || {};
    fromEnv.directionGuard.minSwitchIntervalMs = guardMinSwitchMs;
  }

  // Regime 守卫: .env 提供启动默认值 (UI 热更新走 POST /regime-guard).
  if (process.env.AUTO_TRADE_REGIME_GUARD_ENABLED === '1') {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.enabled = true;
  } else if (process.env.AUTO_TRADE_REGIME_GUARD_ENABLED === '0') {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.enabled = false;
  }
  if (process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_LONG_ON_STRONG_BEAR != null) {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.blockLongOnStrongBear = process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_LONG_ON_STRONG_BEAR === '1';
  }
  if (process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_SHORT_ON_STRONG_BULL != null) {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.blockShortOnStrongBull = process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_SHORT_ON_STRONG_BULL === '1';
  }
  if (process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_BOTH_ON_PANIC != null) {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.blockBothOnPanic = process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_BOTH_ON_PANIC === '1';
  }
  if (process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_BOTH_ON_UNCLEAR != null) {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.blockBothOnUnclear = process.env.AUTO_TRADE_REGIME_GUARD_BLOCK_BOTH_ON_UNCLEAR === '1';
  }
  const minConf = process.env.AUTO_TRADE_REGIME_GUARD_MIN_CONFIDENCE;
  if (minConf && ['low', 'medium', 'high'].includes(minConf)) {
    fromEnv.regimeGuard = fromEnv.regimeGuard || {};
    fromEnv.regimeGuard.minConfidence = minConf;
  }

  // 风控套件 .env 覆盖 (优先级: env > disk > default).
  // 想 UI 热更新走 POST /risk-guard, 不要靠 .env (改 .env 要重启).
  const _ssl = (k) => process.env[k];
  if (_ssl('AUTO_TRADE_RISK_GUARD_ENABLED') != null) {
    fromEnv.riskGuardEnabled = _ssl('AUTO_TRADE_RISK_GUARD_ENABLED') === '1';
  }
  if (_ssl('AUTO_TRADE_SOFT_SL_ENABLED') != null) {
    fromEnv.softStopLoss = fromEnv.softStopLoss || {};
    fromEnv.softStopLoss.enabled = _ssl('AUTO_TRADE_SOFT_SL_ENABLED') === '1';
  }
  const sslFastWin = parseInt(_ssl('AUTO_TRADE_SOFT_SL_FAST_WINDOW_MS'), 10);
  if (Number.isFinite(sslFastWin) && sslFastWin > 0) {
    fromEnv.softStopLoss = fromEnv.softStopLoss || {};
    fromEnv.softStopLoss.fastWindowMs = sslFastWin;
  }
  const sslFastPct = parseFloat(_ssl('AUTO_TRADE_SOFT_SL_FAST_PCT'));
  if (Number.isFinite(sslFastPct) && sslFastPct > 0) {
    fromEnv.softStopLoss = fromEnv.softStopLoss || {};
    fromEnv.softStopLoss.fastPct = sslFastPct;
  }
  const sslNormPct = parseFloat(_ssl('AUTO_TRADE_SOFT_SL_NORMAL_PCT'));
  if (Number.isFinite(sslNormPct) && sslNormPct > 0) {
    fromEnv.softStopLoss = fromEnv.softStopLoss || {};
    fromEnv.softStopLoss.normalPct = sslNormPct;
  }
  const sslProtectPct = parseFloat(_ssl('AUTO_TRADE_SOFT_SL_PROTECT_PCT'));
  if (Number.isFinite(sslProtectPct) && sslProtectPct > 0) {
    fromEnv.softStopLoss = fromEnv.softStopLoss || {};
    fromEnv.softStopLoss.protectAfterTouchPct = sslProtectPct;
  }
  if (_ssl('AUTO_TRADE_TIME_EXIT_ENABLED') != null) {
    fromEnv.timeExit = fromEnv.timeExit || {};
    fromEnv.timeExit.enabled = _ssl('AUTO_TRADE_TIME_EXIT_ENABLED') === '1';
  }
  const teTp1Ms = parseInt(_ssl('AUTO_TRADE_TIME_EXIT_TP1_MS'), 10);
  if (Number.isFinite(teTp1Ms) && teTp1Ms > 0) {
    fromEnv.timeExit = fromEnv.timeExit || {};
    fromEnv.timeExit.beforeTp1Ms = teTp1Ms;
  }
  const teTp2Ms = parseInt(_ssl('AUTO_TRADE_TIME_EXIT_TP2_MS'), 10);
  if (Number.isFinite(teTp2Ms) && teTp2Ms > 0) {
    fromEnv.timeExit = fromEnv.timeExit || {};
    fromEnv.timeExit.beforeTp2Ms = teTp2Ms;
  }
  if (_ssl('AUTO_TRADE_HARD_SL_CAP_ENABLED') != null) {
    fromEnv.hardSlCap = fromEnv.hardSlCap || {};
    fromEnv.hardSlCap.enabled = _ssl('AUTO_TRADE_HARD_SL_CAP_ENABLED') === '1';
  }
  const hslMaxPct = parseFloat(_ssl('AUTO_TRADE_HARD_SL_MAX_DISTANCE_PCT'));
  if (Number.isFinite(hslMaxPct) && hslMaxPct > 0) {
    fromEnv.hardSlCap = fromEnv.hardSlCap || {};
    fromEnv.hardSlCap.maxDistancePct = hslMaxPct;
  }
  if (_ssl('AUTO_TRADE_PROFIT_WITHDRAW_ENABLED') != null) {
    fromEnv.profitWithdraw = fromEnv.profitWithdraw || {};
    fromEnv.profitWithdraw.enabled = _ssl('AUTO_TRADE_PROFIT_WITHDRAW_ENABLED') === '1';
  }
  const pwBaseline = parseFloat(_ssl('AUTO_TRADE_PROFIT_WITHDRAW_BASELINE_USD'));
  if (Number.isFinite(pwBaseline) && pwBaseline > 0) {
    fromEnv.profitWithdraw = fromEnv.profitWithdraw || {};
    fromEnv.profitWithdraw.baselineUSD = pwBaseline;
  }
  if (_ssl('AUTO_TRADE_LOSS_STREAK_ENABLED') != null) {
    fromEnv.lossStreakBrake = fromEnv.lossStreakBrake || {};
    fromEnv.lossStreakBrake.enabled = _ssl('AUTO_TRADE_LOSS_STREAK_ENABLED') === '1';
  }
  if (_ssl('AUTO_TRADE_BALANCE_GUARD_ENABLED') != null) {
    fromEnv.balanceGuard = fromEnv.balanceGuard || {};
    fromEnv.balanceGuard.enabled = _ssl('AUTO_TRADE_BALANCE_GUARD_ENABLED') === '1';
  }
  const bgMin = parseFloat(_ssl('AUTO_TRADE_BALANCE_GUARD_MIN_USD'));
  if (Number.isFinite(bgMin) && bgMin > 0) {
    fromEnv.balanceGuard = fromEnv.balanceGuard || {};
    fromEnv.balanceGuard.minUSD = bgMin;
  }

  active = deepMerge(deepMerge(DEFAULT_CONFIG, fromDisk), fromEnv);
  sanitizeManualPositionPct(active);
  // 启动时强制把 autoDisable* 重置 (避免上次运行时的"幽灵"自动拦截状态遗留下来,
  // 重新评估应该由 riskEngine 在第一帧 tick 上重新决定).
  active.autoDisableLong = false;
  active.autoDisableShort = false;
  // Regime 守卫的状态字段也重置 — 启动后由 riskEngine 第一次 evaluateRegimeGuard 重新填.
  active.regimeAutoDisableLong = false;
  active.regimeAutoDisableShort = false;
  active.regimeAutoLastSubRegime = null;
  active.regimeAutoLastConfidence = null;
  active.regimeAutoLastEvalAt = null;
  // 风控套件: 启动时重置连亏计数与暂停状态 (用户重启进程通常意味着想"清白上场"
  // 不要让上次运行的连亏熔断悬而未决导致一启动就拦交易).
  active.lossStreak = 0;
  active.pausedUntilMs = null;
  active.pausedReason = null;
  const dg = active.directionGuard || {};
  const rg = active.regimeGuard || {};
  const ssl = active.softStopLoss || {};
  const te = active.timeExit || {};
  const hsl = active.hardSlCap || {};
  const pw = active.profitWithdraw || {};
  const lsb = active.lossStreakBrake || {};
  const bg = active.balanceGuard || {};
  console.log(
    `[trade.config] 已加载: webhook=${active.webhookUrl?.slice(0, 60)}... enabled=${active.enabled}` +
    ` · disableLong=${!!active.disableLong} · disableShort=${!!active.disableShort}` +
    ` · manualPositionPct=${active.manualPositionPct != null ? active.manualPositionPct + '%' : 'auto(置信度1/2/3%)'}` +
    ` · directionGuard long(${dg.long?.enabled ? 'on' : 'off'} ${dg.long?.threshold ?? '--'})` +
    ` short(${dg.short?.enabled ? 'on' : 'off'} ${dg.short?.threshold ?? '--'})` +
    ` hysteresis=${dg.hysteresisPct ?? '--'}% minSwitch=${dg.minSwitchIntervalMs ?? '--'}ms` +
    ` · regimeGuard ${rg.enabled ? 'on' : 'off'}` +
    ` (LongOnSB=${rg.blockLongOnStrongBear ? '1' : '0'} ShortOnSB=${rg.blockShortOnStrongBull ? '1' : '0'}` +
    ` PANIC=${rg.blockBothOnPanic ? '1' : '0'} UNCLEAR=${rg.blockBothOnUnclear ? '1' : '0'} minConf=${rg.minConfidence})`
  );
  const masterOn = active.riskGuardEnabled !== false;
  console.log(
    `[trade.config] 🛡 风控套件 [总开关 ${masterOn ? '✅ ON' : '🔴 OFF · 所有保护都被禁用'}]:` +
    ` softSL ${ssl.enabled ? 'on' : 'off'} (fast ${ssl.fastPct}%/${ssl.fastWindowMs}ms · norm ${ssl.normalPct}% · protect ${ssl.protectAfterTouchPct}% · trailingTp1 ${ssl.trailingAfterTp1?.enabled ? ssl.trailingAfterTp1.stepPct + '%' : 'off'})` +
    ` · timeExit ${te.enabled ? 'on' : 'off'} (tp1<${te.beforeTp1Ms}ms · tp2<${te.beforeTp2Ms}ms)` +
    ` · hardSlCap ${hsl.enabled ? 'on ' + hsl.maxDistancePct + '%' : 'off'}` +
    ` · profitWithdraw ${pw.enabled ? 'on baseline=' + pw.baselineUSD + 'U' : 'off'}` +
    ` · lossStreakBrake ${lsb.enabled ? 'on ' + JSON.stringify(lsb.thresholds) : 'off'}` +
    ` · balanceGuard ${bg.enabled ? 'on min=' + bg.minUSD + 'U' : 'off'}`
  );
  return active;
}

function save() {
  try {
    ensureDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(active, null, 2));
  } catch (e) {
    console.error('[trade.config] 保存失败:', e.message);
  }
}

function get() {
  if (!active) load();
  return active;
}

/**
 * 局部更新配置（深合并），写盘并通知订阅者
 * @param {object} patch
 */
function patch(p) {
  if (!active) load();
  active = deepMerge(active, p || {});
  sanitizeManualPositionPct(active);
  save();
  for (const fn of subscribers) {
    try { fn(active); } catch (e) { console.error('[trade.config] subscriber 异常:', e.message); }
  }
  return active;
}

function subscribe(fn) {
  if (typeof fn === 'function') subscribers.add(fn);
  return () => subscribers.delete(fn);
}

load();

module.exports = { get, patch, subscribe, DEFAULT_CONFIG, MAX_MANUAL_POSITION_PCT };
