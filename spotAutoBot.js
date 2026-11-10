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
let priceUpdatedAt = 0;
let tradeRevision = 0;
let wakeRiskCheck = () => {};
let currentMinuteDelta = 0;
let lastMinuteStamp = 0;
let deltaUpdatedAt = 0;
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
function initBackendDeltaWS(getEngineConfig) {
    const mode = getEngineConfig().tradeMode;
    const host = mode === 'futures' ? 'fstream.binance.com' : 'stream.binance.com:9443';
    const ws = new WebSocket(`wss://${host}/stream?streams=btcusdt@aggTrade`, { agent: httpsAgent });
    ws.on('open', () => console.log('[SpotAutoBot] WS Connected for Backend Delta tracking'));
    ws.on('message', (data) => {
        try {
            if (getEngineConfig().tradeMode !== mode) {
                currentPrice = 0;
                priceUpdatedAt = 0;
                currentMinuteDelta = 0;
                deltaUsdt = 0;
                deltaUpdatedAt = 0;
                ws.close();
                return;
            }
            const rawData = JSON.parse(data);
            const parsed = rawData.data || rawData; // 兼容多路复用格式
            
            if (!parsed.p || !parsed.q) return; // 忽略没有价格和数量的数据包，防止 NaN 污染

            const price = parseFloat(parsed.p);
            const qty = parseFloat(parsed.q);
            if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) return;
            const isSell = parsed.m;
            currentPrice = price;
            priceUpdatedAt = Date.now();

            const currentMinute = Math.floor(Date.now() / 60000);
            if (currentMinute !== lastMinuteStamp) {
                currentMinuteDelta = 0;
                deltaUsdt = 0;
                lastMinuteStamp = currentMinute;
            }
            currentMinuteDelta += isSell ? -qty : qty;
            deltaUpdatedAt = Date.now();
            
            const newDelta = deltaUsdt + (isSell ? -qty : qty) * price;
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
            wakeRiskCheck();
        } catch (e) {}
    });
    ws.on('error', (e) => console.error('[SpotAutoBot] WS Error:', e.message));
    ws.on('close', () => setTimeout(() => initBackendDeltaWS(getEngineConfig), 3000));
}

// 下单确认与本地状态提交之间保留订单意图；重启后不盲目重复下单。
function beginOrder(targetState, kind, label) {
    if (targetState.pendingOrder) throw new Error('存在未核对订单，禁止重复下单');
    targetState.pendingOrder = {
        kind, label, clientOrderId: `sdca_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
    };
    tradeRevision++;
    if (onStateChangeCallback) onStateChangeCallback();
    return targetState.pendingOrder.clientOrderId;
}

function confirmedFill(res) {
    const qty = Number(res.executedQty);
    const quote = Number(res.cumQuote || res.cumQuoteQty || res.cummulativeQuoteQty);
    if (res.status !== 'FILLED' || !Number.isFinite(qty) || qty <= 0 ||
        !Number.isFinite(quote) || quote <= 0) {
        throw new Error('订单尚未确认完全成交，需核对订单后恢复交易');
    }
    return { qty, quote };
}

function rejectOrder(targetState, error) {
    // 明确的业务拒绝可以重试；超时、断网、5xx不能假定没有成交。
    if (error.response?.status >= 400 && error.response.status < 500 &&
        error.response.data?.code && ![-1006, -1007].includes(error.response.data.code)) {
        delete targetState.pendingOrder;
    }
    if (onStateChangeCallback) onStateChangeCallback();
}

// 2. 真实现货下单 API
async function executeRealOrder(side, quantity, quoteOrderQty, clientOrderId) {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) throw new Error('Missing API Keys in .env');
    
    const timestamp = Date.now();
    let queryString = `symbol=BTCUSDT&side=${side}&type=MARKET&recvWindow=60000&timestamp=${timestamp}`;
    if (quantity) queryString += `&quantity=${quantity}`;
    if (quoteOrderQty) queryString += `&quoteOrderQty=${quoteOrderQty}`;
    queryString += '&newOrderRespType=FULL';
    if (clientOrderId) queryString += `&newClientOrderId=${clientOrderId}`;

    const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
    const url = `https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`;

    const res = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
        httpAgent, httpsAgent, timeout: 10000
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
            httpAgent, httpsAgent, timeout: 10000
        });
        console.log(`[SpotAutoBot] Set Futures Leverage to ${leverage}x`);
    } catch (e) {
        console.error('[SpotAutoBot] Set Leverage Error:', e.response ? e.response.data : e.message);
        throw e;
    }
}

async function executeFuturesOrder(side, quantity, positionSide = '', clientOrderId) {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) throw new Error('Missing API Keys in .env');
    const timestamp = Date.now();
    let queryString = `symbol=BTCUSDT&side=${side}&type=MARKET&recvWindow=60000&timestamp=${timestamp}`;
    if (quantity) queryString += `&quantity=${quantity}`;
    if (positionSide) queryString += `&positionSide=${positionSide}`;
    queryString += '&newOrderRespType=RESULT';
    if (clientOrderId) queryString += `&newClientOrderId=${clientOrderId}`;

    const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
    const url = `https://fapi.binance.com/fapi/v1/order?${queryString}&signature=${signature}`;

    const res = await axios.post(url, null, {
        headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
        httpAgent, httpsAgent, timeout: 10000
    });
    return res.data;
}

// 3. 核心策略状态机轮询
function startBotLoop(getEngineConfig, getEngineState) {
    const memory = getEngineState().signalMemory;
    if (memory) {
        Object.assign(botSignalState, memory.botSignalState, { isExecuting: false });
        globalMacdState = memory.globalMacdState ?? null;
        globalMacdGoldenCrossTime = memory.globalMacdGoldenCrossTime || 0;
        globalMacdDeathCrossTime = memory.globalMacdDeathCrossTime || 0;
        globalRsiState = memory.globalRsiState ?? null;
        globalRsiOversoldTime = memory.globalRsiOversoldTime || 0;
        globalRsiOverboughtTime = memory.globalRsiOverboughtTime || 0;
    }
    let loopBusy = false;
    let pricePollBusy = false;
    const pollPrice = async () => {
        if (pricePollBusy || Date.now() - priceUpdatedAt < 3000) return;
        pricePollBusy = true;
        const mode = getEngineConfig().tradeMode;
        const requestedAt = Date.now();
        try {
            const url = mode === 'futures'
                ? 'https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT'
                : 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
            const res = await axios.get(url, { httpAgent, httpsAgent, timeout: 3000 });
            const price = Number(res.data.price);
            if (mode === getEngineConfig().tradeMode && priceUpdatedAt <= requestedAt &&
                Number.isFinite(price) && price > 0) {
                currentPrice = price;
                priceUpdatedAt = Date.now();
                wakeRiskCheck();
            }
        } catch (e) {
            console.error('[SpotAutoBot] Price fallback failed:', e.message);
        } finally {
            pricePollBusy = false;
        }
    };
    const runTick = async (riskOnly = false) => {
        if (loopBusy || botSignalState.isExecuting) return;
        loopBusy = true;
        try {
        const config = getEngineConfig();
        const state = getEngineState();
        
        // 信号持续追踪，即使尚无仓位且自动开关关闭。
        
        if (botSignalState.isExecuting) return;

        const now = Date.now();
        const windowMs = (config.signalWindow || 12) * 60 * 60 * 1000; // 12小时信号窗口

        // --- A. 获取宏观指标状态 ---
        let rsi = null, macdState = null, mtfState = null;
        let signalTime = now;
        try {
            if (regimeModule && typeof regimeModule.getState === 'function') {
                const regimeState = regimeModule.getState();
                if (regimeState && regimeState.indicators) {
                    const ind = regimeState.indicators;
                    // 强制使用 length - 2 获取上一根“已收盘”的 1h K线状态，过滤盘中未收线时的假穿越/假超买超卖
                    const i = (regimeState.klines?.length || ind.rsi?.length || 0) - 2;
                    const openTime = regimeState.klines?.[i]?.time;
                    if (Number.isFinite(openTime)) signalTime = openTime + 60 * 60 * 1000;
                    if (Number.isFinite(ind.rsi?.[i])) rsi = ind.rsi[i];
                    if (Number.isFinite(ind.macd?.[i]) && Number.isFinite(ind.signal?.[i])) {
                        if (ind.macd[i] > ind.signal[i]) macdState = '金叉';
                        else if (ind.macd[i] < ind.signal[i]) macdState = '死叉';
                    }
                }
            }
            if (mtfModule && typeof mtfModule.getTimeframe === 'function') {
                const row1m = mtfModule.getTimeframe('1');
                if (row1m && row1m.state) mtfState = row1m.state;
            }
        } catch (e) {
            console.error('[SpotAutoBot] Indicator Error:', e.message);
            rsi = null; macdState = null; mtfState = null;
        }

        // --- A2. 全局状态追踪 (后台持续运行，即使机器人暂停也记录跨越动作) ---
        if (macdState) {
            if (globalMacdState === null) {
                globalMacdState = macdState;
                // 取消重启时的伪造时间戳，MACD必须等待真正的状态跨越才记录
            } else if (macdState !== globalMacdState) {
                globalMacdState = macdState;
                if (macdState === '金叉') globalMacdGoldenCrossTime = signalTime;
                if (macdState === '死叉') globalMacdDeathCrossTime = signalTime;
            }
        }

        let currentRsiState = 'normal';
        if (rsi !== null) {
            if (rsi < config.rsiThreshold) currentRsiState = 'oversold';
            else if (rsi > (config.rsiOverboughtThreshold || 70)) currentRsiState = 'overbought';

            if (globalRsiState === null) {
                globalRsiState = currentRsiState;
                // 修复：如果启动时就已经处于超卖/超买状态，必须承认当前状态
                if (currentRsiState === 'oversold') globalRsiOversoldTime = signalTime;
                if (currentRsiState === 'overbought') globalRsiOverboughtTime = signalTime;
            } else if (currentRsiState !== globalRsiState) {
                // 只有在运行期间真实发生状态跨越（比如从 normal 变成 overbought），才记录时间戳
                globalRsiState = currentRsiState;
                if (currentRsiState === 'oversold') globalRsiOversoldTime = signalTime;
                if (currentRsiState === 'overbought') globalRsiOverboughtTime = signalTime;
            }
        }

        // --- B. 状态机时序流转 (双向并行处理) ---
        if (botSignalState.isExecuting) return;

        const processDirection = async (isLongTrade, targetState, isBotRunning, exitsOnly) => {
            if (targetState.pendingOrder) return;
            // 绝不能在这里因为 !isBotRunning 就 return，否则会跳过现有仓位的止盈止损！
            
            // 从持久化的 targetState 中读取 lastDcaTime，防止重启后冷却期归零
            const lastDcaTime = targetState.lastDcaTime || 0;
            
            // 1. 已收盘 1h RSI 极值必须晚于上次交易。
            if (rsi !== null) {
                if (isLongTrade) {
                    if (currentRsiState === 'oversold' && globalRsiOversoldTime > lastDcaTime) {
                        botSignalState.longRsiHitTime = globalRsiOversoldTime;
                    } else if (currentRsiState === 'overbought') {
                        botSignalState.longRsiHitTime = 0; // 反向极端，清空做多记忆
                    }
                } else {
                    if (currentRsiState === 'overbought' && globalRsiOverboughtTime > lastDcaTime) {
                        botSignalState.shortRsiHitTime = globalRsiOverboughtTime;
                    } else if (currentRsiState === 'oversold') {
                        botSignalState.shortRsiHitTime = 0; // 反向极端，清空做空记忆
                    }
                }
            }

            // 2. 已收盘 1h MACD 交叉确认。
            if (macdState !== null) {
                if (isLongTrade) {
                    if (macdState === '金叉' && globalMacdGoldenCrossTime > lastDcaTime) {
                        botSignalState.longMacdHitTime = globalMacdGoldenCrossTime;
                    } else if (macdState === '死叉') {
                        botSignalState.longMacdHitTime = 0; // 当前是死叉，废弃之前的金叉信号
                    }
                } else {
                    if (macdState === '死叉' && globalMacdDeathCrossTime > lastDcaTime) {
                        botSignalState.shortMacdHitTime = globalMacdDeathCrossTime;
                    } else if (macdState === '金叉') {
                        botSignalState.shortMacdHitTime = 0; // 当前是金叉，废弃之前的死叉信号
                    }
                }
            }

            // 两类信号分别按配置的小时窗口过期。
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
                if (config.requireMacd) {
                    // 铁律：必须先 RSI 超卖，再 MACD 金叉。
                    isReady = isReady && (botSignalState.longMacdHitTime > botSignalState.longRsiHitTime);
                }
            } else {
                isReady = botSignalState.shortRsiHitTime > 0;
                if (config.requireMacd) {
                    // 铁律：必须先 RSI 超买，再 MACD 死叉。
                    isReady = isReady && (botSignalState.shortMacdHitTime > botSignalState.shortRsiHitTime);
                }
            }
                
            // --- C. 微观扳机扣动 (真实买入/做空) ---
            // 只有当自动机器人开关是打开的 (isBotRunning = true) 时，才允许开新仓或加仓
            if (!exitsOnly && isBotRunning && isReady && !targetState.tp1Fired &&
                now >= (targetState.retryAfter || 0) &&
                (now - lastDcaTime > 60 * 60 * 1000) &&
                now - priceUpdatedAt < 10000) {
                let triggerMtf = true;
                if (config.triggerMtf) {
                    triggerMtf = isLongTrade 
                        ? (mtfState && mtfState.includes('强多'))
                        : (mtfState && mtfState.includes('强空'));
                }
                    
                let triggerDelta = true;
                if (config.triggerDelta) {
                    const freshDelta = Math.floor(now / 60000) === lastMinuteStamp && now - deltaUpdatedAt < 5000;
                    triggerDelta = freshDelta && (isLongTrade
                        ? (currentMinuteDelta > 0 && Math.abs(deltaUsdt) > (config.deltaThreshold || 2500000))
                        : (currentMinuteDelta < 0 && Math.abs(deltaUsdt) > (config.deltaThreshold || 2500000)));
                }
                    
                let isExecuting = isReady && triggerMtf && triggerDelta;

                if (isExecuting) {
                    const maxSteps = config.dcaMaxSteps || 5;
                    
                    if (targetState.activeDcaCount >= maxSteps) {
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
                            const id = beginOrder(targetState, 'entry', actionLabel);
                            const res = await executeFuturesOrder(side, qtyToBuy, posSide, id);
                            const fill = confirmedFill(res);
                            executedQty = fill.qty;
                            cumQuote = fill.quote;
                        } else {
                            if (!isLongTrade) throw new Error('现货模式不支持做空!');
                            const currentStepUsdt = config.dcaAmount * Math.pow(multiplier, targetState.activeDcaCount);
                            const id = beginOrder(targetState, 'entry', actionLabel);
                            const res = await executeRealOrder('BUY', null, currentStepUsdt, id);
                            const fill = confirmedFill(res);
                            executedQty = fill.qty;
                            cumQuote = fill.quote;
                        }
                        
                        const avgP = executedQty > 0 ? (cumQuote / executedQty) : currentPrice;

                        if (targetState.totalCoinAmount < 0.00001) {
                            targetState.entryTime = Date.now();
                            targetState.totalFees = 0;
                        }

                        targetState.activeDcaCount++;
                        targetState.totalUsdtAmount += cumQuote;
                        targetState.totalCoinAmount += executedQty;
                        
                        targetState.averagePrice = targetState.totalUsdtAmount / targetState.totalCoinAmount;
                        
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
                        targetState.slMoved = false;
                        targetState.customTp1Price = null;
                        targetState.customTp2Price = null;
                        targetState.customTp3Price = null;
                        
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${actionLabel}: ${cumQuote.toFixed(2)} USDT @ ${avgP.toFixed(2)}`);
                        
                        if (isLongTrade) {
                            botSignalState.longRsiHitTime = 0; botSignalState.longMacdHitTime = 0;
                            // 暴力斩断：强行清空全局追踪记忆，必须等待下一次真正的跨越才能开启新一轮等待
                            globalRsiOversoldTime = 0;
                            globalMacdGoldenCrossTime = 0;
                        } else {
                            botSignalState.shortRsiHitTime = 0; botSignalState.shortMacdHitTime = 0;
                            // 暴力斩断：强行清空全局追踪记忆，必须等待下一次真正的跨越才能开启新一轮等待
                            globalRsiOverboughtTime = 0;
                            globalMacdDeathCrossTime = 0;
                        }
                        targetState.lastDcaTime = now; // 写入持久化状态
                        delete targetState.pendingOrder;
                        tradeRevision++;
                        if (typeof onStateChangeCallback === 'function') onStateChangeCallback();
                    } catch (e) {
                        const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
                        console.error('[SpotAutoBot] Action Error:', errorMsg);
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实操作失败: ${errorMsg}`);
                        // 失败惩罚：如果调用币安接口报错（比如保证金不足），给它强制加上 1 分钟的冷却期
                        // 防止陷入死循环每 2 秒疯狂轰炸币安 API 导致封号
                        targetState.retryAfter = now + 60000;
                        rejectOrder(targetState, e);
                    } finally {
                        botSignalState.isExecuting = false;
                    }
                }
            }
            
            // --- D. 真实止盈/止损抛售 (TP / SL) ---
            if (exitsOnly && targetState.totalCoinAmount > 0 && targetState.averagePrice > 0 &&
                Number.isFinite(currentPrice) && now - priceUpdatedAt < 10000) {
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
                
                const floorVol = (vol) => config.tradeMode === 'futures' ? Math.floor(vol * 1000 + 1e-8) / 1000 : Math.floor(vol * 100000 + 1e-8) / 100000;
                
                const executeClose = async (closeQty, label) => {
                    if (closeQty <= 0) return false;
                    botSignalState.isExecuting = true;
                    try {
                        const id = beginOrder(targetState, 'close', label);
                        let fill;
                        if (config.tradeMode === 'futures') {
                            const side = isLongTrade ? 'SELL' : 'BUY';
                            const posSide = isLongTrade ? 'LONG' : 'SHORT';
                            const res = await executeFuturesOrder(side, closeQty, posSide, id);
                            fill = confirmedFill(res);
                        } else {
                            const res = await executeRealOrder('SELL', closeQty, null, id);
                            fill = confirmedFill(res);
                        }
                        closeQty = fill.qty;
                        const cumQuote = fill.quote;
                        
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
                        }
                        if (label === 'TP1') targetState.tp1Fired = true;
                        if (label === 'TP2') targetState.tp2Fired = true;
                        if (label === 'TP3') targetState.tp3Fired = true;
                        targetState.slMoved = targetState.totalCoinAmount > 0 && targetState.tp1Fired && config.breakevenSl;
                        delete targetState.pendingOrder;
                        tradeRevision++;
                        
                        const actionName = isLongTrade ? '卖出平多' : '买入平空';
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 真实${label} ${actionName}: ${closeQty} BTC (获 ${cumQuote.toFixed(2)})`);
                        if (onStateChangeCallback) onStateChangeCallback();
                        return true;
                    } catch (e) {
                        const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${label}失败: ${errorMsg}`);
                        rejectOrder(targetState, e);
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

                if (targetState.tp1Fired && config.breakevenSl && hitSl && !botSignalState.isExecuting) {
                    let closeQty = floorVol(targetState.totalCoinAmount);
                    if (closeQty <= 0) closeQty = targetState.totalCoinAmount;
                    await executeClose(closeQty, '保本止损');
                    return;
                }
                if (!targetState.tp1Fired && hitTp1 && !botSignalState.isExecuting) {
                    let closeQty = floorVol(targetState.totalCoinAmount * (config.tp1 / 100));
                    // 修复：如果分批后的数量小于交易所最小精度(如0.001)，则无法下单，改为全平
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    
                    if (!await executeClose(closeQty, 'TP1')) return;
                }
                if (targetState.totalCoinAmount > 0 && targetState.tp1Fired && !targetState.tp2Fired && hitTp2 && !botSignalState.isExecuting) {
                    const remainingRatio = config.tp2 / (config.tp2 + config.tp3);
                    let closeQty = floorVol(targetState.totalCoinAmount * remainingRatio);
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    
                    if (!await executeClose(closeQty, 'TP2')) return;
                }
                if (targetState.totalCoinAmount > 0 && targetState.tp2Fired && !targetState.tp3Fired && hitTp3 && !botSignalState.isExecuting) {
                    let closeQty = floorVol(targetState.totalCoinAmount);
                    if (closeQty <= 0 && targetState.totalCoinAmount > 0) closeQty = targetState.totalCoinAmount;
                    
                    await executeClose(closeQty, 'TP3');
                }
            }
        };

        // 独立处理多头和空头
        await processDirection(true, state.long, state.isLongBotRunning, true);
        if (config.tradeMode === 'futures') {
            await processDirection(false, state.short, state.isShortBotRunning, true);
        }
        if (!riskOnly) {
            await processDirection(true, state.long, state.isLongBotRunning, false);
            if (config.tradeMode === 'futures') await processDirection(false, state.short, state.isShortBotRunning, false);
        }
        
        const signalMemory = { botSignalState: { ...botSignalState, isExecuting: false },
            globalMacdState, globalMacdGoldenCrossTime, globalMacdDeathCrossTime,
            globalRsiState, globalRsiOversoldTime, globalRsiOverboughtTime };
        if (JSON.stringify(state.signalMemory) !== JSON.stringify(signalMemory)) {
            state.signalMemory = signalMemory;
            if (onStateChangeCallback) onStateChangeCallback();
        }
        if (state.logs.length > 20) state.logs.length = 20;
        } catch (e) {
            console.error('[SpotAutoBot] Loop Error:', e.message);
        } finally {
            loopBusy = false;
        }
    };
    wakeRiskCheck = () => { void runTick(true); };
    initBackendDeltaWS(getEngineConfig);
    setInterval(() => runTick(), 2000);
    setInterval(pollPrice, 1000);
    void pollPrice();
}

// 外部传入的状态持久化回调，用于发生交易后瞬间保存数据
let onStateChangeCallback = null;
function setOnStateChangeCallback(cb) {
    onStateChangeCallback = cb;
}

// 4. 允许外部（如手动操作）通知引擎重置时间戳，防止手动开仓后立刻触发自动开仓
function notifyManualTrade(isLongTrade, targetState) {
    const now = Date.now();
    if (targetState) targetState.lastDcaTime = now;
    tradeRevision++;
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
    setOnStateChangeCallback,
    botSignalState,
    getTradeRevision: () => tradeRevision,
    beginOrder,
    confirmedFill,
    rejectOrder
};
