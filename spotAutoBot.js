const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const { httpAgent, httpsAgent } = require('./lib/httpAgents');
const regimeModule = require('./regimeModule');
const mtfModule = require('./mtfModule');

// 币安现货 API 密钥 (初始从环境变量读取)
let SPOT_API_KEY = (process.env.BINANCE_SPOT_API_KEY || process.env.BINANCE_API_KEY || '').trim();
let SPOT_API_SECRET = (process.env.BINANCE_SPOT_API_SECRET || process.env.BINANCE_API_SECRET || '').trim();

function setApiKeys(key, secret) {
    if (key) SPOT_API_KEY = key;
    if (secret) SPOT_API_SECRET = secret;
}

let currentPrice = 0;
let currentMinuteDelta = 0;
let lastMinuteStamp = 0;
let deltaUsdt = 0;

let botSignalState = {
    longRsiHitTime: 0,
    longMacdHitTime: 0,
    shortRsiHitTime: 0,
    shortMacdHitTime: 0,
    lastDcaTime: 0,
    isExecuting: false
};

// 全局指标状态追踪（用于严格判断“再次出现”的交叉事件）
let globalMacdState = null;
let globalMacdGoldenCrossTime = 0;
let globalMacdDeathCrossTime = 0;

let globalRsiState = null; // 'oversold', 'overbought', 'normal'
let globalRsiOversoldTime = 0;
let globalRsiOverboughtTime = 0;

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

async function executeFuturesOrder(side, quantity, positionSide = '') {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) throw new Error('Missing API Keys in .env');
    const timestamp = Date.now();
    let queryString = `symbol=BTCUSDT&side=${side}&type=MARKET&recvWindow=60000&timestamp=${timestamp}`;
    if (quantity) queryString += `&quantity=${quantity}`;
    if (positionSide) queryString += `&positionSide=${positionSide}`;

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
        
        if (!state.isLongBotRunning && !state.isShortBotRunning) return;
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

        // --- A2. 全局状态追踪 (严格判断“再次出现”) ---
        if (macdState) {
            if (globalMacdState === null) {
                globalMacdState = macdState;
                if (macdState === '金叉') globalMacdGoldenCrossTime = now;
                if (macdState === '死叉') globalMacdDeathCrossTime = now;
            } else if (macdState !== globalMacdState) {
                globalMacdState = macdState;
                if (macdState === '金叉') globalMacdGoldenCrossTime = now;
                if (macdState === '死叉') globalMacdDeathCrossTime = now;
            }
        }

        let currentRsiState = 'normal';
        if (rsi !== null) {
            if (rsi < config.rsiThreshold) currentRsiState = 'oversold';
            else if (rsi > (config.rsiOverboughtThreshold || 70)) currentRsiState = 'overbought';

            if (globalRsiState === null) {
                globalRsiState = currentRsiState;
                if (currentRsiState === 'oversold') globalRsiOversoldTime = now;
                if (currentRsiState === 'overbought') globalRsiOverboughtTime = now;
            } else if (currentRsiState !== globalRsiState) {
                globalRsiState = currentRsiState;
                if (currentRsiState === 'oversold') globalRsiOversoldTime = now;
                if (currentRsiState === 'overbought') globalRsiOverboughtTime = now;
            }
        }

        // --- B. 状态机时序流转 ---
        
        // 如果有持仓，只允许当前方向的加仓；如果是空仓，允许配置中开启的方向
        const canLong = state.isLongBotRunning && (state.positionSide === 'long' || state.positionSide === null);
        const canShort = (config.tradeMode === 'futures') && state.isShortBotRunning && (state.positionSide === 'short' || state.positionSide === null);

        // 1. RSI 曾超卖(做多) / 曾超买(做空) (必须是上次开仓之后新产生的穿越！)
        if (rsi !== null) {
            if (canLong && currentRsiState === 'oversold' && globalRsiOversoldTime > botSignalState.lastDcaTime) {
                botSignalState.longRsiHitTime = now;
            }
            if (canShort && currentRsiState === 'overbought' && globalRsiOverboughtTime > botSignalState.lastDcaTime) {
                botSignalState.shortRsiHitTime = now;
            }
        }

        // 2. MACD 曾金叉(做多) / 曾死叉(做空) (独立判断，必须是上次开仓之后新产生的金叉/死叉！)
        if (macdState !== null) {
            if (canLong && macdState === '金叉' && globalMacdGoldenCrossTime > botSignalState.lastDcaTime) {
                botSignalState.longMacdHitTime = now;
            }
            if (canShort && macdState === '死叉' && globalMacdDeathCrossTime > botSignalState.lastDcaTime) {
                botSignalState.shortMacdHitTime = now;
            }
        }

        // 独立过期检测 (防抖窗口期)
        if (now - botSignalState.longRsiHitTime > windowMs) botSignalState.longRsiHitTime = 0;
        if (now - botSignalState.longMacdHitTime > windowMs) botSignalState.longMacdHitTime = 0;
        
        if (now - botSignalState.shortRsiHitTime > windowMs) botSignalState.shortRsiHitTime = 0;
        if (now - botSignalState.shortMacdHitTime > windowMs) botSignalState.shortMacdHitTime = 0;

        // 3. 判断大周期环境是否就绪 (严格的 AND 关系: RSI 和 MACD 都必须满足)
        let longReady = canLong && (botSignalState.longRsiHitTime > 0 && botSignalState.longMacdHitTime > 0);
        let shortReady = canShort && (botSignalState.shortRsiHitTime > 0 && botSignalState.shortMacdHitTime > 0);
        
        // --- C. 微观扳机扣动 (真实买入/做空) ---
        if ((longReady || shortReady) && (now - botSignalState.lastDcaTime > 15 * 60 * 1000)) { // 15分钟冷却防抖
            
            let triggerMtfLong = config.triggerMtf && mtfState && mtfState.includes('强多');
            let triggerDeltaLong = config.triggerDelta && (currentMinuteDelta > 0 && Math.abs(deltaUsdt) > config.deltaThreshold);
            
            // 为了兼顾您可能还要用 Delta 的配置，我们要求 MTF 是必选项（或者至少是当前的主要要求）
            // 按照您的诉求：“并且1分钟MTF强多/强空”
            let isExecutingLong = longReady && triggerMtfLong;

            let triggerMtfShort = config.triggerMtf && mtfState && mtfState.includes('强空');
            let triggerDeltaShort = config.triggerDelta && (currentMinuteDelta < 0 && Math.abs(deltaUsdt) > config.deltaThreshold);
            let isExecutingShort = shortReady && triggerMtfShort;
            
            // 极小概率多空同时满足时，顺延当前仓位方向，否则偏好做多
            if (isExecutingLong && isExecutingShort) {
                if (state.positionSide === 'short') isExecutingLong = false;
                else isExecutingShort = false;
            }

            if (isExecutingLong || isExecutingShort) {
                const maxSteps = config.dcaMaxSteps || 5;
                const isLongTrade = isExecutingLong;
                
                if (state.activeDcaCount >= maxSteps) {
                    botSignalState.lastDcaTime = now;
                    if (isLongTrade) {
                        botSignalState.longRsiHitTime = 0; botSignalState.longMacdHitTime = 0;
                    } else {
                        botSignalState.shortRsiHitTime = 0; botSignalState.shortMacdHitTime = 0;
                    }
                    console.log(`[AutoBot] 已达到最大 DCA 次数 (${maxSteps})，本次信号被忽略`);
                    return;
                }

                botSignalState.isExecuting = true;
                try {
                    const actionLabel = isLongTrade ? '买入(做多)' : '卖出(做空)';
                    const triggerMtfFired = isLongTrade ? triggerMtfLong : triggerMtfShort;
                    const triggerDeltaFired = isLongTrade ? triggerDeltaLong : triggerDeltaShort;
                    const logMsg = `[AutoBot] 触发${actionLabel}! (MTF:${triggerMtfFired}, Delta:${triggerDeltaFired}) - 第 ${state.activeDcaCount + 1} 仓`;
                    console.log(logMsg);
                    
                    // 根据模式发送请求
                    let executedQty = 0;
                    let cumQuote = 0;
                    
                    // 智能分配乘数
                    const multiplier = config.martingaleMultiplier || 1.0;
                    
                    if (config.tradeMode === 'futures') {
                        // 设置杠杆
                        await setFuturesLeverage(config.leverage || 100);
                        
                        // 换算成总名义价值池: (当前U本位总余额 * 占比%) * 杠杆
                        // 例如 4200U * 3% = 126U (真实最大亏损); 126U * 100倍 = 12600U 名义价值
                        const totalMarginToUse = state.futuresBalanceUsdt * ((config.positionSizePct || 3.0) / 100);
                        const totalNotionalSize = totalMarginToUse * (config.leverage || 100);
                        
                        // 基于马丁格尔策略智能分配首仓**名义价值**
                        let baseNotional = 0;
                        if (multiplier === 1) {
                            baseNotional = totalNotionalSize / maxSteps;
                        } else {
                            baseNotional = totalNotionalSize * (1 - multiplier) / (1 - Math.pow(multiplier, maxSteps));
                        }
                        
                        // 当前阶梯应下名义价值
                        const currentStepNotional = baseNotional * Math.pow(multiplier, state.activeDcaCount);
                        let qtyToBuy = currentStepNotional / currentPrice;
                        
                        // 向下取整到 3 位小数 (BTCUSDT U本位合约 lotSize: 0.001)
                        qtyToBuy = Math.floor(qtyToBuy * 1000) / 1000;
                        
                        if (qtyToBuy < 0.001) throw new Error(`仓位太小, 计算数量: ${qtyToBuy} BTC, 最小需 0.001 BTC`);
                        
                        const side = isLongTrade ? 'BUY' : 'SELL';
                        const posSide = isLongTrade ? 'LONG' : 'SHORT';
                        const res = await executeFuturesOrder(side, qtyToBuy, posSide);
                        executedQty = parseFloat(res.executedQty) || qtyToBuy;
                        // 合约接口返回的是 cumQuoteQty 可能为空或0, 估算一下
                        cumQuote = (res.cumQuoteQty && parseFloat(res.cumQuoteQty) > 0) ? parseFloat(res.cumQuoteQty) : (executedQty * currentPrice);
                    } else {
                        if (!isLongTrade) throw new Error('现货模式不支持做空!');
                        // 现货模式: 首仓直接取配置金额，后续乘马丁格尔
                        const currentStepUsdt = config.dcaAmount * Math.pow(multiplier, state.activeDcaCount);
                        const res = await executeRealOrder('BUY', null, currentStepUsdt);
                        executedQty = parseFloat(res.executedQty);
                        cumQuote = parseFloat(res.cummulativeQuoteQty);
                    }
                    
                    // 防止分母为 0
                    const avgP = executedQty > 0 ? (cumQuote / executedQty) : currentPrice;

                    // 设置持仓方向 (首仓时)
                    if (state.totalCoinAmount < 0.00001) {
                        state.positionSide = isLongTrade ? 'long' : 'short';
                        state.entryTime = Date.now();
                        state.totalFees = 0;
                    }

                    state.activeDcaCount++;
                    state.totalUsdtAmount += cumQuote;
                    state.totalCoinAmount += executedQty;
                    
                    const isLong = state.positionSide !== 'short';
                    const adjUsdt = isLong ? (state.totalUsdtAmount + (state.totalFees || 0)) : (state.totalUsdtAmount - (state.totalFees || 0));
                    state.averagePrice = state.totalCoinAmount > 0 ? (adjUsdt / state.totalCoinAmount) : 0;
                    
                    try {
                        const regimeState = regimeModule.getState();
                        if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                            const atrArr = regimeState.indicators.atr;
                            state.lockedAtr = atrArr[atrArr.length - 1];
                        }
                    } catch(e){}
                    
                    // 加仓后重置止盈状态和自定义价格，以便按新均价重新计算
                    state.tp1Fired = false;
                    state.tp2Fired = false;
                    state.tp3Fired = false;
                    state.customTp1Price = null;
                    state.customTp2Price = null;
                    state.customTp3Price = null;
                    
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${actionLabel}: ${cumQuote.toFixed(2)} USDT @ ${avgP.toFixed(2)}`);
                    
                    botSignalState.lastDcaTime = now;
                    if (isLongTrade) {
                        botSignalState.longRsiHitTime = 0; botSignalState.longMacdHitTime = 0;
                    } else {
                        botSignalState.shortRsiHitTime = 0; botSignalState.shortMacdHitTime = 0;
                    }
                } catch (e) {
                    const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
                    console.error('[SpotAutoBot] Action Error:', errorMsg);
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实操作失败: ${errorMsg}`);
                } finally {
                    botSignalState.isExecuting = false;
                }
            }
        }
        
        // --- D. 真实止盈/止损抛售 (TP / SL) ---
        if (state.totalCoinAmount > 0 && state.averagePrice > 0) {
            const avgP = state.averagePrice;
            const isLong = state.positionSide !== 'short'; // 默认视为多头
            
            let atrValue = 0;
            if (config.tpMode && config.tpMode.startsWith('atr')) {
                try {
                    const regimeState = regimeModule.getState();
                    if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                        const atrArr = regimeState.indicators.atr;
                        atrValue = atrArr[atrArr.length - 1];
                    }
                } catch (e) {}
            }
            
            let activeAtr = 0;
            if (config.tpMode === 'atr_static') {
                if (!state.lockedAtr && atrValue > 0) state.lockedAtr = atrValue;
                activeAtr = state.lockedAtr > 0 ? state.lockedAtr : atrValue;
            } else if (config.tpMode === 'atr_dynamic') {
                activeAtr = atrValue;
            }
            
            const tp1Target = config.tp1Target || 1.0;
            const tp2Target = config.tp2Target || 3.0;
            const tp3Target = config.tp3Target || 5.0;
            
            let tp1Price, tp2Price, tp3Price;
            if (isLong) {
                if (config.tpMode && config.tpMode.startsWith('atr') && activeAtr > 0) {
                    tp1Price = state.customTp1Price || (avgP + activeAtr * tp1Target);
                    tp2Price = state.customTp2Price || (avgP + activeAtr * tp2Target);
                    tp3Price = state.customTp3Price || (avgP + activeAtr * tp3Target);
                } else {
                    tp1Price = state.customTp1Price || (avgP * (1 + tp1Target / 100));
                    tp2Price = state.customTp2Price || (avgP * (1 + tp2Target / 100));
                    tp3Price = state.customTp3Price || (avgP * (1 + tp3Target / 100));
                }
            } else {
                // 做空止盈：价格下跌
                if (config.tpMode && config.tpMode.startsWith('atr') && activeAtr > 0) {
                    tp1Price = state.customTp1Price || (avgP - activeAtr * tp1Target);
                    tp2Price = state.customTp2Price || (avgP - activeAtr * tp2Target);
                    tp3Price = state.customTp3Price || (avgP - activeAtr * tp3Target);
                } else {
                    tp1Price = state.customTp1Price || (avgP * (1 - tp1Target / 100));
                    tp2Price = state.customTp2Price || (avgP * (1 - tp2Target / 100));
                    tp3Price = state.customTp3Price || (avgP * (1 - tp3Target / 100));
                }
            }
            
            // 根据模式处理精度
            const floorVol = (vol) => {
                if (config.tradeMode === 'futures') {
                    return Math.floor(vol * 1000) / 1000; // 合约 lotSize: 0.001
                } else {
                    return Math.floor(vol * 100000) / 100000; // 现货 lotSize: 0.00001
                }
            };
            
            // 辅助函数: 卖出特定数量，并更新状态
            const executeClose = async (closeQty, label) => {
                if (closeQty <= 0) return false;
                botSignalState.isExecuting = true;
                try {
                    let cumQuote = 0;
                    if (config.tradeMode === 'futures') {
                        const side = isLong ? 'SELL' : 'BUY';
                        const posSide = isLong ? 'LONG' : 'SHORT';
                        const res = await executeFuturesOrder(side, closeQty, posSide);
                        cumQuote = (res.cumQuoteQty && parseFloat(res.cumQuoteQty) > 0) ? parseFloat(res.cumQuoteQty) : (closeQty * currentPrice);
                    } else {
                        const res = await executeRealOrder('SELL', closeQty, null);
                        cumQuote = parseFloat(res.cummulativeQuoteQty);
                    }
                    
                    state.totalCoinAmount -= closeQty;
                    state.totalUsdtAmount -= closeQty * avgP;
                    if (state.totalCoinAmount < 0.00001) { // 极小残留视为清仓
                        state.totalCoinAmount = 0;
                        state.totalUsdtAmount = 0;
                        state.averagePrice = 0;
                        state.activeDcaCount = 0;
                        state.entryTime = null;
                        state.totalFees = 0;
                    } else {
                        const isLong = state.positionSide !== 'short';
                        const adjUsdt = isLong ? (state.totalUsdtAmount + (state.totalFees || 0)) : (state.totalUsdtAmount - (state.totalFees || 0));
                        state.averagePrice = adjUsdt / state.totalCoinAmount;
                    }
                    
                    const actionName = isLong ? '卖出平多' : '买入平空';
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${label} ${actionName}: ${closeQty} BTC (获 ${cumQuote.toFixed(2)})`);
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

            // 计算触发条件
            const hitTp1 = isLong ? (currentPrice >= tp1Price) : (currentPrice <= tp1Price);
            const hitTp2 = isLong ? (currentPrice >= tp2Price) : (currentPrice <= tp2Price);
            const hitTp3 = isLong ? (currentPrice >= tp3Price) : (currentPrice <= tp3Price);
            const hitSl = isLong ? (currentPrice <= avgP) : (currentPrice >= avgP);

            // TP1
            if (!state.tp1Fired && hitTp1 && !botSignalState.isExecuting) {
                const closeQty = floorVol(state.totalCoinAmount * (config.tp1 / 100));
                if (await executeClose(closeQty, 'TP1')) state.tp1Fired = true;
            }
            // TP2
            else if (state.tp1Fired && !state.tp2Fired && hitTp2 && !botSignalState.isExecuting) {
                const remainingRatio = config.tp2 / (config.tp2 + config.tp3);
                const closeQty = floorVol(state.totalCoinAmount * remainingRatio);
                if (await executeClose(closeQty, 'TP2')) state.tp2Fired = true;
            }
            // TP3
            else if (state.tp2Fired && !state.tp3Fired && hitTp3 && !botSignalState.isExecuting) {
                const closeQty = floorVol(state.totalCoinAmount); // 全抛
                if (await executeClose(closeQty, 'TP3')) {
                    state.tp3Fired = true;
                    // 清仓重置标记
                    state.tp1Fired = false; state.tp2Fired = false; state.tp3Fired = false;
                }
            }
            // 保本止损 SL (仅在 TP1 触发后激活)
            else if (state.tp1Fired && config.breakevenSl && hitSl && !botSignalState.isExecuting) {
                const closeQty = floorVol(state.totalCoinAmount);
                if (await executeClose(closeQty, '保本止损')) {
                    state.tp1Fired = false; state.tp2Fired = false; state.tp3Fired = false;
                }
            }
        }
        
        if (state.logs.length > 20) state.logs.length = 20;

    }, 2000);
}

module.exports = { startBotLoop, executeRealOrder, executeFuturesOrder, setApiKeys };