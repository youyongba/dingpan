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
const globalVolumeProfile = new Map();

let botSignalState = {
    longRsiHitTime: 0,
    longMacdHitTime: 0,
    shortRsiHitTime: 0,
    shortMacdHitTime: 0,
    lastDcaTimeLong: 0,
    lastDcaTimeShort: 0,
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
    const ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade');
    ws.on('open', () => console.log('[SpotAutoBot] WS Connected for Backend Delta tracking'));
    ws.on('message', (data) => {
        try {
            const rawData = JSON.parse(data);
            const parsed = rawData.data || rawData; // 兼容多路复用格式
            
            if (!parsed.p || !parsed.q) return; // 忽略没有价格和数量的数据包，防止 NaN 污染

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
            
            const newDelta = currentMinuteDelta * currentPrice;
            if (Number.isFinite(newDelta)) {
                deltaUsdt = newDelta;
            }

            const tickSize = 10;
            const level = Math.floor(price / tickSize) * tickSize;
            if (!globalVolumeProfile.has(level)) {
                globalVolumeProfile.set(level, { buy: 0, sell: 0 });
            }
            let pData = globalVolumeProfile.get(level);
            if (isSell) pData.sell += qty;
            else pData.buy += qty;
            
            // 限制内存，防止 Map 无限增长
            if (globalVolumeProfile.size > 2000) {
                const keys = Array.from(globalVolumeProfile.keys());
                for (let i = 0; i < 500; i++) {
                    globalVolumeProfile.delete(keys[i]);
                }
            }

        } catch (e) {}
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
        const windowMs = (config.signalWindow || 12) * 60 * 60 * 1000; // 12小时信号窗口

        // --- A. 获取宏观指标状态 ---
        let rsi = null, macdState = null, mtfState = null;
        try {
            if (regimeModule && typeof regimeModule.getState === 'function') {
                const regimeState = regimeModule.getState();
                if (regimeState && regimeState.indicators) {
                    const ind = regimeState.indicators;
                    // 强制使用 length - 2 获取上一根“已收盘”的 1h K线状态，过滤盘中未收线时的假穿越/假超买超卖
                    if (ind.rsi && ind.rsi.length > 1) rsi = ind.rsi[ind.rsi.length - 2];
                    if (ind.macd && ind.signal && ind.macd.length > 1) {
                        macdState = ind.macd[ind.macd.length - 2] > ind.signal[ind.signal.length - 2] ? '金叉' : '死叉';
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

        // --- A2. 全局状态追踪 (后台持续运行，即使机器人暂停也记录跨越动作) ---
        if (macdState) {
            if (globalMacdState === null) {
                globalMacdState = macdState;
                // 修复：如果启动时就已经处于金叉/死叉状态，必须承认当前状态，否则重启服务器会导致丢失正在发生的宏观信号
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
                // 修复：如果启动时就已经处于超卖/超买状态，必须承认当前状态
                if (currentRsiState === 'oversold') globalRsiOversoldTime = now;
                if (currentRsiState === 'overbought') globalRsiOverboughtTime = now;
            } else if (currentRsiState !== globalRsiState) {
                // 只有在运行期间真实发生状态跨越（比如从 normal 变成 overbought），才记录时间戳
                globalRsiState = currentRsiState;
                if (currentRsiState === 'oversold') globalRsiOversoldTime = now;
                if (currentRsiState === 'overbought') globalRsiOverboughtTime = now;
            }
        }

        // --- B. 状态机时序流转 (双向并行处理) ---
        if (!state.isLongBotRunning && !state.isShortBotRunning) return;
        if (botSignalState.isExecuting) return;

        const processDirection = async (isLongTrade, targetState, isBotRunning) => {
            if (!isBotRunning) return;
            
            const lastDcaTime = isLongTrade ? botSignalState.lastDcaTimeLong : botSignalState.lastDcaTimeShort;
            
            // 1. 15m已收盘 RSI 曾超卖(做多) / 曾超买(做空) (必须是上次开仓之后新产生的穿越！)
            if (rsi !== null) {
                if (isLongTrade && currentRsiState === 'oversold' && globalRsiOversoldTime > lastDcaTime) {
                    botSignalState.longRsiHitTime = globalRsiOversoldTime;
                }
                if (!isLongTrade && currentRsiState === 'overbought' && globalRsiOverboughtTime > lastDcaTime) {
                    botSignalState.shortRsiHitTime = globalRsiOverboughtTime;
                }
            }

            // 2. 15m已收盘 MACD 曾金叉(做多) / 曾死叉(做空)
            if (macdState !== null) {
                if (isLongTrade && macdState === '金叉' && globalMacdGoldenCrossTime > lastDcaTime) {
                    botSignalState.longMacdHitTime = globalMacdGoldenCrossTime;
                }
                if (!isLongTrade && macdState === '死叉' && globalMacdDeathCrossTime > lastDcaTime) {
                    botSignalState.shortMacdHitTime = globalMacdDeathCrossTime;
                }
            }

            // 独立过期检测 (恢复合理的 3 小时防抖窗口期，解决指标滞后开不了仓的问题)
            if (isLongTrade) {
                if (now - botSignalState.longRsiHitTime > windowMs) botSignalState.longRsiHitTime = 0;
                if (now - botSignalState.longMacdHitTime > windowMs) botSignalState.longMacdHitTime = 0;
            } else {
                if (now - botSignalState.shortRsiHitTime > windowMs) botSignalState.shortRsiHitTime = 0;
                if (now - botSignalState.shortMacdHitTime > windowMs) botSignalState.shortMacdHitTime = 0;
            }

            // 3. 判断大周期环境是否就绪
            let isReady = false;
            if (isLongTrade) {
                isReady = botSignalState.longRsiHitTime > 0;
                if (config.requireMacd) isReady = isReady && (botSignalState.longMacdHitTime > 0);
            } else {
                isReady = botSignalState.shortRsiHitTime > 0;
                if (config.requireMacd) isReady = isReady && (botSignalState.shortMacdHitTime > 0);
            }
                
            // --- C. 微观扳机扣动 (真实买入/做空) ---
            if (isReady && (now - lastDcaTime > 60 * 60 * 1000)) { // 1小时冷却防抖
                let triggerMtf = true;
                if (config.triggerMtf) {
                    triggerMtf = isLongTrade 
                        ? (mtfState && mtfState.includes('强多'))
                        : (mtfState && mtfState.includes('强空'));
                }
                    
                let triggerDelta = true;
                if (config.triggerDelta) {
                    triggerDelta = isLongTrade
                        ? (currentMinuteDelta > 0 && Math.abs(deltaUsdt) > (config.deltaThreshold || 2500000))
                        : (currentMinuteDelta < 0 && Math.abs(deltaUsdt) > (config.deltaThreshold || 2500000));
                }
                    
                let isExecuting = isReady && triggerMtf && triggerDelta;

                if (isExecuting) {
                    const maxSteps = config.dcaMaxSteps || 5;
                    
                    if (targetState.activeDcaCount >= maxSteps) {
                        if (isLongTrade) {
                            botSignalState.lastDcaTimeLong = now;
                            botSignalState.longRsiHitTime = 0; botSignalState.longMacdHitTime = 0;
                            // globalRsiOversoldTime = 0; globalMacdGoldenCrossTime = 0; // 不清空全局状态，防止刚清空又被下一秒重新赋上
                        } else {
                            botSignalState.lastDcaTimeShort = now;
                            botSignalState.shortRsiHitTime = 0; botSignalState.shortMacdHitTime = 0;
                            // globalRsiOverboughtTime = 0; globalMacdDeathCrossTime = 0; // 不清空全局状态
                        }
                        console.log(`[AutoBot] 已达到最大 DCA 次数 (${maxSteps})，本次信号被忽略`);
                        return;
                    }

                    botSignalState.isExecuting = true;
                    try {
                        // 防 NaN 校验：确保 currentPrice 合法
                        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
                            throw new Error(`当前价格非法: ${currentPrice}`);
                        }

                        const actionLabel = isLongTrade ? '买入(做多)' : '卖出(做空)';
                        const logMsg = `[AutoBot] 触发${actionLabel}! (MTF:${triggerMtf}, Delta:${triggerDelta}) - 第 ${targetState.activeDcaCount + 1} 仓`;
                        console.log(logMsg);
                        
                        let executedQty = 0;
                        let cumQuote = 0;
                        const multiplier = config.martingaleMultiplier || 1.0;
                        
                        if (config.tradeMode === 'futures') {
                            await setFuturesLeverage(config.leverage || 100);
                            const totalMarginToUse = state.futuresBalanceUsdt * ((config.positionSizePct || 3.0) / 100);
                            const totalNotionalSize = totalMarginToUse * (config.leverage || 100);
                            
                            let baseNotional = 0;
                            if (multiplier === 1) {
                                baseNotional = totalNotionalSize / maxSteps;
                            } else {
                                baseNotional = totalNotionalSize * (1 - multiplier) / (1 - Math.pow(multiplier, maxSteps));
                            }
                            
                            const currentStepNotional = baseNotional * Math.pow(multiplier, targetState.activeDcaCount);
                            let qtyToBuy = currentStepNotional / currentPrice;
                            qtyToBuy = Math.floor(qtyToBuy * 1000) / 1000;
                            if (qtyToBuy < 0.001) throw new Error(`仓位太小: ${qtyToBuy} BTC`);
                            
                            const side = isLongTrade ? 'BUY' : 'SELL';
                            const posSide = isLongTrade ? 'LONG' : 'SHORT';
                            const res = await executeFuturesOrder(side, qtyToBuy, posSide);
                            executedQty = parseFloat(res.executedQty) || qtyToBuy;
                            cumQuote = (res.cumQuoteQty && parseFloat(res.cumQuoteQty) > 0) ? parseFloat(res.cumQuoteQty) : (executedQty * currentPrice);
                        } else {
                            if (!isLongTrade) throw new Error('现货模式不支持做空!');
                            const currentStepUsdt = config.dcaAmount * Math.pow(multiplier, targetState.activeDcaCount);
                            const res = await executeRealOrder('BUY', null, currentStepUsdt);
                            executedQty = parseFloat(res.executedQty);
                            cumQuote = parseFloat(res.cummulativeQuoteQty);
                        }
                        
                        const avgP = executedQty > 0 ? (cumQuote / executedQty) : currentPrice;

                        if (targetState.totalCoinAmount < 0.00001) {
                            targetState.entryTime = Date.now();
                            targetState.totalFees = 0;
                        }

                        targetState.activeDcaCount++;
                        targetState.totalUsdtAmount += cumQuote;
                        targetState.totalCoinAmount += executedQty;
                        
                        const adjUsdt = isLongTrade ? (targetState.totalUsdtAmount + (targetState.totalFees || 0)) : (targetState.totalUsdtAmount - (targetState.totalFees || 0));
                        targetState.averagePrice = targetState.totalCoinAmount > 0 ? (adjUsdt / targetState.totalCoinAmount) : 0;
                        
                        try {
                            const regimeState = regimeModule.getState();
                            if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                                const atrArr = regimeState.indicators.atr;
                                targetState.lockedAtr = atrArr[atrArr.length - 1];
                            }
                        } catch(e){}
                        
                        targetState.tp1Fired = false;
                        targetState.tp2Fired = false;
                        targetState.tp3Fired = false;
                        targetState.customTp1Price = null;
                        targetState.customTp2Price = null;
                        targetState.customTp3Price = null;
                        
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${actionLabel}: ${cumQuote.toFixed(2)} USDT @ ${avgP.toFixed(2)}`);
                        
                        if (isLongTrade) {
                            botSignalState.lastDcaTimeLong = now;
                            botSignalState.longRsiHitTime = 0; botSignalState.longMacdHitTime = 0;
                            // 暴力斩断：强行清空全局追踪记忆，必须等待下一次真正的跨越才能开启新一轮等待
                            globalRsiOversoldTime = 0;
                            globalMacdGoldenCrossTime = 0;
                        } else {
                            botSignalState.lastDcaTimeShort = now;
                            botSignalState.shortRsiHitTime = 0; botSignalState.shortMacdHitTime = 0;
                            // 暴力斩断：强行清空全局追踪记忆，必须等待下一次真正的跨越才能开启新一轮等待
                            globalRsiOverboughtTime = 0;
                            globalMacdDeathCrossTime = 0;
                        }
                         if (typeof onStateChangeCallback === 'function') onStateChangeCallback();
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
            if (targetState.totalCoinAmount > 0 && targetState.averagePrice > 0) {
                const avgP = targetState.averagePrice;
                
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
                    if (!targetState.lockedAtr && atrValue > 0) targetState.lockedAtr = atrValue;
                    activeAtr = targetState.lockedAtr > 0 ? targetState.lockedAtr : atrValue;
                } else if (config.tpMode === 'atr_dynamic') {
                    activeAtr = atrValue;
                }
                
                const tp1Target = config.tp1Target || 1.0;
                const tp2Target = config.tp2Target || 3.0;
                const tp3Target = config.tp3Target || 5.0;
                
                let tp1Price, tp2Price, tp3Price;
                if (isLongTrade) {
                    if (config.tpMode && config.tpMode.startsWith('atr') && activeAtr > 0) {
                        tp1Price = targetState.customTp1Price || (avgP + activeAtr * tp1Target);
                        tp2Price = targetState.customTp2Price || (avgP + activeAtr * tp2Target);
                        tp3Price = targetState.customTp3Price || (avgP + activeAtr * tp3Target);
                    } else {
                        tp1Price = targetState.customTp1Price || (avgP * (1 + tp1Target / 100));
                        tp2Price = targetState.customTp2Price || (avgP * (1 + tp2Target / 100));
                        tp3Price = targetState.customTp3Price || (avgP * (1 + tp3Target / 100));
                    }
                } else {
                    if (config.tpMode && config.tpMode.startsWith('atr') && activeAtr > 0) {
                        tp1Price = targetState.customTp1Price || (avgP - activeAtr * tp1Target);
                        tp2Price = targetState.customTp2Price || (avgP - activeAtr * tp2Target);
                        tp3Price = targetState.customTp3Price || (avgP - activeAtr * tp3Target);
                    } else {
                        tp1Price = targetState.customTp1Price || (avgP * (1 - tp1Target / 100));
                        tp2Price = targetState.customTp2Price || (avgP * (1 - tp2Target / 100));
                        tp3Price = targetState.customTp3Price || (avgP * (1 - tp3Target / 100));
                    }
                }
                
                const floorVol = (vol) => config.tradeMode === 'futures' ? Math.floor(vol * 1000) / 1000 : Math.floor(vol * 100000) / 100000;
                
                const executeClose = async (closeQty, label) => {
                    if (closeQty <= 0) return false;
                    botSignalState.isExecuting = true;
                    try {
                        let cumQuote = 0;
                        if (config.tradeMode === 'futures') {
                            const side = isLongTrade ? 'SELL' : 'BUY';
                            const posSide = isLongTrade ? 'LONG' : 'SHORT';
                            const res = await executeFuturesOrder(side, closeQty, posSide);
                            cumQuote = (res.cumQuoteQty && parseFloat(res.cumQuoteQty) > 0) ? parseFloat(res.cumQuoteQty) : (closeQty * currentPrice);
                        } else {
                            const res = await executeRealOrder('SELL', closeQty, null);
                            cumQuote = parseFloat(res.cummulativeQuoteQty);
                        }
                        
                        // 致命Bug修复：按比例扣除名义价值，防止部分止盈后均价崩溃
                        // 增加极其严苛的防 NaN 与防零除校验
                        const safeTotalCoin = Number.isFinite(targetState.totalCoinAmount) && targetState.totalCoinAmount > 0 
                                              ? targetState.totalCoinAmount : 1; // 避免除以 0
                        let reduceRatio = closeQty / safeTotalCoin;
                        if (!Number.isFinite(reduceRatio) || reduceRatio < 0) reduceRatio = 0;
                        if (reduceRatio > 1.05) reduceRatio = 1; // 卖出比例最多 100% (给浮点数留一点点精度容差)

                        const deductUsdt = targetState.totalUsdtAmount * reduceRatio;
                        if (Number.isFinite(deductUsdt)) {
                            targetState.totalUsdtAmount -= deductUsdt;
                        }
                        
                        targetState.totalCoinAmount -= closeQty;
                        if (targetState.totalCoinAmount < 0.00001) {
                            targetState.totalCoinAmount = 0;
                            targetState.totalUsdtAmount = 0;
                            targetState.averagePrice = 0;
                            targetState.activeDcaCount = 0;
                            targetState.entryTime = null;
                            targetState.totalFees = 0;
                        } else {
                            const adjUsdt = isLongTrade ? (targetState.totalUsdtAmount + (targetState.totalFees || 0)) : (targetState.totalUsdtAmount - (targetState.totalFees || 0));
                            const newAvgPrice = adjUsdt / targetState.totalCoinAmount;
                            // 最终兜底：如果算出来是 NaN，强行保持之前的均价不变，绝不污染内存
                            if (Number.isFinite(newAvgPrice) && newAvgPrice > 0) {
                                targetState.averagePrice = newAvgPrice;
                            }
                        }
                        
                        const actionName = isLongTrade ? '卖出平多' : '买入平空';
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${label} ${actionName}: ${closeQty} BTC (获 ${cumQuote.toFixed(2)})`);
                        if (onStateChangeCallback) onStateChangeCallback();
                        return true;
                    } catch (e) {
                        const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${label}失败: ${errorMsg}`);
                        return false;
                    } finally {
                        botSignalState.isExecuting = false;
                    }
                };

                const hitTp1 = currentPrice > 0 && (isLongTrade ? (currentPrice >= tp1Price) : (currentPrice <= tp1Price));
                const hitTp2 = currentPrice > 0 && (isLongTrade ? (currentPrice >= tp2Price) : (currentPrice <= tp2Price));
                const hitTp3 = currentPrice > 0 && (isLongTrade ? (currentPrice >= tp3Price) : (currentPrice <= tp3Price));
                
                // 保本止损容差 (滑点与手续费补偿): 0.05%
                const slBuffer = avgP * 0.0005; 
                const slTriggerPrice = isLongTrade ? (avgP + slBuffer) : (avgP - slBuffer);
                const hitSl = currentPrice > 0 && (isLongTrade ? (currentPrice <= slTriggerPrice) : (currentPrice >= slTriggerPrice));

                if (!targetState.tp1Fired && hitTp1 && !botSignalState.isExecuting) {
                    let closeQty = floorVol(targetState.totalCoinAmount * (config.tp1 / 100));
                    // 修复：如果分批后的数量小于交易所最小精度(如0.001)，则无法下单，改为全平
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    
                    if (await executeClose(closeQty, 'TP1')) {
                        if (targetState.totalCoinAmount > 0) targetState.tp1Fired = true;
                    }
                }
                else if (targetState.tp1Fired && !targetState.tp2Fired && hitTp2 && !botSignalState.isExecuting) {
                    const remainingRatio = config.tp2 / (config.tp2 + config.tp3);
                    let closeQty = floorVol(targetState.totalCoinAmount * remainingRatio);
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    
                    if (await executeClose(closeQty, 'TP2')) {
                        if (targetState.totalCoinAmount > 0) targetState.tp2Fired = true;
                    }
                }
                else if (targetState.tp2Fired && !targetState.tp3Fired && hitTp3 && !botSignalState.isExecuting) {
                    let closeQty = floorVol(targetState.totalCoinAmount);
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    
                    await executeClose(closeQty, 'TP3');
                }
                else if (targetState.tp1Fired && config.breakevenSl && hitSl && !botSignalState.isExecuting) {
                    let closeQty = floorVol(targetState.totalCoinAmount);
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    let success = await executeClose(closeQty, '保本止损');
                    
                    // 重试机制：如果由于极小仓位被币安拒绝，尝试强制清零本地状态以防止僵尸仓位
                    if (!success && closeQty < 0.002) {
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 警告: 仓位极小无法平仓，强制回收本地状态以自愈。`);
                        targetState.totalCoinAmount = 0;
                        targetState.totalUsdtAmount = 0;
                        targetState.averagePrice = 0;
                        targetState.activeDcaCount = 0;
                        targetState.tp1Fired = false; targetState.tp2Fired = false; targetState.tp3Fired = false;
                        success = true; 
                    }

                    if (success) {
                        targetState.tp1Fired = false; targetState.tp2Fired = false; targetState.tp3Fired = false;
                    }
                }
            }
        };

        // 独立处理多头和空头
        await processDirection(true, state.long, state.isLongBotRunning);
        if (config.tradeMode === 'futures') {
            await processDirection(false, state.short, state.isShortBotRunning);
        }
        
        if (state.logs.length > 20) state.logs.length = 20;

    }, 2000);
}

// 外部传入的状态持久化回调，用于发生交易后瞬间保存数据
let onStateChangeCallback = null;
function setOnStateChangeCallback(cb) {
    onStateChangeCallback = cb;
}

// 4. 允许外部（如手动操作）通知引擎重置时间戳，防止手动开仓后立刻触发自动开仓
function notifyManualTrade(isLongTrade) {
    const now = Date.now();
    if (isLongTrade) {
        botSignalState.lastDcaTimeLong = now;
        botSignalState.longRsiHitTime = 0;
        botSignalState.longMacdHitTime = 0;
        globalRsiOversoldTime = 0;
        globalMacdGoldenCrossTime = 0;
    } else {
        botSignalState.lastDcaTimeShort = now;
        botSignalState.shortRsiHitTime = 0;
        botSignalState.shortMacdHitTime = 0;
        globalRsiOverboughtTime = 0;
        globalMacdDeathCrossTime = 0;
    }
}

module.exports = { 
    startBotLoop, 
    executeRealOrder, 
    executeFuturesOrder, 
    setApiKeys, 
    getCurrentPrice: () => currentPrice,
    getDeltaUsdt: () => deltaUsdt,
    getGlobalVpoc: () => Array.from(globalVolumeProfile.entries()),
    notifyManualTrade,
    setOnStateChangeCallback
};