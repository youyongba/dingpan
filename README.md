# BTCUSDT 资金费率盯盘（纯盯盘模式）

基于 Node.js + Express 的 BTCUSDT 资金费率情绪盯盘服务。**不做交易、不发 webhook**，只：

- 每 90 秒拉取币安 `premiumIndex` 数据
- 自算瞬时预测资金费率、维护近 1 小时均值
- 判断"多头拥挤 / 空头拥挤 / 中性"方向
- **方向变化** + **每小时定时**自动推送飞书消息
- Web 仪表盘实时可视化（含 3 张走势图）

## 🚨 安全紧急处理（首次部署必读）

旧版 `server.js` 硬编码过飞书凭证并提交到了 git 历史：

- `FEISHU_APP_ID = cli_a968a722e4bb1cd3`
- `FEISHU_APP_SECRET = ouYoFfNmCN7UsJKpHkpubeXMWJVbUFVU`

**立即执行**：
1. 登录 [飞书开放平台](https://open.feishu.cn/app) → 选择该应用 → 点击"重置 App Secret"，把新的 secret 填到 `.env`。
2. 如果仓库推送过远程（GitHub 等），用 [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) 清除历史 secret。

---

## 🚀 快速开始

### 1. 环境准备

```bash
npm install
cp .env.example .env
# 然后编辑 .env 填写真实值
```

### 2. 启动服务

```bash
npm start
```

访问：**http://localhost:3001**

启动后约 **15 分钟** 暖机完成（累积 10 个采样点），会收到第一条飞书心跳。

---

## ⚙️ 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3001` |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭证 | 无（必填） |
| `FEISHU_RECEIVE_ID_TYPE` | `chat_id` / `open_id` / `union_id` / `user_id` / `email` | 无（必填） |
| `FEISHU_RECEIVE_ID` | 对应的接收方 ID（`oc_` 前缀→chat_id；`ou_`→open_id）| 无（必填） |
| `CONFIG_AUTH_TOKEN` | 清空历史接口（`/api/reset`）的鉴权 Token | 无（必填，否则禁用 reset）|
| `BINANCE_TIMEOUT_MS` | 币安接口请求超时（毫秒）| `10000` |
| `RATE1H_MIN_ABS` | 近 1H 均值最小绝对值阈值 | `0.00005`（=0.5bp）|
| `RATE1H_MIN_SAMPLES` | 1H 均值生效最少采样点数 | `10`（约 15 分钟）|

---

## 🧠 策略原理

### 核心信号：近 1 小时瞬时费率均值

资金费率反映**持仓拥挤度**。每 90 秒采样一次当下的瞬时预测费率，取过去 1 小时（最多 40 个采样点）均值：

- 均值 > +0.5bp → **多头拥挤**（多头持续向空头付钱）→ 主力可能向下猎杀多头 → **建议做空**
- 均值 < -0.5bp → **空头拥挤** → 主力可能向上猎杀空头 → **建议做多**
- |均值| ≤ 0.5bp → 市场中性，不建议开仓

### 信号强度标签

| 近 1H 方向 | 当下瞬时 | 标签 | 含义 |
|-----------|---------|------|------|
| 多头拥挤 | 正 | 🔥 强信号 | 近期情绪与当下一致，双重确认 |
| 多头拥挤 | 负 | ⚠️ 转向警告 | 近期多头拥挤，但瞬时已翻负→可能刚转向 |
| 空头拥挤 | 负 | 🔥 强信号 | 同上反向 |
| 空头拥挤 | 正 | ⚠️ 转向警告 | 同上反向 |

---

## 🔔 飞书消息策略

| 场景 | 消息 | 频率 |
|------|------|------|
| 服务启动 | ✅ **盯盘服务已上线** | 1 次 |
| 首次暖机完成 | 🚀 **首次数据心跳** | 1 次 |
| 方向变化（防抖：连续 2 次确认）| 🔄 **近1H情绪方向变化** | 市场变化时 |
| 定时心跳 | 📊 **每小时盯盘心跳** | 每 1 小时 |
| 预测费率跳变超 5bp | 🚨 **预测资金费率突变警报** | 市场剧烈变化时 |

**防抖保证**：不会因为均值在 0.5bp 附近微抖而刷屏。

---

## 📊 Web 仪表盘

访问首页 `http://localhost:3001`，可以看到：

1. **数据面板**：最新价格、🎯 近 1H 情绪判断（核心信号）、瞬时/1H 均值/上期结算/今日累计费率
2. **图表区**：
   - 📈 8 小时资金费率历史（币安结算值，最近 20 天）
   - 📉 瞬时预测费率走势（最近 90 分钟）
   - 🎯 **近 1H 瞬时费率均值走势**（最近 6 小时，日内情绪主线）
3. **清空历史按钮**：需要 `X-Auth-Token`（填 `.env` 里的 `CONFIG_AUTH_TOKEN`）

---

## 📡 API 接口

### GET `/api/status`

返回完整运行态（无需鉴权），包含：

```json
{
  "currentPrice": 69850.23,
  "predictedFundingRate": 0.00012,
  "lastSettledFundingRate": 0.0001,
  "rate1hAvg": 0.000085,
  "rate1hDirection": "long_crowded",
  "rate1hSamples": 24,
  "isStrongSignal": true,
  "isReversalWarning": false,
  "historyData": [...],
  "realTimeHistory": [...],
  "rate1hHistory": [...]
}
```

### POST `/api/reset`

清空所有历史数据并重置暖机状态（需请求头 `X-Auth-Token`）。

---

## ⚠️ 注意事项

1. **启动后需暖机 ~15 分钟**，期间 `rate1hDirection=warming_up`，不会有方向变化告警。
2. **数据不持久化**：重启后所有历史清空，需重新暖机。
3. **预测费率有误差**：币安官方公式用的是 Impact Bid/Ask Price（订单簿冲击价），我们用 `markPrice` 近似，在平稳行情下接近、极端行情下可能差 10-50bp。因此**仅作为情绪方向参考**。
4. **资金费率每 8 小时结算**：`lastSettledFundingRate` 字段只有在 UTC 00/08/16 点结算后才更新，仅供参考。
5. **不做交易、不发 Webhook**：系统只推送信号，实际开仓需要你手动到交易所操作。
