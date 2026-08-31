const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const mtfModule = require('./mtfModule');
const regimeModule = require('./regimeModule');

const { startBotLoop, executeRealOrder } = require('./spotAutoBot');

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

let config = {
  tradeMode: 'spot', // 'spot' or 'futures'
  tradeDirection: 'long', // 'long' or 'short' (永续合约专属)
  leverage: 100,
  positionSizePct: 3.0,
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
  tp3Target: 5.0
};

let state = {
  activeDcaCount: 0,
  totalCoinAmount: 0,
  totalUsdtAmount: 0,
  averagePrice: 0,
  tp1Fired: false,
  tp2Fired: false,
  tp3Fired: false,
  customTp1Price: null, // 自定义 TP1 价格 (覆盖默认比例)
  customTp2Price: null,
  customTp3Price: null,
  slMoved: false,
  logs: [],
  enabled: true,
  isBotRunning: false, // 机器人主开关
  spotBalanceUsdt: 0, // 现货 USDT 余额
  spotBalanceBtc: 0,   // 现货 BTC 余额
  futuresBalanceUsdt: 0 // 永续合约 USDT 余额
};

// 币安现货 API 密钥 (需在环境变量中配置)，加入 trim() 防止不可见换行符或空格干扰
const SPOT_API_KEY = (process.env.BINANCE_SPOT_API_KEY || process.env.BINANCE_API_KEY || '').trim();
const SPOT_API_SECRET = (process.env.BINANCE_SPOT_API_SECRET || process.env.BINANCE_API_SECRET || '').trim();

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
  } catch (error) {
    console.error('[SpotDCA] Futures Balance Error:', error.message);
  }
}

// 启动时和每隔一段时间拉取一次余额
fetchBalances();
setInterval(fetchBalances, 60000);

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
  let realIndicators = { rsi15m: null, macd15m: null, mtf1m: null };
  try {
    if (regimeModule && typeof regimeModule.getState === 'function') {
        const regimeState = regimeModule.getState();
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
    macroVpoc: macroVpocData
  });
});

router.post('/toggle-bot', express.json(), (req, res) => {
  state.isBotRunning = !state.isBotRunning;
  res.json({ ok: true, isBotRunning: state.isBotRunning });
});

router.post('/custom-tp', express.json(), (req, res) => {
  const { level, price } = req.body;
  if (level === 1) state.customTp1Price = price || null;
  if (level === 2) state.customTp2Price = price || null;
  if (level === 3) state.customTp3Price = price || null;
  res.json({ ok: true, state });
});

router.post('/config', express.json(), (req, res) => {
  config = { ...config, ...req.body };
  res.json({ ok: true, config });
});

router.post('/override', express.json(), async (req, res) => {
  const { action, amount, price } = req.body;
  const logMsg = `[Override] 强制发起 ${action} ${amount || ''}`;
  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ` + logMsg);
  if (state.logs.length > 20) state.logs.pop();
  
  if (action === 'market-buy') {
    try {
      let amt = parseFloat(amount);
      let executedQty = 0;
      let cumQuote = 0;
      
      if (config.tradeMode === 'futures') {
        // override amount 为 U。但在永续中，通常 amount 代表 USDT
        // 手动干预如果填了 3000，意思是拿 3000 保证金吗？还是合约名义价值？
        // 假设 amount 框里填写的是“名义价值(U)”，方便和现货统一。
        if (!amt || amt <= 0) throw new Error('无效的买入金额');
        const { executeFuturesOrder } = require('./spotAutoBot');
        const currentPrice = state.averagePrice > 0 ? state.averagePrice : 60000; // 粗略 fallback
        let qtyToBuy = Math.floor((amt / currentPrice) * 1000) / 1000;
        if (qtyToBuy < 0.001) throw new Error(`数量太小: ${qtyToBuy}`);
        
        const orderRes = await executeFuturesOrder('BUY', qtyToBuy);
        executedQty = parseFloat(orderRes.executedQty || qtyToBuy);
        cumQuote = orderRes.cumQuoteQty ? parseFloat(orderRes.cumQuoteQty) : executedQty * currentPrice;
      } else {
        if (!amt || amt <= 0) throw new Error('无效的买入金额');
        const { executeRealOrder } = require('./spotAutoBot');
        const orderRes = await executeRealOrder('BUY', null, amt);
        executedQty = parseFloat(orderRes.executedQty);
        cumQuote = parseFloat(orderRes.cummulativeQuoteQty);
      }
      
      state.activeDcaCount++;
      state.totalUsdtAmount += cumQuote;
      state.totalCoinAmount += executedQty;
      state.averagePrice = state.totalUsdtAmount / state.totalCoinAmount;
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动买入成功: 获 ${executedQty} BTC`);
    } catch (e) {
      const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('[Override Error] BUY failed:', errorMsg);
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 买入失败: ${errorMsg}`);
    }
  } else if (action === 'market-sell') {
    try {
      if (state.totalCoinAmount > 0.00001) {
        if (config.tradeMode === 'futures') {
            const sellQty = Math.floor(state.totalCoinAmount * 1000) / 1000;
            const { executeFuturesOrder } = require('./spotAutoBot');
            await executeFuturesOrder('SELL', sellQty);
            state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动合约清仓成功: 卖出 ${sellQty} BTC`);
        } else {
            // 向下取整精度，防止卖出超额
            const sellQty = Math.floor(state.totalCoinAmount * 100000) / 100000;
            const { executeRealOrder } = require('./spotAutoBot');
            await executeRealOrder('SELL', sellQty, null);
            state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动现货清仓成功: 卖出 ${sellQty} BTC`);
        }
      }
      state.activeDcaCount = 0;
      state.totalUsdtAmount = 0;
      state.totalCoinAmount = 0;
      state.averagePrice = 0;
      state.tp1Fired = false;
      state.tp2Fired = false;
      state.tp3Fired = false;
    } catch (e) {
      const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
      console.error('[Override Error] SELL failed:', errorMsg);
      state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 清仓失败: ${errorMsg}`);
    }
  }
  
  res.json({ ok: true, state });
});

module.exports = {
  router,
  getConfig: () => config,
  getState: () => state
};

// 启动后端自动交易引擎 (传入获取状态的 getter)
startBotLoop(module.exports.getConfig, module.exports.getState);
