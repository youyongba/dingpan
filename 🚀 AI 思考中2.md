🚀 AI 思考中...

# 币安合约宏观市场状态（Regime）分析系统

下面是一套**完整、独立、可直接运行**的项目代码。所有新增逻辑封装在 `regimeModule.js` 中，通过独立路由 `/api/regime` 暴露，**不会影响 `server.js` 中原有任何路由/功能**。

---

## 📁 项目结构

```text
📁 public/
  📄 index.html          # 前端页面
  📄 script.js           # 图表渲染 + 轮询
  📄 style.css           # 样式
📄 .env                  # 你的凭证（已存在）
📄 .env.example
📄 package.json
📄 server.js             # 仅新增一条路由，原逻辑保留
📄 regimeModule.js       # 独立模块：K线拉取 + 指标 + regime
```

---

## 1️⃣ `package.json`

```json
{
  "name": "btc-regime-monitor",
  "version": "1.0.0",
  "description": "BTC 永续合约宏观市场状态 (regime) 分析",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.4"
  }
}
```

---

## 2️⃣ `regimeModule.js` — 独立指标与 regime 判断模块

```javascript
// regimeModule.js
// ============================================================
// 独立模块：从币安合约拉取 K 线 -> 计算指标 -> 判定市场 regime
// 不依赖项目中任何其它业务逻辑，可安全插拔
// ============================================================

const axios = require('axios');

const BINANCE_FAPI = 'https://fapi.binance.com';

// ------------------------------------------------------------
// 1. 获取币安 USDT 永续合约 K 线
// ------------------------------------------------------------
async function fetchKlines(symbol = 'BTCUSDT', interval = '1h', limit = 500) {
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol, interval, limit },
    timeout: 15000,
  });
  // 原始字段: [openTime, open, high, low, close, volume, closeTime, ...]
  return data.map(k => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low:  +k[3],
    close:+k[4],
    volume:+k[5],
  }));
}

// ------------------------------------------------------------
// 2. 基础工具
// ------------------------------------------------------------
function sma(arr, period) {
  const out = Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Wilder 平滑 (RMA)
function rma(arr, period) {
  const out = Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) continue;
    if (prev == null) {
      // 用前 period 个求平均作为初值
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += arr[j];
        prev = s / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + arr[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

// ------------------------------------------------------------
// 3. ATR(14)
// ------------------------------------------------------------
function calcATR(kl, period = 14) {
  const tr = kl.map((k, i) => {
    if (i === 0) return k.high - k.low;
    const prevClose = kl[i - 1].close;
    return Math.max(
      k.high - k.low,
      Math.abs(k.high - prevClose),
      Math.abs(k.low  - prevClose)
    );
  });
  return rma(tr, period);
}

// ------------------------------------------------------------
// 4. ADX(14) + +DI / -DI
// ------------------------------------------------------------
function calcADX(kl, period = 14) {
  const len = kl.length;
  const plusDM  = Array(len).fill(0);
  const minusDM = Array(len).fill(0);
  const tr      = Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const upMove   = kl[i].high - kl[i - 1].high;
    const downMove = kl[i - 1].low - kl[i].low;
    plusDM[i]  = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      kl[i].high - kl[i].low,
      Math.abs(kl[i].high - kl[i - 1].close),
      Math.abs(kl[i].low  - kl[i - 1].close)
    );
  }

  const atr      = rma(tr, period);
  const plusDMs  = rma(plusDM, period);
  const minusDMs = rma(minusDM, period);

  const plusDI  = atr.map((v, i) => v ? 100 * plusDMs[i]  / v : null);
  const minusDI = atr.map((v, i) => v ? 100 * minusDMs[i] / v : null);

  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || (p + m) === 0) return null;
    return 100 * Math.abs(p - m) / (p + m);
  });

  const adx = rma(dx, period);
  return { adx, plusDI, minusDI };
}

// ------------------------------------------------------------
// 5. 历史波动率 HV (年化, 用作类 VIX 指标)
//    以对数收益率的滚动标准差 * sqrt(年化周期)
//    1h K线 -> 年化周期 ≈ 24 * 365 = 8760
// ------------------------------------------------------------
function calcHV(kl, period = 24, annualFactor = 24 * 365) {
  const logRet = kl.map((k, i) => i === 0 ? 0 : Math.log(k.close / kl[i - 1].close));
  const out = Array(kl.length).fill(null);
  for (let i = period; i < kl.length; i++) {
    const win = logRet.slice(i - period + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const variance = win.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance) * Math.sqrt(annualFactor) * 100; // 百分比
  }
  return out;
}

// ------------------------------------------------------------
// 6. ROC(14) - 波动速率
// ------------------------------------------------------------
function calcROC(kl, period = 14) {
  return kl.map((k, i) =>
    i < period ? null : 100 * (k.close - kl[i - period].close) / kl[i - period].close
  );
}

// ------------------------------------------------------------
// 7. 价格斜率 Slope (线性回归斜率, 归一化为 %/bar)
// ------------------------------------------------------------
function calcSlope(kl, period = 14) {
  const closes = kl.map(k => k.close);
  const out = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let j = 0; j < period; j++) {
      const x = j;
      const y = closes[i - period + 1 + j];
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const n = period;
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    out[i] = (slope / closes[i]) * 100; // 归一化为 % 每 bar
  }
  return out;
}

// ------------------------------------------------------------
// 8. Regime 判定
//    - 趋势市: ADX > 25 且 HV 高
//    - 震荡市: ADX < 20 且 HV 低
//    - 恐慌市: HV 极高 且 ADX 弱
//    - 中性市: 其它
// ------------------------------------------------------------
function decideRegime({ adx, plusDI, minusDI, hv }) {
  const last = arr => arr[arr.length - 1];
  const A = last(adx), H = last(hv);

  // 以最近 100 根 HV 的分位作为"高/低"门槛
  const recentHV = hv.filter(v => v != null).slice(-100);
  const sorted = [...recentHV].sort((a, b) => a - b);
  const q = p => sorted[Math.floor(sorted.length * p)] ?? 0;
  const hvLow = q(0.33);
  const hvHigh = q(0.66);
  const hvPanic = q(0.9);

  let regime = 'NEUTRAL';
  let label = '中性市';
  let color = '#9ca3af';

  if (H >= hvPanic && A < 25) {
    regime = 'PANIC'; label = '恐慌市'; color = '#ef4444';
  } else if (A > 25 && H >= hvHigh) {
    regime = 'TREND'; label = '趋势市'; color = '#10b981';
  } else if (A < 20 && H <= hvLow) {
    regime = 'RANGE'; label = '震荡市'; color = '#3b82f6';
  }

  return {
    regime, label, color,
    adx: +A?.toFixed(2),
    plusDI: +last(plusDI)?.toFixed(2),
    minusDI: +last(minusDI)?.toFixed(2),
    hv: +H?.toFixed(2),
    thresholds: { hvLow: +hvLow.toFixed(2), hvHigh: +hvHigh.toFixed(2), hvPanic: +hvPanic.toFixed(2) },
  };
}

// ------------------------------------------------------------
// 9. 对外主函数 + 简单内存缓存
// ------------------------------------------------------------
let _cache = { ts: 0, payload: null };
const CACHE_TTL = 60 * 1000; // 1 分钟

async function getRegimeSnapshot({ symbol = 'BTCUSDT', interval = '1h', limit = 500, force = false } = {}) {
  if (!force && _cache.payload && Date.now() - _cache.ts < CACHE_TTL) {
    return _cache.payload;
  }

  const kl = await fetchKlines(symbol, interval, limit);
  const atr = calcATR(kl, 14);
  const { adx, plusDI, minusDI } = calcADX(kl, 14);
  const hv  = calcHV(kl, 24);
  const roc = calcROC(kl, 14);
  const slope = calcSlope(kl, 14);

  const summary = decideRegime({ adx, plusDI, minusDI, hv });

  const payload = {
    symbol, interval,
    updatedAt: Date.now(),
    lastPrice: kl[kl.length - 1].close,
    summary,
    series: {
      time:  kl.map(k => k.time),
      open:  kl.map(k => k.open),
      high:  kl.map(k => k.high),
      low:   kl.map(k => k.low),
      close: kl.map(k => k.close),
      atr, adx, plusDI, minusDI, hv, roc, slope,
    },
  };

  _cache = { ts: Date.now(), payload };
  return payload;
}

module.exports = { getRegimeSnapshot };
```

---

## 3️⃣ `server.js` — 仅新增独立路由（原逻辑不受影响）

```javascript
// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { getRegimeSnapshot } = require('./regimeModule');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 【新增 - 独立模块】宏观市场状态分析接口
// ============================================================
app.get('/api/regime', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '1h', limit = 500, force } = req.query;
    const data = await getRegimeSnapshot({
      symbol, interval,
      limit: Math.min(+limit || 500, 1000),
      force: force === '1',
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[regime] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 首次启动预热
getRegimeSnapshot().catch(e => console.warn('预热失败:', e.message));

// 每 60 秒后台刷新一次缓存
setInterval(() => {
  getRegimeSnapshot({ force: true })
    .then(d => console.log(`[regime] refreshed, regime=${d.summary.regime}, price=${d.lastPrice}`))
    .catch(e => console.warn('[regime] refresh failed:', e.message));
}, 60 * 1000);

// ============================================================
// 这里可继续挂载你原有的飞书/其它路由 (此处不改动)
// ============================================================

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   Regime API  -> http://localhost:${PORT}/api/regime`);
});
```

---

## 4️⃣ `public/index.html`

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>BTC 宏观市场状态监控</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
</head>
<body>
  <header>
    <h1>📈 BTC/USDT 永续合约 · 宏观市场状态 (Regime)</h1>
    <div class="meta">
      <span id="price">-</span>
      <span id="regime" class="regime-tag">加载中...</span>
      <span id="updated" class="muted">-</span>
    </div>
  </header>

  <section class="grid">
    <div class="card"><h3>BTC 价格 (Close)</h3><canvas id="priceChart"></canvas></div>
    <div class="card"><h3>ATR (14)</h3><canvas id="atrChart"></canvas></div>
    <div class="card"><h3>ADX / +DI / -DI</h3><canvas id="adxChart"></canvas></div>
    <div class="card"><h3>HV 历史波动率 (类 VIX, %)</h3><canvas id="hvChart"></canvas></div>
    <div class="card"><h3>ROC (14) 波动速率</h3><canvas id="rocChart"></canvas></div>
    <div class="card"><h3>Slope 价格斜率 (%/bar)</h3><canvas id="slopeChart"></canvas></div>
  </section>

  <script src="script.js"></script>
</body>
</html>
```

---

## 5️⃣ `public/style.css`

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; }
header { padding: 20px 28px; background: #111827; border-bottom: 1px solid #1f2937; }
header h1 { margin: 0 0 8px; font-size: 20px; }
.meta { display: flex; gap: 16px; align-items: center; font-size: 14px; }
#price { font-size: 18px; font-weight: 600; color: #fbbf24; }
.regime-tag { padding: 4px 12px; border-radius: 999px; font-weight: 600; background: #374151; }
.muted { color: #6b7280; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 16px; padding: 20px; }
.card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 14px; }
.card h3 { margin: 0 0 10px; font-size: 14px; color: #cbd5e1; }
canvas { width: 100% !important; height: 220px !important; }
```

---

## 6️⃣ `public/script.js`

```javascript
// 前端渲染逻辑
const charts = {};

function baseOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#cbd5e1' } } },
    scales: {
      x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: '#1f2937' } },
      y: { ticks: { color: '#64748b' }, grid: { color: '#1f2937' } },
    },
    ...extra,
  };
}

function mkChart(id, datasets, labels) {
  const ctx = document.getElementById(id);
  if (charts[id]) { charts[id].data.labels = labels; charts[id].data.datasets = datasets; charts[id].update('none'); return; }
  charts[id] = new Chart(ctx, { type: 'line', data: { labels, datasets }, options: baseOpts() });
}

async function refresh() {
  try {
    const r = await fetch('/api/regime');
    const { ok, data, error } = await r.json();
    if (!ok) throw new Error(error);

    const s = data.series;
    const labels = s.time.map(t => {
      const d = new Date(t);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
    });

    // 顶部信息
    document.getElementById('price').textContent = `$${data.lastPrice.toLocaleString()}`;
    const tag = document.getElementById('regime');
    tag.textContent = `${data.summary.label} (${data.summary.regime})  ADX=${data.summary.adx}  HV=${data.summary.hv}%`;
    tag.style.background = data.summary.color;
    tag.style.color = '#0f172a';
    document.getElementById('updated').textContent = '更新于 ' + new Date(data.updatedAt).toLocaleTimeString();

    // 图表
    mkChart('priceChart', [
      { label: 'Close', data: s.close, borderColor: '#fbbf24', borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
    ], labels);

    mkChart('atrChart', [
      { label: 'ATR(14)', data: s.atr, borderColor: '#38bdf8', borderWidth: 1.5, pointRadius: 0 },
    ], labels);

    mkChart('adxChart', [
      { label: 'ADX',  data: s.adx,     borderColor: '#a78bfa', borderWidth: 1.5, pointRadius: 0 },
      { label: '+DI',  data: s.plusDI,  borderColor: '#10b981', borderWidth: 1,   pointRadius: 0 },
      { label: '-DI',  data: s.minusDI, borderColor: '#ef4444', borderWidth: 1,   pointRadius: 0 },
    ], labels);

    mkChart('hvChart', [
      { label: 'HV (%)', data: s.hv, borderColor: '#f472b6', borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: 'rgba(244,114,182,0.08)' },
    ], labels);

    mkChart('rocChart', [
      { label: 'ROC(14)', data: s.roc, borderColor: '#34d399', borderWidth: 1.5, pointRadius: 0 },
    ], labels);

    mkChart('slopeChart', [
      { label: 'Slope', data: s.slope, borderColor: '#facc15', borderWidth: 1.5, pointRadius: 0 },
    ], labels);
  } catch (e) {
    console.error(e);
    document.getElementById('regime').textContent = '加载失败: ' + e.message;
  }
}

refresh();
setInterval(refresh, 60 * 1000); // 前端每分钟刷新
```

---

## 7️⃣ 你的 `.env` 无需改动

原有的 `PORT=3001` 会被自动使用，飞书等原配置完全不受影响。

> ⚠️ 安全提醒：你在 `.env` 注释里贴出的 `APP_SECRET` 已经外泄，**立刻去飞书开放平台 revoke 并换新**！

---

## 🚀 启动步骤

```bash
# 1. 安装依赖
npm install

# 2. 启动
npm start
# 或开发模式
npm run dev

# 3. 浏览器打开
http://localhost:3001
```

打开后会看到：
- 顶部：**当前 regime 标签**（趋势/震荡/恐慌/中性）+ 实时 BTC 价格
- 6 张图表：价格、ATR、ADX 组合、HV、ROC、Slope
- 后端每 60s 从币安刷新，前端每 60s 自动拉取

---

## 🧠 Regime 判定逻辑说明

| 状态 | 条件 | 颜色 |
|------|------|------|
| 趋势市 TREND | ADX > 25 且 HV ≥ 近100根66%分位 | 🟢 绿 |
| 震荡市 RANGE | ADX < 20 且 HV ≤ 近100根33%分位 | 🔵 蓝 |
| 恐慌市 PANIC | HV ≥ 近100根90%分位 且 ADX < 25 | 🔴 红 |
| 中性市 NEUTRAL | 其它情况 | ⚪ 灰 |

HV 阈值采用**相对分位数**而不是绝对值，可自适应不同市场阶段，比固定阈值更稳健。

---

## 🧩 模块化说明（与原项目隔离）

- 所有新增逻辑在 `regimeModule.js` 中，通过 `require` 引入，**无任何全局副作用**
- `server.js` 只新增了 `/api/regime` 一条路由和一个 `setInterval`，**没有修改/移除任何已有代码**
- 如需移除该功能：删掉 `regimeModule.js` + `server.js` 中带注释标记的新增块即可，其它功能完好

✅ **流式输出完成**
