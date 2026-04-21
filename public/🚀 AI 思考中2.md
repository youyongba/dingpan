🚀 AI 思考中...

# BTC 宏观市场状态（Regime）盯盘模块

下面是完整、独立、可直接运行的项目代码。新增功能通过独立模块 `regimeModule.js` + 独立路由 `/api/regime` + 独立前端页面 `public/regime.html` 实现，**不影响现有文件与接口**。

---

## 📁 项目结构

```
📁 public/
  📄 index.html      （原有，保持不变）
  📄 regime.html     （✨ 新增：宏观状态盯盘页面）
  📄 regime.js       （✨ 新增：前端图表逻辑）
  📄 script.js
  📄 style.css
📄 regimeModule.js   （✨ 新增/替换：独立指标 & Regime 模块）
📄 server.js         （在原有基础上 append 新路由）
📄 package.json
```

---

## 1. `package.json`

```json
{
  "name": "btc-regime-monitor",
  "version": "1.0.0",
  "description": "BTCUSDT 宏观市场状态（Regime）盯盘模块",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
```

---

## 2. `regimeModule.js` — 独立指标与 Regime 判断模块

```js
/**
 * regimeModule.js
 * -----------------------------------------------------------
 * 独立模块：
 *   - 拉取币安 USDT 永续合约 BTCUSDT 1h K线
 *   - 计算 ATR(14) / ADX(14),+DI,-DI / HV / ROC(14) / Slope
 *   - 判断宏观市场状态 regime（trend / range / panic / neutral）
 * 特点：
 *   - 纯函数式实现，零副作用
 *   - 与项目任何已有逻辑互不干扰
 * -----------------------------------------------------------
 */
const axios = require('axios');

const BINANCE_FAPI = 'https://fapi.binance.com';

/* ---------------- 1. 数据获取 ---------------- */
async function fetchKlines(symbol = 'BTCUSDT', interval = '1h', limit = 500) {
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol, interval, limit },
    timeout: 15000,
  });
  // 每根K线: [openTime, open, high, low, close, volume, ...]
  return data.map(k => ({
    t: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

/* ---------------- 2. 基础指标 ---------------- */

// Wilder 平滑（Wilder's smoothing / RMA）
function wilderSmooth(arr, period) {
  const out = new Array(arr.length).fill(null);
  if (arr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + arr[i]) / period;
  }
  return out;
}

// ATR(14)
function calcATR(klines, period = 14) {
  const tr = klines.map((k, i) => {
    if (i === 0) return k.high - k.low;
    const prevClose = klines[i - 1].close;
    return Math.max(
      k.high - k.low,
      Math.abs(k.high - prevClose),
      Math.abs(k.low - prevClose)
    );
  });
  return wilderSmooth(tr, period);
}

// ADX / +DI / -DI
function calcADX(klines, period = 14) {
  const len = klines.length;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;

    const prevClose = klines[i - 1].close;
    tr[i] = Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - prevClose),
      Math.abs(klines[i].low - prevClose)
    );
  }

  const atr = wilderSmooth(tr.slice(1), period);
  const plusDMSmooth = wilderSmooth(plusDM.slice(1), period);
  const minusDMSmooth = wilderSmooth(minusDM.slice(1), period);

  const plusDI = atr.map((v, i) =>
    v && plusDMSmooth[i] != null ? (plusDMSmooth[i] / v) * 100 : null
  );
  const minusDI = atr.map((v, i) =>
    v && minusDMSmooth[i] != null ? (minusDMSmooth[i] / v) * 100 : null
  );

  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || p + m === 0) return null;
    return (Math.abs(p - m) / (p + m)) * 100;
  });

  const validDX = dx.filter(v => v != null);
  const adxSmoothed = wilderSmooth(validDX, period);

  // 对齐原数组长度（前部填 null）
  const pad = len - adxSmoothed.length;
  const adx = new Array(pad).fill(null).concat(adxSmoothed);
  const plusDIAligned = new Array(len - plusDI.length).fill(null).concat(plusDI);
  const minusDIAligned = new Array(len - minusDI.length).fill(null).concat(minusDI);

  return { adx, plusDI: plusDIAligned, minusDI: minusDIAligned };
}

// 历史波动率 HV（对数收益率年化标准差, 以百分比表示，类 VIX）
function calcHV(klines, period = 20, annualize = 24 * 365) {
  const logRet = klines.map((k, i) =>
    i === 0 ? 0 : Math.log(k.close / klines[i - 1].close)
  );
  const out = new Array(klines.length).fill(null);
  for (let i = period; i < klines.length; i++) {
    const slice = logRet.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance =
      slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (period - 1);
    out[i] = Math.sqrt(variance) * Math.sqrt(annualize) * 100;
  }
  return out;
}

// ROC(14) 波动速率 (%)
function calcROC(klines, period = 14) {
  return klines.map((k, i) =>
    i < period ? null : ((k.close - klines[i - period].close) / klines[i - period].close) * 100
  );
}

// 价格斜率（最近 N 根的线性回归斜率，归一化为 %/bar）
function calcSlope(klines, period = 14) {
  const out = new Array(klines.length).fill(null);
  for (let i = period - 1; i < klines.length; i++) {
    const ys = klines.slice(i - period + 1, i + 1).map(k => k.close);
    const n = ys.length;
    const xs = Array.from({ length: n }, (_, j) => j);
    const meanX = (n - 1) / 2;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let j = 0; j < n; j++) {
      num += (xs[j] - meanX) * (ys[j] - meanY);
      den += (xs[j] - meanX) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    out[i] = (slope / meanY) * 100; // 归一化：每根K线的百分比变化
  }
  return out;
}

/* ---------------- 3. Regime 判定 ---------------- */
/**
 * 规则：
 *   - 趋势市 trend : ADX > 25 且 高波动
 *   - 震荡市 range : ADX < 20 且 低波动
 *   - 恐慌市 panic : 高波动 且 弱趋势 (ADX < 20)
 *   - 中性市 neutral : 其余
 * 高/低波动通过 HV 相对其近 N 期中位数判断
 */
function judgeRegime({ adx, hv }) {
  const last = arr => arr[arr.length - 1];
  const curAdx = last(adx);
  const curHv = last(hv);

  const hvValid = hv.filter(v => v != null).slice(-100);
  const sorted = [...hvValid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const highVol = curHv > median * 1.1;
  const lowVol = curHv < median * 0.9;

  let regime = 'neutral';
  let reason = '';
  if (curAdx > 25 && highVol) {
    regime = 'trend';
    reason = 'ADX>25 且 HV 处于高波动区';
  } else if (curAdx < 20 && lowVol) {
    regime = 'range';
    reason = 'ADX<20 且 HV 低波动';
  } else if (highVol && curAdx < 20) {
    regime = 'panic';
    reason = '高波动 + 弱趋势';
  } else {
    regime = 'neutral';
    reason = '未触发极值条件';
  }

  return {
    regime,
    reason,
    metrics: {
      adx: +curAdx?.toFixed(2),
      hv: +curHv?.toFixed(2),
      hvMedian: +median.toFixed(2),
    },
  };
}

/* ---------------- 4. 对外主函数 ---------------- */
async function computeRegimeSnapshot(symbol = 'BTCUSDT', interval = '1h', limit = 500) {
  const klines = await fetchKlines(symbol, interval, limit);

  const atr = calcATR(klines, 14);
  const { adx, plusDI, minusDI } = calcADX(klines, 14);
  const hv = calcHV(klines, 20);
  const roc = calcROC(klines, 14);
  const slope = calcSlope(klines, 14);

  const regime = judgeRegime({ adx, hv });

  return {
    symbol,
    interval,
    updatedAt: Date.now(),
    regime,
    series: {
      time: klines.map(k => k.t),
      ohlc: klines.map(k => [k.open, k.high, k.low, k.close]),
      close: klines.map(k => k.close),
      atr,
      adx,
      plusDI,
      minusDI,
      hv,
      roc,
      slope,
    },
  };
}

module.exports = {
  computeRegimeSnapshot,
  fetchKlines,
  calcATR,
  calcADX,
  calcHV,
  calcROC,
  calcSlope,
  judgeRegime,
};
```

---

## 3. `server.js` — 追加独立路由（不动原有逻辑）

> 如果你已有 `server.js`，只需把下面 **标注的新增部分** 追加进去即可。以下给出**完整可运行示例**：

```js
/**
 * server.js
 * 保留原有路由/逻辑，仅 "追加" 独立 Regime 模块相关内容。
 */
const express = require('express');
const path = require('path');
const { computeRegimeSnapshot } = require('./regimeModule');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

/* ======================================================
 *                原有路由占位 (保持不变)
 * ====================================================== */
// app.get('/api/xxx', ...);    // 你原来的接口保留

/* ======================================================
 *          ✨ 新增独立模块：Regime 宏观市场状态
 * ====================================================== */

// 内存缓存：避免频繁请求币安
let regimeCache = { data: null, ts: 0 };
const CACHE_MS = 60 * 1000; // 1 分钟

async function refreshRegime() {
  try {
    const snap = await computeRegimeSnapshot('BTCUSDT', '1h', 500);
    regimeCache = { data: snap, ts: Date.now() };
    console.log(`[Regime] 更新成功 regime=${snap.regime.regime} adx=${snap.regime.metrics.adx} hv=${snap.regime.metrics.hv}`);
  } catch (e) {
    console.error('[Regime] 更新失败:', e.message);
  }
}

// API：获取完整 Regime 数据
app.get('/api/regime', async (req, res) => {
  try {
    if (!regimeCache.data || Date.now() - regimeCache.ts > CACHE_MS) {
      await refreshRegime();
    }
    if (!regimeCache.data) return res.status(503).json({ error: 'no data yet' });
    res.json(regimeCache.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 定时自动更新（独立，不影响原有定时任务）
setInterval(refreshRegime, CACHE_MS);
refreshRegime();

/* ====================================================== */

app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
  console.log(`   Regime 页面:     http://localhost:${PORT}/regime.html`);
});
```

---

## 4. `public/regime.html` — 新增前端页面（独立，不改原 index.html）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>BTC 宏观市场状态 Regime 盯盘</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  body { background:#0e1116; color:#e6e6e6; font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:24px; }
  h1 { margin:0 0 12px; }
  .badge { display:inline-block; padding:6px 14px; border-radius:20px; font-weight:700; margin-left:8px; }
  .trend  { background:#1f8a3a; }
  .range  { background:#555; }
  .panic  { background:#c0392b; }
  .neutral{ background:#2c3e50; }
  .meta { color:#aaa; margin:8px 0 20px; }
  .grid { display:grid; grid-template-columns:repeat(2,1fr); gap:16px; }
  .card { background:#161b22; border:1px solid #222; border-radius:10px; padding:14px; }
  .card h3 { margin:0 0 10px; font-size:14px; color:#9fb3c8; }
  canvas { width:100% !important; height:260px !important; }
  @media (max-width: 900px){ .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
  <h1>BTC 宏观市场状态
    <span id="regimeBadge" class="badge neutral">--</span>
  </h1>
  <div class="meta">
    <span id="reason">加载中...</span>　|　
    ADX: <b id="mAdx">-</b>　
    HV: <b id="mHv">-</b>　
    HV中位数: <b id="mHvMed">-</b>　
    更新时间: <span id="upd">-</span>
  </div>

  <div class="grid">
    <div class="card"><h3>BTC 收盘价 (K 线收盘)</h3><canvas id="chPrice"></canvas></div>
    <div class="card"><h3>ATR(14)</h3><canvas id="chAtr"></canvas></div>
    <div class="card"><h3>ADX(14) / +DI / -DI</h3><canvas id="chAdx"></canvas></div>
    <div class="card"><h3>HV 历史波动率 (类 VIX)</h3><canvas id="chHv"></canvas></div>
    <div class="card"><h3>ROC(14) 波动速率 (%)</h3><canvas id="chRoc"></canvas></div>
    <div class="card"><h3>Slope 价格斜率 (%/bar)</h3><canvas id="chSlope"></canvas></div>
  </div>

  <script src="regime.js"></script>
</body>
</html>
```

---

## 5. `public/regime.js` — Chart.js 渲染逻辑

```js
/* 独立前端脚本：不影响原 script.js */
const charts = {};

function mkChart(id, labels, datasets, opts = {}) {
  const ctx = document.getElementById(id);
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#ccc' } } },
      scales: {
        x: { ticks: { color: '#888', maxTicksLimit: 8 }, grid: { color: '#222' } },
        y: { ticks: { color: '#888' }, grid: { color: '#222' } },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.4, tension: 0.15 } },
      ...opts,
    },
  });
}

async function refresh() {
  try {
    const res = await fetch('/api/regime');
    const data = await res.json();
    const s = data.series;

    // Header
    const badge = document.getElementById('regimeBadge');
    badge.className = 'badge ' + data.regime.regime;
    badge.textContent = {
      trend: '趋势市 TREND',
      range: '震荡市 RANGE',
      panic: '恐慌市 PANIC',
      neutral: '中性市 NEUTRAL',
    }[data.regime.regime];
    document.getElementById('reason').textContent = data.regime.reason;
    document.getElementById('mAdx').textContent = data.regime.metrics.adx ?? '-';
    document.getElementById('mHv').textContent = data.regime.metrics.hv ?? '-';
    document.getElementById('mHvMed').textContent = data.regime.metrics.hvMedian ?? '-';
    document.getElementById('upd').textContent = new Date(data.updatedAt).toLocaleTimeString();

    const labels = s.time.map(t => {
      const d = new Date(t);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
    });

    mkChart('chPrice', labels, [
      { label: 'Close', data: s.close, borderColor: '#f0b90b', backgroundColor: 'rgba(240,185,11,.1)', fill: true },
    ]);

    mkChart('chAtr', labels, [
      { label: 'ATR(14)', data: s.atr, borderColor: '#8ab4f8' },
    ]);

    mkChart('chAdx', labels, [
      { label: 'ADX', data: s.adx, borderColor: '#f39c12', borderWidth: 2 },
      { label: '+DI', data: s.plusDI, borderColor: '#2ecc71' },
      { label: '-DI', data: s.minusDI, borderColor: '#e74c3c' },
    ]);

    mkChart('chHv', labels, [
      { label: 'HV(%) 年化', data: s.hv, borderColor: '#9b59b6', backgroundColor: 'rgba(155,89,182,.1)', fill: true },
    ]);

    mkChart('chRoc', labels, [
      { label: 'ROC(14) %', data: s.roc, borderColor: '#1abc9c' },
    ]);

    mkChart('chSlope', labels, [
      { label: 'Slope %/bar', data: s.slope, borderColor: '#e67e22' },
    ]);
  } catch (e) {
    console.error('刷新失败:', e);
  }
}

refresh();
setInterval(refresh, 60 * 1000); // 每分钟刷新
```

---

## 🚀 运行步骤

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start

# 3. 浏览器访问
#    原有盯盘:     http://localhost:3000/index.html
#    新增 Regime:  http://localhost:3000/regime.html

# 4. API 接口
#    GET /api/regime  -> 返回完整 JSON（regime + 各指标序列）
```

---

## ✅ 设计要点总结

| 模块 | 隔离方式 |
|------|---------|
| 指标与 Regime 逻辑 | 独立文件 `regimeModule.js`，纯函数 |
| 后端路由 | 新增 `/api/regime`，不改旧接口 |
| 定时任务 | 独立 `setInterval`，不影响旧任务 |
| 前端页面 | 独立 `regime.html` + `regime.js`，不动 `index.html` / `script.js` |
| 缓存 | 独立内存缓存 `regimeCache`，1 分钟 TTL |

需要扩展多品种（ETH、SOL）或多周期（4h/1d），只需调用 `computeRegimeSnapshot(symbol, interval)` 即可，无需改动其它任何代码。

✅ **流式输出完成**
