/**
 * ============================================================
 *  trading/orderFlowStore.js
 *  后台真实 Order Flow 订单流收集器
 *  - 订阅 priceFeed 的逐笔 tick (无阻塞，O(1) 复杂度)
 *  - 将 tick 聚合为多周期的真实买卖盘分布 (Footprint)
 *  - 提供 API 给前端，用真实数据覆盖历史 K 线的模拟数据
 * ============================================================
 */
'use strict';

const EventEmitter = require('events');
const priceFeed = require('./priceFeed');
const feishuWebhook = require('../notifier/feishuWebhook');

const TICK_SIZE = 10.0;
const DELTA_ALERT_MIN = Math.max(0, parseFloat(process.env.ORDERFLOW_DELTA_ALERT_MIN) || 50);
const _deltaAlertSent = new Set();

function trySendDeltaAlert({ tf, direction, delta, startTime, symbol, source }) {
    const isLong = direction === 'long';
    const barTs = Number(startTime) || 0;
    const eventKey = `orderflow_delta_${tf || '1m'}_${isLong ? 'L' : 'S'}_${barTs}`;
    
    // 如果已经发送过这个时间点的报警，不再发送
    if (_deltaAlertSent.has(eventKey) && source === 'store-live') {
        return { ok: false, skipped: 'already_sent' };
    }
    
    _deltaAlertSent.add(eventKey);
    if (_deltaAlertSent.size > 400) {
        const first = _deltaAlertSent.values().next().value;
        _deltaAlertSent.delete(first);
    }
    const timeStr = new Date(barTs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const dStr = `${delta >= 0 ? '+' : ''}${Number(delta).toFixed(2)}`;
    const title = isLong
        ? `🟢 [Order Flow] ${tf || '1m'} Delta ≥ +${DELTA_ALERT_MIN}`
        : `🔴 [Order Flow] ${tf || '1m'} Delta ≤ -${DELTA_ALERT_MIN}`;
    console.log(`[orderFlow] 📣 飞书 ${title} Δ=${dStr} bar=${timeStr} source=${source || 'store'} (Force Push)`);
    
    // 强制使用东八区时间
    const alertTimeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    feishuWebhook.sendRich(title, [
        [{ text: '交易对：' }, { text: String(symbol || 'BTCUSDT') }],
        [{ text: 'K线开盘：' }, { text: timeStr }],
        [{ text: '净 Delta：' }, { text: dStr }],
        [{ text: '方向：' }, { text: isLong ? '买盘占优' : '卖盘占优' }],
        [{ text: `来源：${source || 'orderFlowStore'} · 单根 1m 达到 ±${DELTA_ALERT_MIN} 即推`, italic: true }],
        [{ text: `⏰ ${alertTimeStr}`, italic: true }],
    ], { force: true }).then(res => {
        if (!res.ok) console.error(`[orderFlow] 飞书推送被拦截或失败:`, res);
    }).catch(err => {
        console.error(`[orderFlow] 飞书推送异常:`, err.message);
    });
    
    return { ok: true, eventKey };
}

function maybeAlertBar(bar, tfKey, source) {
    if (!bar || tfKey !== '1m') return;
    const d = bar.totalDelta;
    if (!Number.isFinite(d)) return;
    if (d >= DELTA_ALERT_MIN && !bar.alertedLong) {
        bar.alertedLong = true;
        console.log(`[OrderFlow] Delta Alert Triggered (Long): delta=${d}, time=${new Date(bar.startTime).toLocaleTimeString()}`);
        trySendDeltaAlert({
            tf: '1m', direction: 'long', delta: d,
            startTime: bar.startTime, source,
        });
    } else if (d <= -DELTA_ALERT_MIN && !bar.alertedShort) {
        bar.alertedShort = true;
        console.log(`[OrderFlow] Delta Alert Triggered (Short): delta=${d}, time=${new Date(bar.startTime).toLocaleTimeString()}`);
        trySendDeltaAlert({
            tf: '1m', direction: 'short', delta: d,
            startTime: bar.startTime, source,
        });
    }
}

class OrderFlowStore extends EventEmitter {
    constructor() {
        super();
        this.history = {
            '1m': new Map(), // timestamp -> bar data
            '5m': new Map(),
            '15m': new Map(),
            '1h': new Map()
        };
        // 保存足够长的历史以满足前端 150 根 K 线的需求
        this.maxBars = 150;

        // 大单追踪记录，保存在后端以支持前端跨周期/刷新不丢失
        this.largeOrders = [];
        this.maxLargeOrders = 30; // 对应前端 tapeList 显示数量
        this.largeOrderStats = { totalBuy: 0, totalSell: 0 };
        this.LARGE_ORDER_THRESHOLD = 1.0;

        // 无阻塞监听 tick，O(1) 操作，不影响风控引擎
        priceFeed.on('tick', (data) => this._onTick(data));
    }

    _onTick(data) {
        const { ts, raw } = data;
        if (!raw || !raw.q || !raw.p) return;
        const price = parseFloat(raw.p);
        const qty = parseFloat(raw.q);
        const isSell = raw.m; // true = active sell (maker is buyer)
        // 用成交时间 T 对齐 K 线边界 (不要用本机 Date.now, 否则和页面/交易所收盘对不齐)
        const tradeTs = Number(raw.T) || ts;

        const level = Math.floor(price / TICK_SIZE) * TICK_SIZE;

        // 大单追踪记录
        if (qty >= this.LARGE_ORDER_THRESHOLD) {
            if (isSell) {
                this.largeOrderStats.totalSell += qty;
            } else {
                this.largeOrderStats.totalBuy += qty;
            }
            this.largeOrders.unshift({ price, qty, isSell, timeMs: ts });
            if (this.largeOrders.length > this.maxLargeOrders) {
                this.largeOrders.pop();
            }
        }

        this._updateBar('1m', 60 * 1000, tradeTs, price, qty, isSell, level);
        this._updateBar('5m', 5 * 60 * 1000, tradeTs, price, qty, isSell, level);
        this._updateBar('15m', 15 * 60 * 1000, tradeTs, price, qty, isSell, level);
        this._updateBar('1h', 60 * 60 * 1000, tradeTs, price, qty, isSell, level);
    }

    _updateBar(tfKey, tfMs, ts, price, qty, isSell, level) {
        const startTime = Math.floor(ts / tfMs) * tfMs;
        let map = this.history[tfKey];

        if (!map.has(startTime)) {
            // 新 K 线开始: 再对「刚走完的上一分钟」补一次收盘检查 (防止最后一笔刚越过阈值)
            if (tfKey === '1m' && map.size > 0) {
                const prevKey = Math.max(...Array.from(map.keys()));
                const prev = map.get(prevKey);
                if (prev) {
                    maybeAlertBar(prev, tfKey, 'store-close');
                }
            }

            // 清理旧数据，防止内存泄漏 (Ring Buffer 机制)
            if (map.size >= this.maxBars) {
                const oldest = Math.min(...Array.from(map.keys()));
                map.delete(oldest);
            }
            map.set(startTime, {
                startTime,
                cells: {},
                totalDelta: 0,
                alertedLong: false,
                alertedShort: false,
            });
        }

        let bar = map.get(startTime);
        if (!bar.cells[level]) {
            bar.cells[level] = { buyVol: 0, sellVol: 0 };
        }
        if (isSell) {
            bar.cells[level].sellVol += qty;
            bar.totalDelta -= qty;
        } else {
            bar.cells[level].buyVol += qty;
            bar.totalDelta += qty;
        }

        // 严格执行“收盘结算触发”纪律：
        // 不在这里（盘中）调用 maybeAlertBar，过滤掉盘中的假突破噪音。
        // 只有当 K 线走完，在上方的新 K 线生成逻辑中，才会通过 'store-close' 结算上一根 K 线的最终真实 Delta。
    }

    getHistory(tfKey) {
        const map = this.history[tfKey];
        if (!map) return [];
        return Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
    }
}

module.exports = new OrderFlowStore();
module.exports.trySendDeltaAlert = trySendDeltaAlert;
module.exports.DELTA_ALERT_MIN = DELTA_ALERT_MIN;
