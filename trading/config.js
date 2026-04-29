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
  symbol: 'BTCUSDT',                          // 监听符号
  // ↓↓↓ 用户在需求里固定的两条默认配置
  webhookUrl: 'https://transpenetrable-shantel-unabortively.ngrok-free.dev/webhook/wh_d113d9b4d838dbd635d4c19c3f0c51d9',
  token: 'wh_d113d9b4d838dbd635d4c19c3f0c51d9',
  // 默认杠杆与仓位（信号未带时兜底）
  defaultLeverage: 100,
  defaultPositionSize: '1%',
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
  // 默认 markPrice@1s: 1 帧/秒, 与币安清算系统使用的标记价一致, CPU 友好.
  // 想回 aggTrade 高频 tick: 在 .env 设 AUTO_TRADE_STREAM=btcusdt@aggTrade
  // (此时强烈建议同时设 AUTO_TRADE_EVAL_THROTTLE_MS=200 给 onTick 加节流)
  priceFeed: {
    stream: process.env.AUTO_TRADE_STREAM || 'btcusdt@markPrice@1s',
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
    // onTick 节流(ms): aggTrade 时建议 200; markPrice@1s 时设 0 即可
    // 节流策略是"取最新价"模式 — 不丢 tick, lastPrice 一直更新, 到点跑一次 evaluate
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

  active = deepMerge(deepMerge(DEFAULT_CONFIG, fromDisk), fromEnv);
  console.log(`[trade.config] 已加载: webhook=${active.webhookUrl?.slice(0, 60)}... enabled=${active.enabled}`);
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

module.exports = { get, patch, subscribe, DEFAULT_CONFIG };
