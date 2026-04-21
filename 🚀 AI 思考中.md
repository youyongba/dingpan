🚀 AI 思考中...

下面是一套**完整、独立、不影响原有逻辑**的宏观 Regime 判断模块，可直接挂载到现有 `server.js` 上。所有新增代码都封装在 `regimeModule.js` 中，对外暴露一个 Express `Router`，前端放在 `public/regime.html`，访问 `/regime.html` 即可。

---

## 📁 项目结构（新增/改动部分）

```
📁 public/
  📄 regime.html        ← 新增，独立前端页面
📄 regimeModule.js      ← 新增/重写，独立模块
📄 server.js            ← 仅新增 2 行挂载代码
📄 package.json         ← 确认依赖
📄 .env                 ← 无需新增变量
```

---

## 1️⃣ `package.json`（确认依赖）

```json
{
  "name": "btc-regime",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  }
}
```

---

## 2️⃣ `regimeModule.js`（核心独立模块）

```js
/**
 * ============================================================
 *  regimeModule.js
 *  宏观市场状态（Regime）独立判定模块
 *  - 拉取 Binance USDT 永续合约 BTCUSDT 1h K线
 *  - 计算 ATR / ADX / +DI / -DI / HV / ROC / Slope
 *  - 输出 Regime：趋势 / 震荡 / 恐慌 / 中性
 *  - 与原有业务完全解耦：只对外暴露一个 Express Router
 * ============================================================
 */
const express = require('express');
const axios = require('axios');

const router = express.Router();

// ---------------------- 配置 ----------------------
const BINANCE_FAPI = 'https://fapi.binance.com';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const LIMIT = 500;                 // 拉取 500 根K线
const REFRESH_MS = 5 * 60 * 1000;  // 5 分钟刷新一次
const TIMEOUT = Number(process.env.BINANCE_TIMEOUT_MS || 10000);

// 内存缓存
let cache = {
  updatedAt: 0,
  klines: [],
  indicators: null,
  regime: null,
  error: null,
};

// ---------------------- 工具函数 ----------------------
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * Wilder 平滑（RMA）：TR/ATR/ADX 常用平滑
 */
function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

// ---------------------- 指标计算 ----------------------
/**
 * 计算 ATR(14)
 */
function computeATR(h, l, c, period = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  return wilderSmooth(tr, period);
}

/**
 * 计算 ADX / +DI / -DI (14)
 */
function computeADX(h, l, c, period = 14) {
  const len = c.length;
  const tr = [0], plusDM = [0], minusDM = [0];
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  const atr = wilderSmooth(tr, period);
  const pDM = wilderSmooth(plusDM, period);
  const mDM = wilderSmooth(minusDM, period);

  const plusDI = atr.map((a, i) => a ? 100 * pDM[i] / a : null);
  const minusDI = atr.map((a, i) => a ? 100 * mDM[i] / a : null);
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || (p + m) === 0) return null;
    return 100 * Math.abs(p - m) / (p + m);
  });

  // ADX = Wilder 平滑 dx
  const validDX = dx.map(v => v == null ? 0 : v);
  const adx = wilderSmooth(validDX, period).map((v, i) => dx[i] == null ? null : v);

  return { adx, plusDI, minusDI };
}

/**
 * 历史波动率 HV (替代 VIX)
 * 标准：sqrt(252) * std(log return) * 100，窗口默认 24（1 天，1h K线）
 */
function computeHV(close, window = 24) {
  const logRet = [null];
  for (let i = 1; i < close.length; i++) {
    logRet.push(Math.log(close[i] / close[i - 1]));
  }
  const out = new Array(close.length).fill(null);
  for (let i = window; i < close.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1);
    const m = mean(slice);
    const variance = mean(slice.map(x => (x - m) ** 2));
    // 年化：1h K线，一年约 24*365 根
    out[i] = Math.sqrt(variance) * Math.sqrt(24 * 365) * 100;
  }
  return out;
}

/**
 * ROC(14) 价格变化率
 */
function computeROC(close, period = 14) {
  const out = new Array(close.length).fill(null);
  for (let i = period; i < close.length; i++) {
    out[i] = ((close[i] - close[i - period]) / close[i - period]) * 100;
  }
  return out;
}

/**
 * Slope 斜率（最近 N 根的最小二乘回归斜率，反映加速度）
 */
function computeSlope(close, window = 14) {
  const out = new Array(close.length).fill(null);
  for (let i = window - 1; i < close.length; i++) {
    const ys = close.slice(i - window + 1, i + 1);
    const n = ys.length;
    const xs = Array.from({ length: n }, (_, k) => k);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) {
      num += (xs[k] - mx) * (ys[k] - my);
      den += (xs[k] - mx) ** 2;
    }
    out[i] = den === 0 ? 0 : num / den;
  }
  return out;
}

// ---------------------- Regime 判定 ----------------------
/**
 * 规则：
 *  - 趋势市：ADX > 25 且 HV 处于中高分位
 *  - 震荡市：ADX < 20 且 HV 处于中低分位
 *  - 恐慌市：HV 处于高位 且 ADX < 25（强波动但无方向）
 *  - 中性市：其余
 */
function judgeRegime(ind) {
  const lastIdx = ind.adx.length - 1;
  const adx = ind.adx[lastIdx];
  const plusDI = ind.plusDI[lastIdx];
  const minusDI = ind.minusDI[lastIdx];
  const hv = ind.hv[lastIdx];

  // 以最近 100 根 HV 的分位数判断高低波
  const hvSlice = ind.hv.slice(-100).filter(v => v != null).sort((a, b) => a - b);
  const q = p => hvSlice[Math.floor(hvSlice.length * p)] ?? hv;
  const hvHigh = q(0.7);
  const hvLow = q(0.3);

  let regime = 'NEUTRAL';
  let label = '中性市';
  let color = '#999';
  let desc = '市场无明显特征';

  if (hv >= hvHigh && adx < 25) {
    regime = 'PANIC'; label = '恐慌市'; color = '#e74c3c';
    desc = '高波动 + 弱趋势：注意风险，谨慎交易';
  } else if (adx > 25 && hv >= hvLow) {
    regime = 'TREND'; label = '趋势市'; color = '#27ae60';
    desc = `趋势强劲（${plusDI > minusDI ? '多头' : '空头'}），可顺势`;
  } else if (adx < 20 && hv <= hvHigh) {
    regime = 'RANGE'; label = '震荡市'; color = '#3498db';
    desc = '低波动 + 弱趋势：适合区间/网格策略';
  }

  return {
    regime, label, color, desc,
    metrics: {
      adx: +adx?.toFixed(2),
      plusDI: +plusDI?.toFixed(2),
      minusDI: +minusDI?.toFixed(2),
      hv: +hv?.toFixed(2),
      hvHigh: +hvHigh?.toFixed(2),
      hvLow: +hvLow?.toFixed(2),
    }
  };
}

// ---------------------- 数据拉取 ----------------------
async function fetchKlines() {
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: SYMBOL, interval: INTERVAL, limit: LIMIT },
    timeout: TIMEOUT,
  });
  return data.map(k => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

async function refresh() {
  try {
    const klines = await fetchKlines();
    const h = klines.map(k => k.high);
    const l = klines.map(k => k.low);
    const c = klines.map(k => k.close);

    const atr = computeATR(h, l, c, 14);
    const { adx, plusDI, minusDI } = computeADX(h, l, c, 14);
    const hv = computeHV(c, 24);
    const roc = computeROC(c, 14);
    const slope = computeSlope(c, 14);

    const indicators = { atr, adx, plusDI, minusDI, hv, roc, slope };
    const regime = judgeRegime(indicators);

    cache = {
      updatedAt: Date.now(),
      klines,
      indicators,
      regime,
      error: null,
    };
    console.log(`[regime] refreshed @ ${new Date().toISOString()} -> ${regime.label}`);
  } catch (err) {
    cache.error = err.message;
    console.error('[regime] refresh failed:', err.message);
  }
}

// 启动即拉取，并定时刷新
refresh();
setInterval(refresh, REFRESH_MS);

// ---------------------- 路由 ----------------------
router.get('/status', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    updatedAt: cache.updatedAt,
    regime: cache.regime,
  });
});

router.get('/data', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    updatedAt: cache.updatedAt,
    regime: cache.regime,
    klines: cache.klines,
    indicators: cache.indicators,
  });
});

module.exports = router;
```

---

## 3️⃣ `server.js`（仅新增 2 行，不动原有逻辑）

在现有 `server.js` 里找到 Express 初始化处，加上：

```js
// ========== 新增：宏观 Regime 独立模块 ==========
const regimeRouter = require('./regimeModule');
app.use('/api/regime', regimeRouter);
// ===============================================
```

如果你项目里还没有 `server.js`，这里给一份最简可运行版（不影响你现在的代码，仅供参考）：

```js
require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 你原有的业务路由...
// app.use('/api/xxx', xxxRouter);

// 新增：宏观 Regime 独立模块
const regimeRouter = require('./regimeModule');
app.use('/api/regime', regimeRouter);

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
```

---

## 4️⃣ `public/regime.html`（独立前端页面）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>BTC 宏观 Regime 监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background:#0e1117; color:#e6e6e6; margin:0; padding:20px; }
  h1 { margin:0 0 10px; font-size:20px; }
  .bar { display:flex; align-items:center; gap:16px; margin-bottom:20px; flex-wrap:wrap;}
  .tag { padding:8px 16px; border-radius:6px; color:#fff; font-weight:bold; font-size:16px;}
  .metrics { font-size:13px; color:#aaa; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(480px,1fr)); gap:16px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:12px; }
  .card h3 { margin:0 0 8px; font-size:14px; color:#8b949e;}
  canvas { width:100% !important; height:220px !important; }
  .updated { font-size:12px; color:#666; margin-left:auto;}
</style>
</head>
<body>

<h1>BTC/USDT 宏观市场状态监控 (1H)</h1>

<div class="bar">
  <div id="regimeTag" class="tag" style="background:#555;">加载中...</div>
  <div id="regimeDesc" class="metrics"></div>
  <div id="metrics" class="metrics"></div>
  <div id="updated" class="updated"></div>
</div>

<div class="grid">
  <div class="card"><h3>BTC 收盘价</h3><canvas id="priceChart"></canvas></div>
  <div class="card"><h3>ATR(14)</h3><canvas id="atrChart"></canvas></div>
  <div class="card"><h3>ADX / +DI / -DI</h3><canvas id="adxChart"></canvas></div>
  <div class="card"><h3>历史波动率 HV (类 VIX)</h3><canvas id="hvChart"></canvas></div>
  <div class="card"><h3>ROC(14)</h3><canvas id="rocChart"></canvas></div>
  <div class="card"><h3>Slope 价格斜率</h3><canvas id="slopeChart"></canvas></div>
</div>

<script>
const charts = {};
function mkChart(id, datasets, labels) {
  if (charts[id]) { charts[id].data.labels = labels; charts[id].data.datasets = datasets; charts[id].update(); return; }
  charts[id] = new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels, datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color:'#ccc' } } },
      scales: {
        x: { ticks: { color:'#666', maxTicksLimit: 8 }, grid:{ color:'#222' } },
        y: { ticks: { color:'#999' }, grid:{ color:'#222' } },
      },
      elements: { point: { radius: 0 } }
    }
  });
}

async function load() {
  try {
    const res = await fetch('/api/regime/data');
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);

    const { klines, indicators, regime, updatedAt } = json;
    const labels = klines.map(k => new Date(k.time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit'}));
    const close = klines.map(k => k.close);

    // 顶部标签
    const tag = document.getElementById('regimeTag');
    tag.textContent = regime.label + ' (' + regime.regime + ')';
    tag.style.background = regime.color;
    document.getElementById('regimeDesc').textContent = regime.desc;
    document.getElementById('metrics').textContent =
      `ADX=${regime.metrics.adx} +DI=${regime.metrics.plusDI} -DI=${regime.metrics.minusDI} HV=${regime.metrics.hv}`;
    document.getElementById('updated').textContent = '更新: ' + new Date(updatedAt).toLocaleString();

    // 图表
    mkChart('priceChart', [{ label:'Close', data: close, borderColor:'#f0b90b', borderWidth:1.2 }], labels);
    mkChart('atrChart',   [{ label:'ATR', data: indicators.atr, borderColor:'#e67e22', borderWidth:1.2 }], labels);
    mkChart('adxChart', [
      { label:'ADX',  data: indicators.adx,    borderColor:'#ffffff', borderWidth:1.2 },
      { label:'+DI',  data: indicators.plusDI, borderColor:'#27ae60', borderWidth:1 },
      { label:'-DI',  data: indicators.minusDI,borderColor:'#e74c3c', borderWidth:1 },
    ], labels);
    mkChart('hvChart',    [{ label:'HV%', data: indicators.hv,    borderColor:'#9b59b6', borderWidth:1.2 }], labels);
    mkChart('rocChart',   [{ label:'ROC%',data: indicators.roc,   borderColor:'#3498db', borderWidth:1.2 }], labels);
    mkChart('slopeChart', [{ label:'Slope',data: indicators.slope,borderColor:'#1abc9c', borderWidth:1.2 }], labels);

  } catch (e) {
    console.error(e);
    document.getElementById('regimeTag').textContent = '加载失败: ' + e.message;
  }
}

load();
setInterval(load, 60 * 1000); // 前端每分钟刷新一次
</script>
</body>
</html>
```

---

## 5️⃣ 运行步骤

```bash
# 1. 安装依赖
npm install express axios dotenv

# 2. 启动（不需要额外环境变量，BINANCE_TIMEOUT_MS 可复用你 .env 里的）
node server.js

# 3. 浏览器访问
http://localhost:3001/regime.html        # 前端可视化
http://localhost:3001/api/regime/status  # 仅返回当前 regime
http://localhost:3001/api/regime/data    # 返回完整 K线+指标+regime
```

---

## ⚠️ 顺带安全提醒

我注意到你贴出的 `.env` 中 `FEISHU_APP_SECRET=ouYoFfNmCN7UsJKpHkpubeXMWJVbUFVU` **仍然是泄露过的那一串旧 secret**，而上面注释明确写了"立即 revoke"。请务必：

1. 去 https://open.feishu.cn/app 重置该 App Secret
2. 把 `.env` 加入 `.gitignore`（看你项目里已有 `.gitignore`，确认 `.env` 在其中）
3. 用 `git filter-repo` 或 BFG 清理历史提交里的旧值，否则别人 clone 历史版本照样能拿到。

---

## ✅ 模块独立性保证

- 所有新增逻辑都在 `regimeModule.js` 里，通过独立的 `/api/regime/*` 前缀挂载
- 不读写任何原有变量，不改动原有路由
- 内存缓存，不依赖数据库
- 定时刷新（后端 5 分钟 / 前端 1 分钟轮询）
- 原有飞书推送、`/api/reset` 等功能完全不受影响

✅ **流式输出完成**
