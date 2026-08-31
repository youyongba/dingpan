const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

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
  tp3: 20
};

let state = {
  activeDcaCount: 0,
  totalCoinAmount: 0,
  totalUsdtAmount: 0,
  averagePrice: 0,
  tp1Fired: false,
  tp2Fired: false,
  tp3Fired: false,
  slMoved: false,
  logs: [],
  enabled: true,
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

router.get('/status', (req, res) => {
  res.json({
    ok: true,
    config,
    state
  });
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
