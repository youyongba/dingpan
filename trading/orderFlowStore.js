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

        this._updateBar('1m', 60 * 1000, ts, price, qty, isSell, level);
        this._updateBar('5m', 5 * 60 * 1000, ts, price, qty, isSell, level);
        this._updateBar('15m', 15 * 60 * 1000, ts, price, qty, isSell, level);
        this._updateBar('1h', 60 * 60 * 1000, ts, price, qty, isSell, level);
    }

    _updateBar(tfKey, tfMs, ts, price, qty, isSell, level) {
        const startTime = Math.floor(ts / tfMs) * tfMs;
        let map = this.history[tfKey];

        if (!map.has(startTime)) {
            // === 收盘判定与报警逻辑 ===
            // 当新的 startTime 出现时，意味着上一根 K 线刚刚走完
            if (tfKey === '1m' && map.size > 0) {
                const lastStartTime = Math.max(...Array.from(map.keys()));
                const lastBar = map.get(lastStartTime);

                if (lastBar.totalDelta >= 50) {
                    const timeStr = new Date(lastStartTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                    feishuWebhook.sendText(`🚨 [Order Flow] 1分钟 Delta 收盘确认\n时间: ${timeStr}\n方向: 多头强势 (收盘 Delta ≥ 50)\n最终净买入: +${lastBar.totalDelta.toFixed(2)}`, { eventKey: `1m_delta_close_50_${lastStartTime}`, force: true });
                } else if (lastBar.totalDelta <= -50) {
                    const timeStr = new Date(lastStartTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                    feishuWebhook.sendText(`🚨 [Order Flow] 1分钟 Delta 收盘确认\n时间: ${timeStr}\n方向: 空头强势 (收盘 Delta ≤ -50)\n最终净卖出: ${lastBar.totalDelta.toFixed(2)}`, { eventKey: `1m_delta_close_-50_${lastStartTime}`, force: true });
                }
            }

            // 清理旧数据，防止内存泄漏 (Ring Buffer 机制)
            if (map.size >= this.maxBars) {
                const oldest = Math.min(...Array.from(map.keys()));
                map.delete(oldest);
            }
            map.set(startTime, {
                startTime,
                cells: {}, // level -> { buyVol, sellVol }
                totalDelta: 0,
                alertedDir: 0
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
    }

    getHistory(tfKey) {
        const map = this.history[tfKey];
        if (!map) return [];
        return Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
    }
}

module.exports = new OrderFlowStore();
