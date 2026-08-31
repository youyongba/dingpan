const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const { httpAgent, httpsAgent } = require('./lib/httpAgents');
const regimeModule = require('./regimeModule');
const mtfModule = require('./mtfModule');

// 币安现货 API 密钥
const SPOT_API_KEY = (process.env.BINANCE_SPOT_API_KEY || '').trim();
const SPOT_API_SECRET = (process.env.BINANCE_SPOT_API_SECRET || '').trim();

let currentPrice = 0;
let currentMinuteDelta = 0;
let lastMinuteStamp = 0;
let deltaUsdt = 0;

let botSignalState = {
    rsiHitTime: 0,
    macdHitTime: 0,
    lastDcaTime: 0,
    isExecuting: false
};

// 1. 后端实时监听微观订单流 (脱离浏览器也能运行)
function initBackendDeltaWS() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@aggTrade');
    ws.on('open', () => console.log('[SpotAutoBot] WS Connected for Backend Delta tracking'));
    ws.on('message', (data) => {
        const parsed = JSON.parse(data);
        const price = parseFloat(parsed.p);
        const qty = parseFloat(parsed.q);
        const isSell = parsed.m;
        currentPrice = price;

        const now = new Date();
        const currentMinute = now.getMinutes();
        if (currentMinute !== lastMinuteStamp) {
            currentMinuteDelta = 0;
            lastMinuteStamp = currentMinute;
        }
        currentMinuteDelta += isSell ? -qty : qty;
        deltaUsdt = currentMinuteDelta * currentPrice;
    });
    ws.on('error', (e) => console.error('[SpotAutoBot] WS Error:', e.message));
    ws.on('close', () => setTimeout(initBackendDeltaWS, 3000));
}

// 2. 真实现货下单 API
async function executeRealOrder(side, quantity, quoteOrderQty) {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) throw new Error('Missing API Keys in .env');
    
    const timestamp = Date.now();
    let queryString = `symbol=BTCUSDT&side=${side}&type=MARKET&recvWindow=60000&timestamp=${timestamp}`;
    if (quantity) queryString += `&quantity=${quantity}`;
    if (quoteOrderQty) queryString += `&quoteOrderQty=${quoteOrderQty}`;

    const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
    const url = `https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`;

    const res = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
        httpAgent, httpsAgent
    });
    return res.data;
}

// 2.5 真实合约下单 API 与杠杆设置
async function setFuturesLeverage(leverage) {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) return;
    const timestamp = Date.now();
    const queryString = `symbol=BTCUSDT&leverage=${leverage}&recvWindow=60000&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/leverage?${queryString}&signature=${signature}`;
    
    try {
        await axios.post(url, null, {
            headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
            httpAgent, httpsAgent
        });
        console.log(`[SpotAutoBot] Set Futures Leverage to ${leverage}x`);
    } catch (e) {
        console.error('[SpotAutoBot] Set Leverage Error:', e.response ? e.response.data : e.message);
    }
}

async function executeFuturesOrder(side, quantity) {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) throw new Error('Missing API Keys in .env');
    const timestamp = Date.now();
    let queryString = `symbol=BTCUSDT&side=${side}&type=MARKET&recvWindow=60000&timestamp=${timestamp}`;
    if (quantity) queryString += `&quantity=${quantity}`;

    const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

    const res = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
        httpAgent, httpsAgent
    });
    return res.data;
}

// 3. 核心策略状态机轮询
function startBotLoop(getEngineConfig, getEngineState) {
    initBackendDeltaWS();
    
    setInterval(async () => {
        const config = getEngineConfig();
        const state = getEngineState();
        
        if (!state.isBotRunning || !config.autoLoop) return;
        if (botSignalState.isExecuting) return;

        const now = Date.now();
        const windowMs = (config.signalWindow || 12) * 15 * 60 * 1000;

        // --- A. 获取宏观指标状态 ---
        let rsi = null, macdState = null, mtfState = null;
        try {
            if (regimeModule && typeof regimeModule.getState === 'function') {
                const regimeState = regimeModule.getState();
                if (regimeState && regimeState.m15) {
                    const m15 = regimeState.m15;
                    if (m15.rsi && m15.rsi.length > 0) rsi = m15.rsi[m15.rsi.length - 1];
                    if (m15.macd && m15.signal && m15.macd.length > 0) {
                        macdState = m15.macd[m15.macd.length - 1] > m15.signal[m15.signal.length - 1] ? '金叉' : '死叉';
                    }
                }
            }
            if (mtfModule && typeof mtfModule.getTimeframe === 'function') {
                const row1m = mtfModule.getTimeframe('1');
                if (row1m && row1m.state) mtfState = row1m.state;
            }
        } catch (e) {
            return; // 忽略单次读取失败
        }

        // --- B. 状态机时序流转 ---
        // 1. RSI 曾超卖
        if (rsi !== null && rsi < config.rsiThreshold) botSignalState.rsiHitTime = now;
        if (now - botSignalState.rsiHitTime > windowMs) {
            botSignalState.rsiHitTime = 0;
            botSignalState.macdHitTime = 0;
        }

        // 2. MACD 曾金叉
        if (botSignalState.rsiHitTime > 0 && macdState === '金叉') botSignalState.macdHitTime = now;

        // 3. 判断大周期环境是否就绪
        let ready = config.requireMacd ? (botSignalState.rsiHitTime > 0 && botSignalState.macdHitTime > 0) : (botSignalState.rsiHitTime > 0);
        
        // --- C. 微观扳机扣动 (真实买入) ---
        if (ready && (now - botSignalState.lastDcaTime > 15 * 60 * 1000)) { // 15分钟冷却防抖
            let triggerMtfFired = config.triggerMtf && mtfState && mtfState.includes('强多');
            let triggerDeltaFired = config.triggerDelta && (currentMinuteDelta > 0 && Math.abs(deltaUsdt) > config.deltaThreshold);

            if (triggerMtfFired || triggerDeltaFired) {
                botSignalState.isExecuting = true;
                try {
                    const logMsg = `[AutoBot] 触发加仓! (MTF:${triggerMtfFired}, Delta:${triggerDeltaFired})`;
                    console.log(logMsg);
                    
                    // 根据模式发送请求
                    let executedQty = 0;
                    let cumQuote = 0;
                    
                    if (config.tradeMode === 'futures') {
                        // 设置杠杆
                        await setFuturesLeverage(config.leverage || 100);
                        
                        // 计算合约开仓数量: (可用余额 * 仓位占比% * 杠杆) / 现价
                        const marginToUse = state.futuresBalanceUsdt * ((config.positionSizePct || 3.0) / 100);
                        const notionalSize = marginToUse * (config.leverage || 100);
                        let qtyToBuy = notionalSize / currentPrice;
                        
                        // 向下取整到 3 位小数 (BTCUSDT U本位合约 lotSize: 0.001)
                        qtyToBuy = Math.floor(qtyToBuy * 1000) / 1000;
                        
                        if (qtyToBuy < 0.001) throw new Error(`仓位太小, 计算数量: ${qtyToBuy} BTC, 最小需 0.001 BTC`);
                        
                        const res = await executeFuturesOrder('BUY', qtyToBuy);
                        executedQty = parseFloat(res.executedQty || qtyToBuy);
                        // 合约接口返回的是 cumQuoteQty 可能为空或0, 估算一下
                        cumQuote = res.cumQuoteQty ? parseFloat(res.cumQuoteQty) : executedQty * currentPrice;
                    } else {
                        // 现货模式
                        const res = await executeRealOrder('BUY', null, config.dcaAmount);
                        executedQty = parseFloat(res.executedQty);
                        cumQuote = parseFloat(res.cummulativeQuoteQty);
                    }
                    
                    // 防止分母为 0
                    const avgP = executedQty > 0 ? (cumQuote / executedQty) : currentPrice;

                    state.activeDcaCount++;
                    state.totalUsdtAmount += cumQuote;
                    state.totalCoinAmount += executedQty;
                    state.averagePrice = state.totalUsdtAmount / state.totalCoinAmount;
                    
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实买入: ${cumQuote.toFixed(2)} USDT @ ${avgP.toFixed(2)}`);
                    
                    botSignalState.lastDcaTime = now;
                    botSignalState.rsiHitTime = 0; // 消耗掉大周期信号，需要重新孕育
                    botSignalState.macdHitTime = 0;
                } catch (e) {
                    const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
                    console.error('[SpotAutoBot] BUY Error:', errorMsg);
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实买入失败: ${errorMsg}`);
                } finally {
                    botSignalState.isExecuting = false;
                }
            }
        }
        
        // --- D. 真实止盈/止损抛售 (TP / SL) ---
        if (state.totalCoinAmount > 0 && state.averagePrice > 0) {
            const avgP = state.averagePrice;
            const tp1Price = state.customTp1Price || (avgP * (1 + (config.tp1Target || 1.5) / 100));
            const tp2Price = state.customTp2Price || (avgP * (1 + (config.tp2Target || 3.0) / 100));
            const tp3Price = state.customTp3Price || (avgP * (1 + (config.tp3Target || 5.0) / 100));
            
            // 根据模式处理精度
            const floorVol = (vol) => {
                if (config.tradeMode === 'futures') {
                    return Math.floor(vol * 1000) / 1000; // 合约 lotSize: 0.001
                } else {
                    return Math.floor(vol * 100000) / 100000; // 现货 lotSize: 0.00001
                }
            };
            
            // 辅助函数: 卖出特定数量，并更新状态
            const executeSell = async (sellQty, label) => {
                if (sellQty <= 0) return false;
                botSignalState.isExecuting = true;
                try {
                    let cumQuote = 0;
                    if (config.tradeMode === 'futures') {
                        const res = await executeFuturesOrder('SELL', sellQty);
                        cumQuote = res.cumQuoteQty ? parseFloat(res.cumQuoteQty) : sellQty * currentPrice;
                    } else {
                        const res = await executeRealOrder('SELL', sellQty, null);
                        cumQuote = parseFloat(res.cummulativeQuoteQty);
                    }
                    
                    state.totalCoinAmount -= sellQty;
                    state.totalUsdtAmount -= sellQty * avgP;
                    if (state.totalCoinAmount < 0.00001) { // 极小残留视为清仓
                        state.totalCoinAmount = 0;
                        state.totalUsdtAmount = 0;
                        state.averagePrice = 0;
                        state.activeDcaCount = 0;
                    } else {
                        state.averagePrice = state.totalUsdtAmount / state.totalCoinAmount;
                    }
                    
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${label}卖出: ${sellQty} BTC (获 ${cumQuote.toFixed(2)})`);
                    return true;
                } catch (e) {
                    const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
                    console.error(`[SpotAutoBot] ${label} Error:`, errorMsg);
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${label}失败: ${errorMsg}`);
                    return false;
                } finally {
                    botSignalState.isExecuting = false;
                }
            };

            // TP1
            if (!state.tp1Fired && currentPrice >= tp1Price && !botSignalState.isExecuting) {
                const sellQty = floorVol(state.totalCoinAmount * (config.tp1 / 100));
                if (await executeSell(sellQty, 'TP1')) state.tp1Fired = true;
            }
            // TP2
            else if (state.tp1Fired && !state.tp2Fired && currentPrice >= tp2Price && !botSignalState.isExecuting) {
                // 因为 TP1 已经扣减了 totalCoinAmount，剩余仓位的对应比例需要重新计算。
                // 默认 50/30/20 策略，打掉 50 后，剩 50。TP2 应该占原始的 30%，也就是当前剩下的 60% (30/50)。
                const remainingRatio = config.tp2 / (config.tp2 + config.tp3);
                const sellQty = floorVol(state.totalCoinAmount * remainingRatio);
                if (await executeSell(sellQty, 'TP2')) state.tp2Fired = true;
            }
            // TP3
            else if (state.tp2Fired && !state.tp3Fired && currentPrice >= tp3Price && !botSignalState.isExecuting) {
                const sellQty = floorVol(state.totalCoinAmount); // 全抛
                if (await executeSell(sellQty, 'TP3')) {
                    state.tp3Fired = true;
                    // 清仓重置标记
                    state.tp1Fired = false; state.tp2Fired = false; state.tp3Fired = false;
                }
            }
            // 保本止损 SL (仅在 TP1 触发后激活，跌破均价抛售剩余全部)
            else if (state.tp1Fired && config.breakevenSl && currentPrice <= avgP && !botSignalState.isExecuting) {
                const sellQty = floorVol(state.totalCoinAmount);
                if (await executeSell(sellQty, '保本止损')) {
                    state.tp1Fired = false; state.tp2Fired = false; state.tp3Fired = false;
                }
            }
        }
        
        if (state.logs.length > 20) state.logs.length = 20;

    }, 2000);
}

module.exports = { startBotLoop, executeRealOrder };