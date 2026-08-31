const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const mtfModule = require('./mtfModule');
const regimeModule = require('./regimeModule');

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
  rsiThreshold: 30,
  requireMacd: true,
  signalWindow: 12,
  triggerDelta: true,
  triggerMtf: true,
  deltaThreshold: 2500000,
  dcaAmount: 3000,
  breakevenSl: true,
  autoLoop: false, // 自动循环现货 DCA
  tp1: 50,
  tp2: 30,
  tp3: 20,
  tp1Target: 1.5, // TP1 目标整体收益率 (%)
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
  spotBalanceBtc: 0   // 现货 BTC 余额
};

// 币安现货 API 密钥 (需在环境变量中配置)，加入 trim() 防止不可见换行符或空格干扰
const SPOT_API_KEY = (process.env.BINANCE_SPOT_API_KEY || '').trim();
const SPOT_API_SECRET = (process.env.BINANCE_SPOT_API_SECRET || '').trim();

// 引入全局的代理配置 (复用主程序的代理)
const { httpAgent, httpsAgent } = require('./lib/httpAgents');

// 获取现货账户余额
async function fetchSpotBalance() {
  if (!SPOT_API_KEY || !SPOT_API_SECRET) {
      console.log('[SpotDCA] Missing Binance Spot API keys in .env (BINANCE_SPOT_API_KEY/BINANCE_SPOT_API_SECRET). Using mock balance.');
      state.spotBalanceUsdt = 50000;
      state.spotBalanceBtc = 0.5;
      return;
  }
  try {
    const timestamp = Date.now();
    // 增加 recvWindow 放宽时间戳校验窗口到 60 秒，防止本地服务器时间与币安服务器时间有微小偏差
    const queryString = `recvWindow=60000&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', SPOT_API_SECRET).update(queryString).digest('hex');
    const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;
    
    const res = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': SPOT_API_KEY },
      httpAgent, 
      httpsAgent
    });
    
    if (res.data && res.data.balances) {
      const usdt = res.data.balances.find(b => b.asset === 'USDT');
      const btc = res.data.balances.find(b => b.asset === 'BTC');
      if (usdt) state.spotBalanceUsdt = parseFloat(usdt.free);
      if (btc) state.spotBalanceBtc = parseFloat(btc.free);
      console.log(`[SpotDCA] Balance fetched successfully. USDT: ${state.spotBalanceUsdt}, BTC: ${state.spotBalanceBtc}`);
    }
  } catch (error) {
    if (error.response) {
      // 币安服务器有响应，但返回了错误状态码 (400, 401, 403 等)
      console.error('[SpotDCA] Binance API Error (Server Responded):', error.response.status, error.response.data);
    } else if (error.request) {
      // 请求发出去了，但没收到响应 (通常是网络不通、代理配置错误或超时)
      console.error('[SpotDCA] Network/Proxy Error (No Response):', error.message);
      console.error('[SpotDCA] Request config:', { url: error.config.url, proxy: !!error.config.httpAgent });
    } else {
      console.error('[SpotDCA] Unexpected Error:', error.message);
    }
  }
}

// 启动时和每隔一段时间拉取一次余额
fetchSpotBalance();
setInterval(fetchSpotBalance, 60000);

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

router.post('/override', express.json(), (req, res) => {
  const { action, amount, price } = req.body;
  const logMsg = `[Override] ${action} ${amount || ''} ${price ? '@ ' + price : ''}`;
  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ` + logMsg);
  if (state.logs.length > 20) state.logs.pop();
  
  if (action === 'market-buy' || action === 'limit-buy') {
    state.activeDcaCount++;
    const amt = parseFloat(amount);
    const p = parseFloat(price) || 64230; // fallback mock
    state.totalUsdtAmount += amt;
    state.totalCoinAmount += amt / p;
    state.averagePrice = state.totalUsdtAmount / state.totalCoinAmount;
  } else if (action === 'market-sell') {
    state.activeDcaCount = 0;
    state.totalUsdtAmount = 0;
    state.totalCoinAmount = 0;
    state.averagePrice = 0;
    state.tp1Fired = false;
    state.tp2Fired = false;
    state.tp3Fired = false;
  }
  
  res.json({ ok: true, state });
});

module.exports = {
  router,
  getConfig: () => config,
  getState: () => state
};
