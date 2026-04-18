# BTCUSDT 量化盯盘控制台 (假突破/跌破策略)

这是一套基于 Node.js + Express.js 开发的量化盯盘与自动交易信号触发服务。系统专为 **高频短线突破（假突破/假跌破）** 策略设计，结合了币安实时的预测资金费率（Premium Index），并通过 Webhook 动态触发交易报文。

> v1.1.0 起：所有敏感凭证通过环境变量加载；配置型接口启用 Token 鉴权；新增最小反转幅度与连续确认机制以防 tick 抖动误触发。

## 🚨 安全紧急处理 (必读)

**旧版 `server.js` 硬编码过飞书应用凭证并提交到了 git 历史**：
- `FEISHU_APP_ID = cli_a968a722e4bb1cd3`
- `FEISHU_APP_SECRET = ouYoFfNmCN7UsJKpHkpubeXMWJVbUFVU`

**请立即执行以下两步**：

1. **轮换飞书 secret**：登录 [飞书开放平台](https://open.feishu.cn/app) → 选择该应用 → 凭证与基础信息 → 点击"重置 App Secret"，然后把**新的 secret** 填到本地 `.env`。旧 secret 已公开视为失效。
2. **(可选) 清理 git 历史里的旧 secret**：如果仓库曾推送到任何远程（GitHub/GitLab 等），用 [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) 清除历史中的 secret：
   ```bash
   # 先 clone 裸仓库
   git clone --mirror <your-repo-url> repo.git
   # 用 BFG 清除 secret
   java -jar bfg.jar --replace-text passwords.txt repo.git
   # passwords.txt 内写一行: ouYoFfNmCN7UsJKpHkpubeXMWJVbUFVU==>***REMOVED***
   cd repo.git && git reflog expire --expire=now --all && git gc --prune=now --aggressive
   git push
   ```
   如果仓库从未推送过远程，直接 `rm -rf .git && git init` 重新初始化也可以。

## ✨ 核心特性

- ⚡️ **90 秒级实时判断 + 自算预测费率**：周期性轮询币安官方 `premiumIndex` 接口，并基于 `markPrice/indexPrice/interestRate` **自行计算下一期预测资金费率**（币安返回的 `lastFundingRate` 只是 8h 前已结算的历史值，不适合做实时策略判断）。
- 🛡️ **铁律级策略防御**：
  - **假突破/假跌破状态机**：精准捕捉价格"触碰边界后回落/反弹"的信号。
  - **突破价快照 + 最小反转幅度**：必须达到指定百分比（默认 0.05%）的反向运动，才算有效反转。
  - **连续确认次数**：反向运动需要连续满足 N 次（默认 2 次）才最终触发，避免单次 tick 抖动误开单。
  - **资金费率方向硬拦截**：假突破（开空）时资金费率必须为正；假跌破（开多）时资金费率必须为负，否则强制拦截并重置状态。
  - **单次触发锁定**：一旦进入发送流程立即锁定 `isHoldingPosition`，**网络错误不释放锁**，**业务错误释放锁**，区别处理。
  - **API 脏数据防御**：遇到 NaN 自动抛弃，不污染历史图表。
- 🔐 **安全强化**：
  - 敏感凭证全部走环境变量（飞书 APP_ID/SECRET、接收者、Token）。
  - `/api/config` 与 `/api/reset` 必须带 `X-Auth-Token` 请求头。
  - `/api/status` 会脱敏 `webhookUrl`、隐藏 `shortPayload`/`longPayload` 的具体内容。
- 📊 **数据仪表盘**：基于 ECharts 深色图表，双图表对比（8 小时已结算 + 90 分钟实时预测）。
- 🔔 **飞书报警**：启动、价格触碰、反转确认、开仓、业务失败、网络致命错误、费率突变均推送。

---

## 🚀 快速开始

### 1. 环境要求
- Node.js v16+
- npm

### 2. 配置环境变量

```bash
cp .env.example .env
# 然后编辑 .env 填写真实值
```

关键字段：

| 变量 | 说明 |
| ---- | ---- |
| `PORT` | 服务端口（默认 3001） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭证 |
| `FEISHU_RECEIVE_ID_TYPE` | 飞书接收者类型，合法值：`open_id` / `union_id` / `user_id` / `email` / `chat_id` |
| `FEISHU_RECEIVE_ID` | 对应的接收 ID。`oc_xxx` 是群聊（type=chat_id），`ou_xxx` 是个人（type=open_id），`on_xxx` 是 union_id |
| `CONFIG_AUTH_TOKEN` | **必填**，修改配置/解锁时必须提供此 Token（请求头 `X-Auth-Token`） |
| `MIN_REVERSAL_PCT` | 最小反转幅度（小数），默认 `0.0005` = 0.05% |
| `CONFIRM_COUNT` | 连续确认次数，默认 `2` |
| `WEBHOOK_TIMEOUT_MS` | Webhook 请求超时（毫秒），默认 `10000` |
| `BINANCE_TIMEOUT_MS` | 币安接口请求超时（毫秒），默认 `10000` |
| `RATE1H_MIN_ABS` | 近 1H 均值最小绝对值阈值，默认 `0.00005`（= 0.5bp）|
| `RATE1H_MIN_SAMPLES` | 1H 均值生效所需的最少采样点数，默认 `10`（约 15 分钟暖机）|

### 3. 安装与启动

```bash
npm install
npm start
```

### 4. 配置与监控

浏览器访问：**http://localhost:3001**（或你 `.env` 里设置的端口）。

1. 在"接口鉴权 Token"里填写 `.env` 中的 `CONFIG_AUTH_TOKEN`（会保存到 localStorage 方便后续解锁）。
2. 填写阻力价 / 支撑价（阻力必须 > 支撑）。
3. 填写 Webhook URL 和做多 / 做空 JSON 报文。
4. 如果两边 payload 都没有 `action` 字段，必须勾选"我已确认多/空报文未填反"。
5. 点击"保存配置并锁定"进入实盘监控。

---

## 🧠 策略原理详解（v1.3 日内超短线 · 近 1H 情绪铁律）

### 🎯 核心思路

资金费率反映**持仓拥挤度**。日内超短线关心"近期情绪"，用**过去 1 小时瞬时预测费率的平均值**作为核心判断：
- 近 1H 均值为正 → 多头持续付费，多头拥挤 → 主力准备向下猎杀 → 我们做空（假突破回落时）
- 近 1H 均值为负 → 空头持续付费，空头拥挤 → 主力准备向上猎杀 → 我们做多（假跌破反弹时）

**为什么用 1 小时均值，不用瞬时值也不用 24h 结算值？**
- 瞬时值每秒抖动，会在同一轮内翻正翻负 → 开仓信号不稳定
- 已结算费率有 8-24h 延迟，反映的是过去而非现在 → 错过日内的快速变盘
- **1 小时窗口** ≈ 最多 40 个采样点（每 90s 一次），既平滑了瞬时抖动，又能快速反映近期情绪变化

### 🔴 做空逻辑 (假突破 + 近 1H 多头拥挤)

1. 实时价格 **≥ 阻力价** → 挂起"监控回落"状态，记录**突破后的最高价**。
2. 价格回落至阻力价下方，且 **回落幅度 ≥ MIN_REVERSAL_PCT** 连续 `CONFIRM_COUNT` 次。
3. 检查**近 1H 瞬时费率均值**：
   - 样本点 ≥ `RATE1H_MIN_SAMPLES` 且 均值 > `+RATE1H_MIN_ABS` → 触发做空 Webhook
   - 否则拦截并重置状态机（重新等下次突破）

### 🟢 做多逻辑 (假跌破 + 近 1H 空头拥挤)

1. 实时价格 **≤ 支撑价** → 挂起"监控反弹"状态。
2. 价格反弹至支撑价上方，反弹幅度 ≥ `MIN_REVERSAL_PCT` 连续 `CONFIRM_COUNT` 次。
3. 检查**近 1H 均值 < -RATE1H_MIN_ABS** → 触发做多 Webhook，否则拦截重置。

### 📊 信号强度分级（开仓消息标签）

| 近 1H 方向 | 当下瞬时费率 | 标签 | 含义 |
|-----------|-------------|------|------|
| 多头拥挤 | 正 | 🔥 强信号 | 近期情绪与当下一致，双重确认 |
| 多头拥挤 | 负 | ⚠️ 转向警告 | 近期多头拥挤，但瞬时已翻负——可能市场刚刚转向，开仓但需加强止损 |
| 空头拥挤 | 负 | 🔥 强信号 | 近期情绪与当下一致 |
| 空头拥挤 | 正 | ⚠️ 转向警告 | 近期空头拥挤，但瞬时已翻正——市场可能刚翻转 |
| 暖机中 / 中性 | 任意 | 🚫 不开仓 | 采样不足或无显著拥挤 |

### 🔒 开仓锁的释放原则

| 场景 | `isHoldingPosition` |
| ---- | ---- |
| Webhook 2xx + 业务成功 | 锁定不释放（策略需要人工解锁） |
| Webhook 2xx + 业务字段明确失败（如 `success: false` / `code != 0`） | **释放锁**，允许下次信号重试 |
| Webhook 网络超时 / 未知错误 | **不释放锁**，防止无法确认成交情况下的重复下单 |

---

## 📡 API 接口

### GET `/api/status`
无需鉴权。返回脱敏后的运行状态与图表数据。

### POST `/api/config`
需请求头 `X-Auth-Token: <CONFIG_AUTH_TOKEN>`。仅在未锁定时可用。

Body 字段：
```json
{
  "resistancePrice": 70000,
  "supportPrice": 60000,
  "webhookUrl": "https://your-middleware.com/hook",
  "shortPayload": { "action": "open_short", "symbol": "BTCUSDT" },
  "longPayload": { "action": "open_long", "symbol": "BTCUSDT" },
  "confirmRisk": false
}
```

### POST `/api/reset`
需请求头 `X-Auth-Token: <CONFIG_AUTH_TOKEN>`。解除锁定。

Body（可选）：
```json
{ "clearHistory": false }
```

`clearHistory=true` 会同时清空图表历史和 `lastFundingRate`。

---

## ⚠️ 重要注意事项

1. **不要把 .env 提交到 git**：已在 `.gitignore` 中排除。
2. **首次启动没有历史数据**时，1 小时均值会退化为"当前预测费率"。
3. **费率突变告警阈值**调整为 5bp（0.0005），减少噪声刷屏。
4. **数据持久化**：当前配置保存在 Node.js 内存中，重启进程需要重新填写配置。
5. **解除持仓锁定**：触发开仓后系统会锁定，请登录网页端点击"修改配置 / 重置状态 (解锁)"按钮并输入鉴权 Token。
6. **预测费率语义** (v1.2 起)：
   - 策略判断使用的是**自算的下一期预测费率**，公式：`premium = (markPrice-indexPrice)/indexPrice; predicted = premium + clamp(interestRate-premium, -0.0005, 0.0005)`。
   - 币安 `premiumIndex.lastFundingRate` 字段是"上一期已结算费率"（每 8h 更新一次），**仅作参考展示**，不用于策略决策。
   - 两者可能正负背离：预测费率反映当下一刻市场多空博弈；已结算费率反映的是过去 8 小时。

---

*Developed for professional quantitative short-term trading.*
