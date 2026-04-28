/**
 * ============================================================
 *  trading/priceFeed.js
 *  Binance USDT 永续合约 WebSocket 实时价格订阅
 *
 *  - 默认订阅 btcusdt@aggTrade（每笔成交都推, 实时性最佳）
 *  - 心跳 ping/pong 监测；30s 无数据则强制重连
 *  - 指数退避自动重连：1s → 2s → 4s ... 上限 30s
 *  - 通过 EventEmitter 对外广播 'tick' / 'open' / 'close' / 'error'
 * ============================================================
 */
'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('./config');

// 2026 起 Binance fapi 永续合约 WS 端点升级为 /market/ws/<stream>,
// 旧路径 /ws/<stream> 在部分线路握手能成功但不再下发数据 (no_first_tick).
// 如需回退老路径或自定义入口, 在 .env 设 BINANCE_WS_BASE=wss://fstream.binance.com/ws
const FAPI_WS_BASE = process.env.BINANCE_WS_BASE || 'wss://fstream.binance.com/market/ws';
const HANDSHAKE_TIMEOUT = parseInt(process.env.BINANCE_WS_HANDSHAKE_MS || '20000', 10);

/**
 * 解析 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 环境变量, 自动构造 agent
 *  - http(s)://host:port      → HttpsProxyAgent
 *  - socks5://host:port       → SocksProxyAgent
 * 中国大陆访问 binance fapi 必须走代理, 否则握手 10s 超时
 */
function buildProxyAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.ALL_PROXY    || process.env.all_proxy
    || process.env.HTTP_PROXY   || process.env.http_proxy;
  if (!proxy) return null;
  try {
    if (/^socks/i.test(proxy)) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      console.log(`[trade.priceFeed] 使用 SOCKS 代理: ${proxy}`);
      return new SocksProxyAgent(proxy);
    }
    const { HttpsProxyAgent } = require('https-proxy-agent');
    console.log(`[trade.priceFeed] 使用 HTTPS 代理: ${proxy}`);
    return new HttpsProxyAgent(proxy);
  } catch (e) {
    console.error('[trade.priceFeed] 代理 agent 创建失败, 回退直连:', e.message);
    return null;
  }
}

class PriceFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.lastPrice = null;
    this.lastTickAt = 0;
    this.connectedAt = 0;
    this.attempt = 0;
    this.stopped = false;
    this.staleTimer = null;
    this.reconnectTimer = null;

    // 配置变更时重连
    config.subscribe(() => {
      console.log('[trade.priceFeed] 配置变更, 重启连接');
      this._safeClose();
      this._scheduleReconnect(0);
    });
  }

  start() {
    this.stopped = false;
    this._connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this._safeClose();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
  }

  getStatus() {
    return {
      connected: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
      lastPrice: this.lastPrice,
      lastTickAt: this.lastTickAt,
      lastTickAgoMs: this.lastTickAt ? (Date.now() - this.lastTickAt) : null,
      reconnectAttempt: this.attempt,
      stream: config.get().priceFeed.stream,
    };
  }

  _safeClose() {
    // 先停 staleTimer: 避免连接已关闭但 staleTimer 仍 5s 一次自检 → 重复触发
    // _safeClose + _scheduleReconnect 形成 CPU 风暴 (P2 元凶).
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    try {
      ws.removeAllListeners();
      // 关键: 握手未完成时 terminate() 会异步 emit 'error'
      // ('WebSocket was closed before the connection was established')
      // 上面已 removeAllListeners, 不挂兜底就会变成 unhandled 'error', 进程崩溃
      ws.on('error', () => {});
      ws.terminate();
    } catch (_) { /* ignore */ }
  }

  _connect() {
    if (this.stopped) return;
    const cfg = config.get();
    const stream = cfg.priceFeed.stream || 'btcusdt@aggTrade';
    const url = `${FAPI_WS_BASE}/${stream}`;

    const agent = buildProxyAgent();
    console.log(`[trade.priceFeed] 连接 ${url} (attempt=${this.attempt + 1}, proxy=${agent ? 'on' : 'direct'}, handshakeTimeout=${HANDSHAKE_TIMEOUT}ms)`);
    const ws = new WebSocket(url, {
      handshakeTimeout: HANDSHAKE_TIMEOUT,
      perMessageDeflate: false,
      ...(agent ? { agent } : {}),
    });
    this.ws = ws;

    ws.on('open', () => {
      this.connectedAt = Date.now();
      // 关键: 上一次连接残留的 lastTickAt 在新连接里没意义,
      // 不清会让 stale watcher 在 5s 内立刻按"上次断开到现在"的差值误杀新连接
      this.lastTickAt = 0;
      this.attempt = 0;
      console.log('[trade.priceFeed] ✅ 已连接');
      this.emit('open');
      this._armStaleWatcher();
    });

    // emit('tick') 节流: aggTrade 在 BTC 波动期一秒推 200-500 帧, 每帧都触发整条
    // riskEngine 事件链 (evaluate × 多空双方向 + console.log) 会把 1 vCPU 顶满.
    // 此处节流策略与 riskEngine.onTick 一致 — "取最新价"模式, lastPrice 实时更新,
    // 到节流间隔后 emit 一次. 不丢风控: TP/SL 容忍度远 > 200ms.
    let _emitLastAt = 0;
    let _emitPendingTimer = null;
    const _doEmit = () => {
      _emitLastAt = Date.now();
      _emitPendingTimer = null;
      this.emit('tick', { price: this.lastPrice, ts: this.lastTickAt, raw: null });
    };
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      // aggTrade: {e:'aggTrade', p:'69123.45', T: 1234567890, ...}
      // markPrice: {e:'markPriceUpdate', p:'...', E:..., ...}
      const priceStr = msg.p || msg.c || (msg.k && msg.k.c);
      const price = parseFloat(priceStr);
      if (!Number.isFinite(price)) return;
      this.lastPrice = price;
      this.lastTickAt = Date.now();

      const throttle = (config.get().priceFeed && config.get().priceFeed.evalThrottleMs) || 0;
      if (throttle <= 0) {
        this.emit('tick', { price, ts: this.lastTickAt, raw: msg });
        return;
      }
      const since = this.lastTickAt - _emitLastAt;
      if (since >= throttle) {
        _doEmit();
      } else if (!_emitPendingTimer) {
        _emitPendingTimer = setTimeout(_doEmit, throttle - since);
      }
    });

    ws.on('ping', (data) => { try { ws.pong(data); } catch (_) {} });
    ws.on('pong', () => { /* keepalive */ });

    ws.on('close', (code, reason) => {
      console.warn(`[trade.priceFeed] 连接关闭 code=${code} reason=${reason}`);
      this.emit('close', { code, reason: reason?.toString() });
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[trade.priceFeed] 错误:', err.message);
      this.emit('error', err);
      // 错误后会触发 close, 不在此处直接重连
    });
  }

  _armStaleWatcher() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => {
      // 基准: 已收到 tick 后用 lastTickAt; 未收到首笔时回退到 connectedAt,
      // 否则代理握手成功但不过数据时会永远卡在 "✅ 已连接 · 无最新价"
      const ref = this.lastTickAt || this.connectedAt;
      if (!ref) return;
      const idle = Date.now() - ref;
      if (idle > 30 * 1000) {
        const isFirst = !this.lastTickAt;
        const reason = isFirst ? 'no_first_tick' : 'stale_no_tick';
        console.warn(
          `[trade.priceFeed] ⚠️ ${idle}ms ${isFirst ? '连上但无首笔 tick' : '无新数据'}, 强制重连`
        );
        this.emit('error', new Error(reason));
        this._safeClose();
        // 走指数退避(最少 reconnectMinMs), 避免代理/网络抖动时 5s/次的硬重连风暴
        this._scheduleReconnect();
      }
    }, 5000);
  }

  _scheduleReconnect(forceMs) {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const cfg = config.get().priceFeed;
    const min = cfg.reconnectMinMs || 1000;
    const max = cfg.reconnectMaxMs || 30000;
    const wait = forceMs != null
      ? forceMs
      : Math.min(max, min * Math.pow(2, this.attempt));
    this.attempt += 1;
    console.log(`[trade.priceFeed] ${wait}ms 后重连`);
    this.reconnectTimer = setTimeout(() => this._connect(), wait);
  }
}

module.exports = new PriceFeed();
