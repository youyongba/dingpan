const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const dataFile = path.join(__dirname, 'spotDcaData.json');
const mtfModule = require('./mtfModule');
const regimeModule = require('./regimeModule');
const { recoverPosition } = require('./lib/spotOrderRecovery');

const { startBotLoop, executeRealOrder, executeFuturesOrder, getCurrentPrice, getDeltaUsdt, getDeltaStreamStatus, getGlobalVpoc, notifyManualTrade, setOnStateChangeCallback, beginOrder, confirmedFill, queryOrder, rejectOrder } = require('./spotAutoBot');

// 强制使用绝对路径加载 .env，防止 PM2 工作目录 (cwd) 偏移导致找不到文件
const envPath = path.resolve(__dirname, '.env');
const envResult = require('dotenv').config({ path: envPath });

console.log('\n================ [SpotDCA Env Debug] ================');
console.log('1. Current Working Dir (cwd):', process.cwd());
console.log('2. Target .env path:', envPath);
if (envResult.error) {
    console.log('3. Dotenv Load Error:', envResult.error.message);
} else {
    console.log('3. Dotenv Load Success. Keys found in file:', Object.keys(envResult.parsed || {}).filter(k => k.includes('BINANCE')));
}
console.log('4. Raw SPOT_API_KEY length:', (process.env.BINANCE_SPOT_API_KEY || '').length);
console.log('5. Raw SPOT_API_SECRET length:', (process.env.BINANCE_SPOT_API_SECRET || '').length);
console.log('=====================================================\n');

const router = express.Router();

const CONFIG_AUTH_TOKEN = process.env.CONFIG_AUTH_TOKEN || '';

function requireAdmin(req, res, next) {
    if (!CONFIG_AUTH_TOKEN) return res.status(503).json({ ok: false, error: '服务端未设置 CONFIG_AUTH_TOKEN' });
    const token = req.headers['x-auth-token'];
    if (token !== CONFIG_AUTH_TOKEN) {
        return res.status(401).json({ ok: false, error: '鉴权失败: Token 不正确' });
    }
    next();
}

let config = {
  tradeMode: 'spot', // 'spot' or 'futures'
  tradeDirection: 'long', // 'long' or 'short' (永续合约专属)
  leverage: 100,
  positionSizePct: 3.0, // 最大使用资金占比 (最大亏损 3%)
  rsiThreshold: 30, // 做多超卖阈值
  rsiOverboughtThreshold: 70, // 做空超买阈值
  requireMacd: true,
  signalWindow: 12,
  triggerDelta: true,
  triggerMtf: true,
  deltaThreshold: 2500000,
  dcaAmount: 3000,
  dcaMaxSteps: 5, // 最大加仓次数
  martingaleMultiplier: 2.0, // 马丁格尔加仓倍数
  breakevenSl: true,
  autoLoop: false, // 自动循环现货 DCA
  tp1: 50,
  tp2: 30,
  tp3: 20,
  tp1Target: 1.0, // TP1 目标整体收益率 (%)
  tp2Target: 3.0,
  tp3Target: 5.0,
  tpMode: 'percent' // 'percent' or 'atr'
};

let savedData = null;
try {
    if (fs.existsSync(dataFile)) {
        const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        savedData = saved;
        if (saved.config) config = { ...config, ...saved.config };
    }
} catch (e) {
    console.error('[SpotDCA] Load data error:', e);
    // 不允许损坏的存档被默认空仓状态覆盖后继续交易。
    throw e;
}

function saveData() {
    let fd;
    try {
        const tempFile = `${dataFile}.tmp`;
        fd = fs.openSync(tempFile, 'w', 0o600);
        fs.writeFileSync(fd, JSON.stringify({
            config,
            botState: { isLongBotRunning: state.isLongBotRunning, isShortBotRunning: state.isShortBotRunning },
            positions: { long: state.long, short: state.short },
            signalMemory: state.signalMemory
        }, null, 2));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tempFile, dataFile);
        fd = fs.openSync(__dirname, 'r');
        fs.fsyncSync(fd);
    } catch (e) {
        console.error('[SpotDCA] Save data error:', e);
        throw e;
    } finally {
        if (fd !== undefined && fd !== null) fs.closeSync(fd);
    }
}

// 绑定持久化回调，让底层引擎每次成功开仓/平仓后都能瞬间触发持久化
if (typeof setOnStateChangeCallback === 'function') {
    setOnStateChangeCallback(saveData);
}

// 兜底机制：每 5 秒持久化一次状态，防止意外遗漏
setInterval(saveData, 5000);

const createPosState = () => ({
  activeDcaCount: 0,
  totalCoinAmount: 0,
  totalUsdtAmount: 0,
  averagePrice: 0,
  entryTime: null,
  lastDcaTime: 0, // 新增：持久化记录最后一次加仓时间，防止重启后冷却期失效
  totalFees: 0,
  tp1Fired: false,
  tp2Fired: false,
  tp3Fired: false,
  customTp1Price: null,
  customTp2Price: null,
  customTp3Price: null,
  lockedAtr: 0,
  slMoved: false
});

let state = {
  long: createPosState(),
  short: createPosState(),
  logs: [],
  enabled: true,
  isLongBotRunning: false,
  isShortBotRunning: false,
  positionSide: null, // Legacy, kept for fallback
  spotBalanceUsdt: 0,
  spotBalanceBtc: 0,
  futuresBalanceUsdt: 0,
  futuresPositions: []
};

if (savedData) {
    state.isLongBotRunning = savedData.botState?.isLongBotRunning === true;
    state.isShortBotRunning = savedData.botState?.isShortBotRunning === true;
    Object.assign(state.long, savedData.positions?.long);
    Object.assign(state.short, savedData.positions?.short);
    state.signalMemory = savedData.signalMemory;
}

// 币安现货 API 密钥 (初始从环境变量读取，如果配置里有则优先使用)
let SPOT_API_KEY = (process.env.BINANCE_SPOT_API_KEY || process.env.BINANCE_API_KEY || '').trim();
let SPOT_API_SECRET = (process.env.BINANCE_SPOT_API_SECRET || process.env.BINANCE_API_SECRET || '').trim();

function refreshApiKeys() {
    if (config.apiKey) SPOT_API_KEY = config.apiKey.trim();
    if (config.apiSecret) SPOT_API_SECRET = config.apiSecret.trim();
    require('./spotAutoBot').setApiKeys(SPOT_API_KEY, SPOT_API_SECRET);
}
refreshApiKeys();

// 引入全局的代理配置 (复用主程序的代理)
const { httpAgent, httpsAgent } = require('./lib/httpAgents');

const recoveryLogTimes = new Map();
async function reconcilePendingOrders() {
    const { botSignalState } = require('./spotAutoBot');
    if (botSignalState.isExecuting || !queryOrder ||
        (!state.long.pendingOrder && !state.short.pendingOrder)) return;
    botSignalState.isExecuting = true;
    try {
        for (const [direction, target] of [['long', state.long], ['short', state.short]]) {
            const pending = target.pendingOrder;
            if (!pending) continue;
            const original = { ...target };
            try {
                const order = await queryOrder(pending.clientOrderId, pending.market || config.tradeMode);
                if (target.pendingOrder !== pending) continue;
                if (['CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(order.status) &&
                    Number(order.executedQty) === 0) {
                    delete target.pendingOrder;
                    target.retryAfter = Date.now() + 60000;
                    saveData();
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 原订单已${order.status}且无成交，解除待核对状态`);
                    continue;
                }
                const fill = confirmedFill(order);
                let atr = 0;
                try {
                    const arr = regimeModule.getState()?.indicators?.atr;
                    atr = arr?.[arr.length - 1] || 0;
                } catch (e) {}
                const recovered = recoverPosition(target, order, config, direction === 'long', fill, atr);
                Object.assign(target, recovered);
                delete target.pendingOrder;
                notifyManualTrade(direction === 'long', pending.kind === 'entry' ? target : undefined);
                // Clear persisted entry signals as well as the in-memory signal state.
                if (state.signalMemory) {
                    const isLong = direction === 'long';
                    if (state.signalMemory.botSignalState) {
                        state.signalMemory.botSignalState[isLong ? 'longRsiHitTime' : 'shortRsiHitTime'] = 0;
                        state.signalMemory.botSignalState[isLong ? 'longMacdHitTime' : 'shortMacdHitTime'] = 0;
                    }
                    state.signalMemory[isLong ? 'globalRsiOversoldTime' : 'globalRsiOverboughtTime'] = 0;
                    state.signalMemory[isLong ? 'globalMacdGoldenCrossTime' : 'globalMacdDeathCrossTime'] = 0;
                }
                saveData();
                recoveryLogTimes.delete(pending.clientOrderId);
                state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 原订单核对成功(${direction === 'long' ? '多头' : '空头'} ${pending.label}): 已成交 ${fill.qty} BTC，持仓记录已恢复`);
                if (state.logs.length > 20) state.logs.length = 20;
                console.log('[SpotDCA] Reconciled order:', pending.clientOrderId, order.status, fill.qty);
            } catch (e) {
                // Restore the intent on lookup/commit failure; never issue a replacement order.
                Object.assign(target, original);
                const lastLog = recoveryLogTimes.get(pending.clientOrderId) || 0;
                if (Date.now() - lastLog > 60000) {
                    console.error('[SpotDCA] Order still pending:', pending.clientOrderId, e.message);
                    recoveryLogTimes.set(pending.clientOrderId, Date.now());
                }
            }
        }
    } finally {
        botSignalState.isExecuting = false;
    }
}

// 获取账户余额 (包含现货与合约)
async function fetchBalances() {
  // 同步请求期间可能成交，旧快照不能覆盖新仓位或止盈记录。
  const { botSignalState, getTradeRevision } = require('./spotAutoBot');
  const revision = getTradeRevision();
  if (!SPOT_API_KEY || !SPOT_API_SECRET) {
      console.log('[SpotDCA] Missing Binance API keys in .env. Using mock balance.');
      state.spotBalanceUsdt = 50000;
      state.spotBalanceBtc = 0.5;
      state.futuresBalanceUsdt = 10000;
      return;
  }
  
  const timestamp = Date.now();
  const queryString = `recvWindow=60000&timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');

  // 1. 获取现货余额
  try {
    const spotUrl = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;
    const spotRes = await axios.get(spotUrl, {
      headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
      httpAgent, httpsAgent
    });
    if (spotRes.data && spotRes.data.balances) {
      const usdt = spotRes.data.balances.find(b => b.asset === 'USDT');
      const btc = spotRes.data.balances.find(b => b.asset === 'BTC');
      if (usdt) state.spotBalanceUsdt = parseFloat(usdt.free);
      if (btc) state.spotBalanceBtc = parseFloat(btc.free);
    }
  } catch (error) {
    console.error('[SpotDCA] Spot Balance Error:', error.message);
  }

  // 2. 获取合约余额
  try {
    const futuresUrl = `https://fapi.binance.com/fapi/v2/account?${queryString}&signature=${signature}`;
    const futuresRes = await axios.get(futuresUrl, {
      headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
      httpAgent, httpsAgent
    });
    if (futuresRes.data && futuresRes.data.availableBalance) {
      state.futuresBalanceUsdt = parseFloat(futuresRes.data.availableBalance);
    }
    
    // 获取合约持仓
    const posQueryString = `symbol=BTCUSDT&${queryString}`;
    const posSignature = crypto.createHmac('sha256', SPOT_API_SECRET).update(posQueryString).digest('hex');
    const posUrl = `https://fapi.binance.com/fapi/v2/positionRisk?${posQueryString}&signature=${posSignature}`;
    const posRes = await axios.get(posUrl, {
      headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
      httpAgent, httpsAgent
    });
    
    if (posRes.data && Array.isArray(posRes.data)) {
        state.futuresPositions = posRes.data.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            positionAmt: parseFloat(p.positionAmt),
            entryPrice: parseFloat(p.entryPrice),
            unRealizedProfit: parseFloat(p.unRealizedProfit),
            positionSide: p.positionSide,
            leverage: p.leverage
        }));
        
        // 自动纠正内存中的 DCA 状态 (双向隔离同步)
        if (config.tradeMode === 'futures' && !botSignalState.isExecuting && revision === getTradeRevision()) {
            const syncSide = (posSideStr, stateObj) => {
                const active = state.futuresPositions.find(p => p.positionSide === posSideStr);
                // 未确认订单必须先核对，不能按仓位数量猜测其成交阶段。
                if (stateObj.pendingOrder) return;
                if (active) {
                    const apiAvgPrice = active.entryPrice;
                    const apiAmt = Math.abs(active.positionAmt);
                    const localAvgPrice = stateObj.averagePrice || 0;
                    const localAmt = stateObj.totalCoinAmount || 0;
                    
                    if (localAmt < 0.00001 && apiAmt > 0) {
                        stateObj.totalCoinAmount = apiAmt;
                        stateObj.averagePrice = apiAvgPrice;
                        stateObj.totalUsdtAmount = apiAmt * apiAvgPrice; 
                        if (!Number.isFinite(stateObj.totalUsdtAmount)) stateObj.totalUsdtAmount = 0; // 防 NaN
                        
                        stateObj.entryTime = stateObj.entryTime || Date.now();
                        stateObj.lastDcaTime = stateObj.lastDcaTime || Date.now();
                        // 只有在完全没有记录（连持久化都没有）的情况下才认为是新接管
                        if (stateObj.activeDcaCount === 0) stateObj.activeDcaCount = 1; 
                        
                        // 自动接管时，如果使用 atr_static，必须给一个初始标尺，防止 spotAutoBot 用当前极端的 ATR 误算止盈
                        if (config.tpMode === 'atr_static' && !stateObj.lockedAtr) {
                             try {
                                 const regimeState = require('./regimeModule').getState();
                                 if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                                     const atrArr = regimeState.indicators.atr;
                                     stateObj.lockedAtr = atrArr[atrArr.length - 1];
                                 }
                             } catch(e) {}
                        }
                        
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 自动接管(${posSideStr})持仓: ${apiAmt} BTC`);
                        saveData();
                    } else if (localAvgPrice > 0 && apiAvgPrice > 0 && Math.abs(apiAvgPrice - localAvgPrice) / localAvgPrice > 0.0005) {
                        stateObj.averagePrice = apiAvgPrice;
                        stateObj.totalCoinAmount = apiAmt;
                        stateObj.totalUsdtAmount = apiAmt * apiAvgPrice; // 致命 Bug 修复
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 均价漂移修正(${posSideStr}): 同步至 ${apiAvgPrice.toFixed(2)}`);
                        saveData();
                    } else if (localAmt > 0 && apiAmt > 0 && Math.abs(apiAmt - localAmt) > 0.0001) {
                        stateObj.totalCoinAmount = apiAmt;
                        stateObj.totalUsdtAmount = apiAmt * stateObj.averagePrice; // 致命 Bug 修复
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 仓位数量修正(${posSideStr}): 同步至 ${apiAmt} BTC`);
                        saveData();
                    }
                } else if (stateObj.totalCoinAmount > 0.00001) {
                    stateObj.totalCoinAmount = 0;
                    stateObj.averagePrice = 0;
                    stateObj.totalUsdtAmount = 0;
                    stateObj.activeDcaCount = 0;
                    stateObj.entryTime = null;
                    stateObj.totalFees = 0;
                    stateObj.tp1Fired = false;
                    stateObj.tp2Fired = false;
                    stateObj.tp3Fired = false;
                    stateObj.lockedAtr = 0;
                    stateObj.slMoved = false;
                    stateObj.customTp1Price = null;
                    stateObj.customTp2Price = null;
                    stateObj.customTp3Price = null;
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 远端无持仓，自动清空(${posSideStr})本地状态`);
                    saveData();
                }
            };
            syncSide('LONG', state.long);
            syncSide('SHORT', state.short);
        }
    }
  } catch (error) {
    console.error('[SpotDCA] Futures Balance Error:', error.message);
  }
}

// 获取资金费率和手续费
async function fetchPositionFees() {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) return;
    
    const fetchFeeForState = async (stateObj, isShort) => {
        if (!stateObj.entryTime || stateObj.totalCoinAmount === 0) return;
        const timestamp = Date.now();
        const startTime = stateObj.entryTime;
    
    try {
        let totalFee = 0;
        
        if (config.tradeMode === 'futures') {
            const queryString = `symbol=BTCUSDT&startTime=${startTime}&recvWindow=60000&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
            const url = `https://fapi.binance.com/fapi/v1/income?${queryString}&signature=${signature}`;
            
            const res = await axios.get(url, {
                headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
                httpAgent, httpsAgent
            });
            
            if (res.data && Array.isArray(res.data)) {
                res.data.forEach(item => {
                    if (item.incomeType === 'COMMISSION' || item.incomeType === 'FUNDING_FEE') {
                        totalFee -= parseFloat(item.income);
                    }
                });
            }
        } else {
            const queryString = `symbol=BTCUSDT&startTime=${startTime}&recvWindow=60000&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
            const url = `https://api.binance.com/api/v3/myTrades?${queryString}&signature=${signature}`;
            
            const res = await axios.get(url, {
                headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
                httpAgent, httpsAgent
            });
            
            if (res.data && Array.isArray(res.data)) {
                res.data.forEach(item => {
                    if (item.commissionAsset === 'USDT') {
                        totalFee += parseFloat(item.commission);
                    } else if (item.commissionAsset === 'BNB') {
                        totalFee += parseFloat(item.commission) * 600; // 粗估 BNB 价格
                    }
                });
            }
        }
        
        stateObj.totalFees = Number.isFinite(totalFee) ? totalFee : 0;
        if (stateObj.totalCoinAmount > 0 && config.tradeMode !== 'futures') {
            const safeUsdt = Number.isFinite(stateObj.totalUsdtAmount) ? stateObj.totalUsdtAmount : 0;
            const safeFees = Number.isFinite(stateObj.totalFees) ? stateObj.totalFees : 0;
            
            const adjUsdt = !isShort ? (safeUsdt + safeFees) : (safeUsdt - safeFees);
            const newAvgPrice = adjUsdt / stateObj.totalCoinAmount;
            
            if (Number.isFinite(newAvgPrice) && newAvgPrice > 0) {
                stateObj.averagePrice = newAvgPrice;
            }
        }
    } catch (e) {
        console.error('[SpotDCA] Fetch Fees Error:', e.message);
    }
  };
  await fetchFeeForState(state.long, false);
  await fetchFeeForState(state.short, true);
}

// 启动时和每隔一段时间拉取一次余额与手续费
fetchBalances();
setInterval(fetchBalances, 60000);
setInterval(fetchPositionFees, 60000);

// 全局缓存宏观固化 vPOC 数据
let macroVpocData = { vpoc: null, vah: null, val: null, updatedAt: 0 };

async function fetchMacroVpoc() {
    try {
        // 拉取最近 24 小时的 15m K线 (96 根)
        const res = await axios.get('https://api.binance.com/api/v3/klines', {
            params: { symbol: 'BTCUSDT', interval: '15m', limit: 96 },
            httpAgent, httpsAgent
        });
        
        const klines = res.data;
        const tickSize = 10;
        const profile = new Map();
        let totalSessionVolume = 0;
        
        // 基于 K 线的粗略 Volume Profile 分布 (将单根 K 线的成交量均匀平摊到 H-L 区间)
        klines.forEach(k => {
            const high = parseFloat(k[2]);
            const low = parseFloat(k[3]);
            const vol = parseFloat(k[5]); // base asset volume
            
            const startTick = Math.floor(low / tickSize) * tickSize;
            const endTick = Math.floor(high / tickSize) * tickSize;
            const ticksCount = Math.max(1, (endTick - startTick) / tickSize + 1);
            const volPerTick = vol / ticksCount;
            
            for (let t = startTick; t <= endTick; t += tickSize) {
                profile.set(t, (profile.get(t) || 0) + volPerTick);
                totalSessionVolume += volPerTick;
            }
        });
        
        let maxVol = 0;
        let vpoc = 0;
        let prices = [];
        
        profile.forEach((v, p) => {
            prices.push({ price: p, vol: v });
            if (v > maxVol) {
                maxVol = v;
                vpoc = p;
            }
        });
        
        // 计算 VAH 和 VAL (累积成交量达到总成交量 70% 的价值区间)
        prices.sort((a, b) => b.vol - a.vol); // 按成交量降序
        let accumulatedVol = 0;
        const valueAreaPrices = [];
        const targetVol = totalSessionVolume * 0.70;
        
        for (let item of prices) {
            accumulatedVol += item.vol;
            valueAreaPrices.push(item.price);
            if (accumulatedVol >= targetVol) break;
        }
        
        valueAreaPrices.sort((a, b) => a - b); // 再按价格升序排序找边界
        const vah = valueAreaPrices.length > 0 ? valueAreaPrices[valueAreaPrices.length - 1] : vpoc;
        const val = valueAreaPrices.length > 0 ? valueAreaPrices[0] : vpoc;
        
        macroVpocData = {
            vpoc, vah, val,
            updatedAt: Date.now()
        };
        console.log(`[SpotDCA] Macro vPOC updated: ${vpoc} (VAH: ${vah}, VAL: ${val})`);
    } catch (e) {
        console.error('[SpotDCA] Failed to fetch macro vPOC klines:', e.message);
    }
}

// 启动时拉取，并每 15 分钟更新一次
fetchMacroVpoc();
setInterval(fetchMacroVpoc, 15 * 60 * 1000);

router.get('/status', (req, res) => {
  // 获取真实的指标状态
  let realIndicators = { rsi1h: null, macd1h: null, mtf1m: null, currentAtr: 0 };
  try {
    if (regimeModule && typeof regimeModule.getState === 'function') {
        const regimeState = regimeModule.getState();
        if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
            const atrArr = regimeState.indicators.atr;
            realIndicators.currentAtr = atrArr[atrArr.length - 1];
        }
        if (regimeState && regimeState.indicators) {
            const ind = regimeState.indicators;
            if (ind.rsi && ind.rsi.length > 1) {
                realIndicators.rsi1h = ind.rsi[ind.rsi.length - 2];
            }
            if (ind.macd && ind.signal && ind.macd.length > 1) {
                const macd = ind.macd[ind.macd.length - 2];
                const sig = ind.signal[ind.signal.length - 2];
                realIndicators.macd1h = macd > sig ? 'MACD 金叉 (多头)' : 'MACD 死叉 (空头)';
            }
        }
    }
    if (mtfModule && typeof mtfModule.getTimeframe === 'function') {
        const row1m = mtfModule.getTimeframe('1');
        if (row1m && row1m.state) {
            realIndicators.mtf1m = row1m.state;
        }
    }
  } catch (e) {
      console.error('[SpotDCA] Error fetching real indicators:', e.message);
  }

  const frontendMtfState = {
      state: realIndicators.mtf1m || '观望',
      deltaUsdt: getDeltaUsdt ? getDeltaUsdt() : 0
  };

  res.json({
    ok: true,
    config,
    state,
    realIndicators,
    macroVpoc: macroVpocData,
    globalVpoc: getGlobalVpoc ? getGlobalVpoc() : [],
    deltaStream: getDeltaStreamStatus ? getDeltaStreamStatus() : null,
    hasAuthToken: !!CONFIG_AUTH_TOKEN, // 告诉前端服务端是否需要鉴权
    hasApiKeys: !!SPOT_API_KEY && !!SPOT_API_SECRET, // 告诉前端是否已经配置了 API Keys
    price: getCurrentPrice ? getCurrentPrice() : 0,
    mtfState: frontendMtfState
  });
});

router.post('/api-keys', express.json(), requireAdmin, (req, res) => {
  const { apiKey, apiSecret } = req.body;
  config.apiKey = apiKey || '';
  config.apiSecret = apiSecret || '';
  refreshApiKeys();
  saveData();
  
  // 同步更新给 bot
  const { setApiKeys } = require('./spotAutoBot');
  if (typeof setApiKeys === 'function') {
      setApiKeys(SPOT_API_KEY, SPOT_API_SECRET);
  }
  
  res.json({ ok: true, msg: 'API Keys updated' });
});

router.post('/toggle-bot', express.json(), requireAdmin, (req, res) => {
  const { direction } = req.body; // 'long' or 'short'
  if (direction === 'short') {
      state.isShortBotRunning = !state.isShortBotRunning;
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动${state.isShortBotRunning ? '开启' : '关闭'}自动做空引擎`);
  } else {
      state.isLongBotRunning = !state.isLongBotRunning;
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动${state.isLongBotRunning ? '开启' : '关闭'}自动做多引擎`);
  }
  saveData();
  res.json({ ok: true, state });
});

router.post('/custom-tp', express.json(), requireAdmin, (req, res) => {
  const { level, price, direction } = req.body;
  if (![1, 2, 3].includes(level) || (price !== null && (!Number.isFinite(price) || price <= 0))) {
      return res.status(400).json({ ok: false, error: '止盈级别或价格无效' });
  }
  const isShort = direction === 'short';
  const targetState = isShort ? state.short : state.long;

  if (level === 1) targetState.customTp1Price = price || null;
  if (level === 2) targetState.customTp2Price = price || null;
  if (level === 3) targetState.customTp3Price = price || null;
  
  const sideStr = isShort ? '空头' : '多头';
  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动更新${sideStr}止盈${level}价格为: ${price || '默认'}`);
  saveData();
  res.json({ ok: true, state });
});

router.post('/config', express.json(), requireAdmin, (req, res) => {
  const next = { ...config, ...req.body };
  const positiveFields = ['leverage', 'positionSizePct', 'signalWindow', 'dcaAmount', 'dcaMaxSteps',
      'martingaleMultiplier', 'tp1', 'tp2', 'tp3', 'tp1Target', 'tp2Target', 'tp3Target'];
  if (positiveFields.some(key => !Number.isFinite(next[key]) || next[key] <= 0) ||
      !Number.isInteger(next.dcaMaxSteps) || next.positionSizePct > 100 ||
      Math.abs(next.tp1 + next.tp2 + next.tp3 - 100) > 1e-6 ||
      !(next.tp1Target < next.tp2Target && next.tp2Target < next.tp3Target) ||
      !(next.rsiThreshold > 0 && next.rsiThreshold < next.rsiOverboughtThreshold && next.rsiOverboughtThreshold < 100) ||
      !['spot', 'futures'].includes(next.tradeMode) ||
      !['percent', 'atr_static', 'atr_dynamic'].includes(next.tpMode)) {
      return res.status(400).json({ ok: false, error: '策略参数无效，请检查止盈比例、目标顺序和仓位限制' });
  }
  if (next.tradeMode !== config.tradeMode &&
      (state.long.totalCoinAmount > 0 || state.short.totalCoinAmount > 0 ||
       state.long.pendingOrder || state.short.pendingOrder)) {
      return res.status(409).json({ ok: false, error: '持仓期间不能切换现货和合约模式' });
  }
  config = next;
  saveData();
  res.json({ ok: true, config });
});

router.post('/refresh-atr', express.json(), requireAdmin, (req, res) => {
  try {
      if (regimeModule && typeof regimeModule.getState === 'function') {
          const regimeState = regimeModule.getState();
          if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
              const atrArr = regimeState.indicators.atr;
              const currentAtr = atrArr[atrArr.length - 1];
              if (state.long) state.long.lockedAtr = currentAtr;
              if (state.short) state.short.lockedAtr = currentAtr;
              state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动双向刷新静态 ATR 为: ${currentAtr.toFixed(2)}`);
          }
      }
  } catch (e) {}
  saveData();
  res.json({ ok: true, state });
});

router.post('/override', express.json(), requireAdmin, async (req, res) => {
  const { action, amount } = req.body;
  if (!['market-buy', 'market-buy-short', 'market-sell-long', 'market-sell-short', 'market-sell'].includes(action)) {
      return res.status(400).json({ ok: false, error: '未知操作' });
  }
  if (state.long.pendingOrder || state.short.pendingOrder) {
      return res.status(409).json({ ok: false, error: '有未确认订单，必须先与交易所核对' });
  }
  
  // 防止手动操作与自动机器人高频并发抢夺资源
  const { botSignalState } = require('./spotAutoBot');
  if (botSignalState && botSignalState.isExecuting) {
      return res.status(409).json({ ok: false, error: '机器人正在自动交易中，请稍后再试' });
  }
  if (botSignalState) botSignalState.isExecuting = true;
  try {
  const logMsg = `[Override] 强制发起 ${action} ${amount || ''}`;
  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ` + logMsg);
  if (state.logs.length > 20) state.logs.pop();
  
  if (action === 'market-buy' || action === 'market-buy-short') {
    const targetState = action === 'market-buy-short' ? state.short : state.long;
    try {
      if (targetState.tp1Fired) throw new Error('止盈阶段禁止加仓，以保留尾仓保护');
      let amt = parseFloat(amount);
      let executedQty = 0;
      let cumQuote = 0;
      
      if (config.tradeMode === 'futures') {
        if (!amt || amt <= 0) throw new Error('无效的开仓金额');
        const { getCurrentPrice } = require('./spotAutoBot');
        const currentPrice = getCurrentPrice();
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error('当前价格不可用');
        let qtyToBuy = Math.floor((amt / currentPrice) * 1000) / 1000;
        if (qtyToBuy < 0.001) throw new Error(`数量太小: ${qtyToBuy}`);
        
        const side = action === 'market-buy-short' ? 'SELL' : 'BUY';
        const posSide = action === 'market-buy-short' ? 'SHORT' : 'LONG';
        const id = beginOrder(targetState, 'entry', 'manual', { market: config.tradeMode });
        const orderRes = await executeFuturesOrder(side, qtyToBuy, posSide, id);
        const fill = confirmedFill(orderRes);
        executedQty = fill.qty;
        cumQuote = fill.quote;
      } else {
        if (action === 'market-buy-short') throw new Error('现货模式不支持做空');
        if (!amt || amt <= 0) throw new Error('无效的买入金额');
        const id = beginOrder(targetState, 'entry', 'manual', { market: config.tradeMode });
        const orderRes = await executeRealOrder('BUY', null, amt, id);
        const fill = confirmedFill(orderRes);
        executedQty = fill.qty;
        cumQuote = fill.quote;
      }
      
      const isShort = action === 'market-buy-short';

      if (targetState.totalCoinAmount < 0.00001) {
          targetState.entryTime = Date.now();
          targetState.totalFees = 0;
      }

      targetState.activeDcaCount++;
      targetState.totalUsdtAmount += cumQuote;
      targetState.totalCoinAmount += executedQty;
      
      targetState.averagePrice = targetState.totalUsdtAmount / targetState.totalCoinAmount;
      
      try {
          if (regimeModule && typeof regimeModule.getState === 'function') {
              const regimeState = regimeModule.getState();
              if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                  const atrArr = regimeState.indicators.atr;
                  targetState.lockedAtr = atrArr[atrArr.length - 1];
              }
          }
      } catch(e){}
      
      targetState.tp1Fired = false;
      targetState.tp2Fired = false;
      targetState.tp3Fired = false;
      targetState.slMoved = false;
      targetState.customTp1Price = null;
      targetState.customTp2Price = null;
      targetState.customTp3Price = null;
      
      // 同步清空底层信号时间戳，防止手动开仓后立刻触发自动开仓
      if (typeof notifyManualTrade === 'function') {
          notifyManualTrade(!isShort, targetState);
      }
      
      const actionName = action === 'market-buy-short' ? '做空' : '买入';
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动${actionName}成功: 获 ${executedQty} BTC`);
      delete targetState.pendingOrder;
      saveData(); // 手动交易瞬间保存
    } catch (e) {
      const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('[Override Error] BUY/SELL failed:', errorMsg);
      rejectOrder(targetState, e);
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${targetState.pendingOrder ? '开仓订单待核对（不会重复下单）' : '开仓失败'}: ${errorMsg}`);
      return res.status(502).json({ ok: false, error: errorMsg });
    }
  } else if (action === 'market-sell-long' || action === 'market-sell-short' || action === 'market-sell') {
    try {
      if (config.tradeMode === 'futures') {
          // 使用内存中同步的精准仓位数据
          if (action === 'market-sell-long' || action === 'market-sell') {
              if (state.long.totalCoinAmount > 0.00001) {
                  const closeLongQty = Math.floor(state.long.totalCoinAmount * 1000) / 1000;
                  const id = beginOrder(state.long, 'close', 'manual', { market: config.tradeMode });
                  const fill = confirmedFill(await executeFuturesOrder('SELL', closeLongQty, 'LONG', id));
                  if (Math.abs(fill.qty - state.long.totalCoinAmount) > 1e-8) throw new Error('成交数量与清仓数量不一致，需要核对');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多成功: 平仓 ${closeLongQty} BTC`);
              } else if (action === 'market-sell-long') {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多: 没有找到可平的多头仓位`);
              }
              Object.assign(state.long, createPosState());
              notifyManualTrade(true, state.long);
              delete state.long.pendingOrder;
              saveData();
          }
          
          if (action === 'market-sell-short' || action === 'market-sell') {
              if (state.short.totalCoinAmount > 0.00001) {
                  const closeShortQty = Math.floor(state.short.totalCoinAmount * 1000) / 1000;
                  const id = beginOrder(state.short, 'close', 'manual', { market: config.tradeMode });
                  const fill = confirmedFill(await executeFuturesOrder('BUY', closeShortQty, 'SHORT', id));
                  if (Math.abs(fill.qty - state.short.totalCoinAmount) > 1e-8) throw new Error('成交数量与清仓数量不一致，需要核对');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空成功: 平仓 ${closeShortQty} BTC`);
              } else if (action === 'market-sell-short') {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空: 没有找到可平的空头仓位`);
              }
              Object.assign(state.short, createPosState());
              notifyManualTrade(false, state.short);
              delete state.short.pendingOrder;
              saveData();
          }
      } else {
          // 现货模式
          if (action === 'market-sell-short') throw new Error('现货模式不支持平空');
          if (state.long.totalCoinAmount > 0.00001) {
              const sellQty = Math.floor(state.long.totalCoinAmount * 100000) / 100000;
              const id = beginOrder(state.long, 'close', 'manual', { market: config.tradeMode });
              const fill = confirmedFill(await executeRealOrder('SELL', sellQty, null, id));
              if (Math.abs(fill.qty - state.long.totalCoinAmount) > 1e-8) throw new Error('成交数量与清仓数量不一致，需要核对');
              state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动现货清仓成功: 卖出 ${sellQty} BTC`);
          }
          Object.assign(state.long, createPosState());
          notifyManualTrade(true, state.long);
          delete state.long.pendingOrder;
      }
      saveData(); // 手动平仓瞬间保存
    } catch (e) {
      const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('[Override Error] SELL failed:', errorMsg);
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 清仓失败: ${errorMsg}`);
      if (state.long.pendingOrder) rejectOrder(state.long, e);
      if (state.short.pendingOrder) rejectOrder(state.short, e);
      return res.status(502).json({ ok: false, error: errorMsg });
    }
  }
  
  // 立即刷新余额和持仓，确保 UI 状态同步
  await fetchBalances();
  res.json({ ok: true, state });
  } finally {
    botSignalState.isExecuting = false;
  }
});

// ================= WebSocket 后端服务 =================
const WebSocket = require('ws');
const wss = new WebSocket.Server({ noServer: true });

function getFullPayload() {
    let mtfState = '观望';
    try {
        if (mtfModule && typeof mtfModule.getTimeframe === 'function') {
            const row1m = mtfModule.getTimeframe('1');
            if (row1m && row1m.state) mtfState = row1m.state;
        }
    } catch(e){}
    
    const frontendMtfState = {
        state: mtfState,
        deltaUsdt: getDeltaUsdt ? getDeltaUsdt() : 0
    };

    return {
        config,
        state,
        price: getCurrentPrice ? getCurrentPrice() : 0,
        mtfState: frontendMtfState,
        macroVpoc: macroVpocData,
        deltaStream: getDeltaStreamStatus ? getDeltaStreamStatus() : null,
        globalVpoc: getGlobalVpoc ? getGlobalVpoc() : []
    };
}

wss.on('connection', (ws) => {
    // 首次连接，立刻推送一次全量状态
    ws.send(JSON.stringify({
        type: 'init',
        ...getFullPayload()
    }));
});

// 每 2 秒向所有已连接的客户端广播最新状态
setInterval(() => {
    const payload = JSON.stringify({
        type: 'update',
        ...getFullPayload()
    });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 2000);

module.exports = {
  router,
  getConfig: () => config,
  getState: () => state,
  handleUpgrade: (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
      });
  }
};

// 启动后端自动交易引擎 (传入获取状态的 getter)
startBotLoop(module.exports.getConfig, module.exports.getState);
void reconcilePendingOrders();
setInterval(reconcilePendingOrders, 5000);
