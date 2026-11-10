# 持仓加权平均资金费率（免费自算版）

独立只读模块，不调用下单接口，不修改 SpotDCA 信号、仓位或止盈策略。

## 数据口径

- 固定覆盖 Binance BTCUSDT、Bybit BTCUSDT、OKX BTC-USDT-SWAP 三个 USDT 永续市场。
- 使用交易所当前公布的本期费率，而不是上一期已结算费率。
- 先统一到 8 小时：`rate8h = fundingRate * 8 / fundingIntervalHours`。这是线性等效值，不是已结算结果。
- 加权：`weightedRate = sum(rate8h * singleSideOpenInterestUsd) / sum(singleSideOpenInterestUsd)`。
- Binance：`openInterest * markPrice`，以 USDT 作为美元等值近似。
- Bybit：优先 `singleOpenInterestValue`。官方 `openInterestValue` 是双边金额，旧响应缺少单边字段时除以二。
- OKX：使用公开接口的 `oiUsd`。
- 所有三家均通过时间和数值校验才记录样本。任一家失败都不降低覆盖范围、不填零、不新增历史点。
- 这是自算版，不包含 CoinGlass 覆盖的其他交易所、币本位、USDC 永续等市场，不承诺数值完全一致。
- 各家费率实际相同时，加权结果仍可能呈现平台，不人为增加波动。

## 历史

每 90 秒采样，按 UTC 的 1 小时、8 小时窗口记录真实 OHLC。主图显示 `close`，即窗口内最后一个有效样本，不做时间插值。

数据保存到 `data/weighted_funding.json`，8 小时最多 180 根，1 小时最多 240 根。重启继续积累，缺失窗口留空，首个窗口可能只覆盖启动后的部分时段。

不使用当前持仓权重反推历史，不把单交易所旧费率伪装成多交易所历史。存档损坏或写入失败时保留原文件，接口提供 `storageError` 提示。

## REST API

### `GET /api/funding/weighted`

无需请求参数、无需交易 API Key。返回 JSON：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| source | string | 固定 `self-calculated` |
| symbol | string | `BTCUSDT` |
| unit | string | `decimal`，如 `0.000097` |
| normalizedHours | number | 固定 `8` |
| venues | string[] | 固定三家交易所 |
| fresh | boolean | 是否为最新完整三家样本 |
| status | string | `loading` / `ready` / `stale` / `degraded` |
| current | object/null | `rate`、`observedAt`、`totalOpenInterestUsd`、`sources` |
| current.sources | object[] | 各家的原始费率、周期、8h 等效值、单边美元持仓、权重、时间 |
| history8h / history1h | object[] | `time/open/high/low/close/firstSampleAt/lastSampleAt/samples` |
| errors | object[] | 数据源失败信息 |
| storageError | string/null | 持久化失败提示 |
| sampleIntervalMs | number | `90000` |

`GET /api/status` 同时在 `weightedFunding` 字段返回上述结构。所有费率在接口和存档中保留原始小数，不四舍五入。

页面按截图的百分比数值口径显示：`rate * 100`。例如接口 `0.000097` 显示 `0.00970000`，辅助信息显示 `0.009700%`。这不是资金费金额，不能再次乘以 100。

## 调用

```javascript
const { WeightedFundingService } = require('./funding/weightedFunding');
const service = new WeightedFundingService();
service.start();
// 只读快照
const snapshot = service.getState();
service.stop();
```

构造参数均可选：`getJson(url)` 注入 HTTP 实现，`now()` 注入时钟，`storageFile` 指定存档路径（`null` 禁用存档），`fs` 注入文件系统用于测试。

代理只读取操作人员设置的 `HTTPS_PROXY/https_proxy/ALL_PROXY/all_proxy/HTTP_PROXY/http_proxy`，支持 HTTP 与 SOCKS。代码不内置代理地址，不修改 `.env`。

## 验证

```bash
node --test scripts/test_weighted_funding.js scripts/test_funding_display.js scripts/test_spot_dca.js
```

正式服务由 `server.js` 启动该模块。生产保持现有 PM2 单进程 Fork 模式，部署后手动重启，保留历史存档。
