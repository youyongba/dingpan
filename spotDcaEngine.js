const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const dataFile = path.join(__dirname, 'spotDcaData.json');
const mtfModule = require('./mtfModule');
const regimeModule = require('./regimeModule');

const { startBotLoop, executeRealOrder, executeFuturesOrder } = require('./spotAutoBot');

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

try {
    if (fs.existsSync(dataFile)) {
        const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        if (saved.config) config = { ...config, ...saved.config };
        if (saved.botState) {
            state.isLongBotRunning = saved.botState.isLongBotRunning || false;
            state.isShortBotRunning = saved.botState.isShortBotRunning || false;
        }
    }
} catch (e) {
    console.error('[SpotDCA] Load data error:', e);
}

function saveData() {
    try {
        fs.writeFileSync(dataFile, JSON.stringify({
            config,
            botState: { isLongBotRunning: state.isLongBotRunning, isShortBotRunning: state.isShortBotRunning }
        }, null, 2));
    } catch (e) {
        console.error('[SpotDCA] Save data error:', e);
    }
}

const createPosState = () => ({
  activeDcaCount: 0,
  totalCoinAmount: 0,
  totalUsdtAmount: 0,
  averagePrice: 0,
  entryTime: null,
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

// 币安现货 API 密钥 (初始从环境变量读取，如果配置里有则优先使用)
let SPOT_API_KEY = (process.env.BINANCE_SPOT_API_KEY || process.env.BINANCE_API_KEY || '').trim();
let SPOT_API_SECRET = (process.env.BINANCE_SPOT_API_SECRET || process.env.BINANCE_API_SECRET || '').trim();

function refreshApiKeys() {
    if (config.apiKey) SPOT_API_KEY = config.apiKey.trim();
    if (config.apiSecret) SPOT_API_SECRET = config.apiSecret.trim();
}
refreshApiKeys();

// 引入全局的代理配置 (复用主程序的代理)
const { httpAgent, httpsAgent } = require('./lib/httpAgents');

// 获取账户余额 (包含现货与合约)
async function fetchBalances() {
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
        if (config.tradeMode === 'futures') {
            const syncSide = (posSideStr, stateObj) => {
                const active = state.futuresPositions.find(p => p.positionSide === posSideStr);
                if (active) {
                    const apiAvgPrice = active.entryPrice;
                    const apiAmt = Math.abs(active.positionAmt);
                    const localAvgPrice = stateObj.averagePrice || 0;
                    const localAmt = stateObj.totalCoinAmount || 0;
                    
                    if (localAmt < 0.00001 && apiAmt > 0) {
                        stateObj.totalCoinAmount = apiAmt;
                        stateObj.averagePrice = apiAvgPrice;
                        stateObj.entryTime = stateObj.entryTime || Date.now();
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 自动接管(${posSideStr})持仓: ${apiAmt} BTC`);
                    } else if (localAvgPrice > 0 && apiAvgPrice > 0 && Math.abs(apiAvgPrice - localAvgPrice) / localAvgPrice > 0.0005) {
                        stateObj.averagePrice = apiAvgPrice;
                        stateObj.totalCoinAmount = apiAmt;
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 均价漂移修正(${posSideStr}): 同步至 ${apiAvgPrice.toFixed(2)}`);
                    } else if (localAmt > 0 && apiAmt > 0 && Math.abs(apiAmt - localAmt) > 0.0001) {
                        stateObj.totalCoinAmount = apiAmt;
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 仓位数量修正(${posSideStr}): 同步至 ${apiAmt} BTC`);
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
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 远端无持仓，自动清空(${posSideStr})本地状态`);
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
        
        stateObj.totalFees = totalFee;
        if (stateObj.totalCoinAmount > 0) {
            const adjUsdt = !isShort ? (stateObj.totalUsdtAmount + stateObj.totalFees) : (stateObj.totalUsdtAmount - stateObj.totalFees);
            stateObj.averagePrice = adjUsdt / stateObj.totalCoinAmount;
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
  let realIndicators = { rsi15m: null, macd15m: null, mtf1m: null, currentAtr: 0 };
  try {
    if (regimeModule && typeof regimeModule.getState === 'function') {
        const regimeState = regimeModule.getState();
        if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
            const atrArr = regimeState.indicators.atr;
            realIndicators.currentAtr = atrArr[atrArr.length - 1];
        }
        if (regimeState && regimeState.m15) {
            const m15 = regimeState.m15;
            if (m15.rsi && m15.rsi.length > 0) {
                realIndicators.rsi15m = m15.rsi[m15.rsi.length - 1];
            }
            if (m15.macd && m15.signal && m15.macd.length > 0) {
                const macd = m15.macd[m15.macd.length - 1];
                const sig = m15.signal[m15.signal.length - 1];
                realIndicators.macd15m = macd > sig ? 'MACD 金叉 (多头)' : 'MACD 死叉 (空头)';
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

  res.json({
    ok: true,
    config,
    state,
    realIndicators,
    macroVpoc: macroVpocData,
    hasAuthToken: !!CONFIG_AUTH_TOKEN, // 告诉前端服务端是否需要鉴权
    hasApiKeys: !!SPOT_API_KEY && !!SPOT_API_SECRET // 告诉前端是否已经配置了 API Keys
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
  const { level, price } = req.body;
  if (level === 1) state.customTp1Price = price || null;
  if (level === 2) state.customTp2Price = price || null;
  if (level === 3) state.customTp3Price = price || null;
  res.json({ ok: true, state });
});

router.post('/config', express.json(), requireAdmin, (req, res) => {
  config = { ...config, ...req.body };
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
  const { action, amount, price } = req.body;
  const logMsg = `[Override] 强制发起 ${action} ${amount || ''}`;
  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ` + logMsg);
  if (state.logs.length > 20) state.logs.pop();
  
  if (action === 'market-buy' || action === 'market-buy-short') {
    try {
      let amt = parseFloat(amount);
      let executedQty = 0;
      let cumQuote = 0;
      
      if (config.tradeMode === 'futures') {
        if (!amt || amt <= 0) throw new Error('无效的开仓金额');
        const { getCurrentPrice } = require('./spotAutoBot');
        const currentPrice = getCurrentPrice() || 70000; // 使用真实的实时价格
        let qtyToBuy = Math.floor((amt / currentPrice) * 1000) / 1000;
        if (qtyToBuy < 0.001) throw new Error(`数量太小: ${qtyToBuy}`);
        
        const side = action === 'market-buy-short' ? 'SELL' : 'BUY';
        const posSide = action === 'market-buy-short' ? 'SHORT' : 'LONG';
        const orderRes = await executeFuturesOrder(side, qtyToBuy, posSide);
        executedQty = parseFloat(orderRes.executedQty) || qtyToBuy;
        cumQuote = (orderRes.cumQuoteQty && parseFloat(orderRes.cumQuoteQty) > 0) ? parseFloat(orderRes.cumQuoteQty) : (executedQty * currentPrice);
      } else {
        if (action === 'market-buy-short') throw new Error('现货模式不支持做空');
        if (!amt || amt <= 0) throw new Error('无效的买入金额');
        const { executeRealOrder } = require('./spotAutoBot');
        const orderRes = await executeRealOrder('BUY', null, amt);
        executedQty = parseFloat(orderRes.executedQty);
        cumQuote = parseFloat(orderRes.cummulativeQuoteQty);
      }
      
      const isShort = action === 'market-buy-short';
      const targetState = isShort ? state.short : state.long;

      if (targetState.totalCoinAmount < 0.00001) {
          targetState.entryTime = Date.now();
          targetState.totalFees = 0;
      }

      targetState.activeDcaCount++;
      targetState.totalUsdtAmount += cumQuote;
      targetState.totalCoinAmount += executedQty;
      
      const adjUsdt = !isShort ? (targetState.totalUsdtAmount + (targetState.totalFees || 0)) : (targetState.totalUsdtAmount - (targetState.totalFees || 0));
      targetState.averagePrice = targetState.totalCoinAmount > 0 ? (adjUsdt / targetState.totalCoinAmount) : 0;
      
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
      targetState.customTp1Price = null;
      targetState.customTp2Price = null;
      targetState.customTp3Price = null;
      
      const actionName = action === 'market-buy-short' ? '做空' : '买入';
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动${actionName}成功: 获 ${executedQty} BTC`);
    } catch (e) {
      const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('[Override Error] BUY/SELL failed:', errorMsg);
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 开仓失败: ${errorMsg}`);
    }
  } else if (action === 'market-sell-long' || action === 'market-sell-short' || action === 'market-sell') {
    try {
      if (config.tradeMode === 'futures') {
          // 使用内存中同步的精准仓位数据
          if (action === 'market-sell-long' || action === 'market-sell') {
              if (state.long.totalCoinAmount > 0.00001) {
                  const closeLongQty = Math.floor(state.long.totalCoinAmount * 1000) / 1000;
                  await executeFuturesOrder('SELL', closeLongQty, 'LONG');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多成功: 平仓 ${closeLongQty} BTC`);
              } else if (action === 'market-sell-long') {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多: 没有找到可平的多头仓位`);
              }
              Object.assign(state.long, createPosState());
          }
          
          if (action === 'market-sell-short' || action === 'market-sell') {
              if (state.short.totalCoinAmount > 0.00001) {
                  const closeShortQty = Math.floor(state.short.totalCoinAmount * 1000) / 1000;
                  await executeFuturesOrder('BUY', closeShortQty, 'SHORT');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空成功: 平仓 ${closeShortQty} BTC`);
              } else if (action === 'market-sell-short') {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空: 没有找到可平的空头仓位`);
              }
              Object.assign(state.short, createPosState());
          }
      } else {
          // 现货模式
          if (action === 'market-sell-short') throw new Error('现货模式不支持平空');
          if (state.long.totalCoinAmount > 0.00001) {
              const sellQty = Math.floor(state.long.totalCoinAmount * 100000) / 100000;
              await executeRealOrder('SELL', sellQty, null);
              state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动现货清仓成功: 卖出 ${sellQty} BTC`);
          }
          Object.assign(state.long, createPosState());
      }
    } catch (e) {
      const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('[Override Error] SELL failed:', errorMsg);
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 清仓失败: ${errorMsg}`);
    }
  }
  
  // 立即刷新余额和持仓，确保 UI 状态同步
  await fetchBalances();
  res.json({ ok: true, state });
});

module.exports = {
  router,
  getConfig: () => config,
  getState: () => state
};

// 启动后端自动交易引擎 (传入获取状态的 getter)
startBotLoop(module.exports.getConfig, module.exports.getState);
