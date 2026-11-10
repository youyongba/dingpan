# 持仓加权平均资金费率（免费自算版）

独立只读模块，不调用下单接口，不修改 SpotDCA 信号、仓位或止盈策略。

## 数据口径

- 固定覆盖 Binance BTCUSDT、Bybit BTCUSDT、OKX BTC-USDT-SWAP，以及 Hyperliquid 主永续市场的 BTC。
- 使用交易所当前公布的本期费率，而不是上一期已结算费率。
- 先统一到 8 小时：`rate8h = fundingRate * 8 / fundingIntervalHours`。这是线性等效值，不是已结算结果。
- 加权：`weightedRate = sum(rate8h * singleSideOpenInterestUsd) / sum(singleSideOpenInterestUsd)`。
- Binance：`openInterest * markPrice`，以 USDT 作为美元等值近似。
- Bybit：优先 `singleOpenInterestValue`。官方 `openInterestValue` 是双边金额，旧响应缺少单边字段时除以二。
- OKX：使用公开接口的 `oiUsd`。
- Hyperliquid：只读 `POST https://api.hyperliquid.xyz/info`，请求体 `{"type":"metaAndAssetCtxs","dex":""}`。按 `universe` 中 BTC 的索引取得对应上下文，不假定 BTC 永远位于第一项。`funding` 是每小时费率，乘以 8 转成等效 8 小时；单边美元持仓为 `openInterest * markPx`，不再除二。
- Hyperliquid BTC 以 USDC 抵押，其余三个市场使用 USDT，均按美元等值近似，不做稳定币汇率转换。权重使用标记价的持仓名义金额，不是 Hyperliquid 按预言机价格计算的实际资金费付款金额。
- 所有四家均通过数值和可取得的时间校验才记录样本。任一家失败都不降低覆盖范围、不填零、不新增历史点。每个来源及请求完成时的数据年龄均不得超过 180 秒，交易所原生时间戳间差值也不得超过 180 秒，兼容各公开接口独立更新节奏，不再以 60 秒差值拒绝仍在有效期内的样本。Hyperliquid 上下文不提供交易所快照时间，`asOf` 是本次请求观测时间，并标记 `timeSource: "request-observation"`；不能用它证明源数据的原生时间，不参与交易所原生时间戳间的差值校验。
- 这是自算版，不包含 CoinGlass 覆盖的其他交易所、币本位、USDC 永续等市场，不承诺数值完全一致。
- 各家费率实际相同时，加权结果仍可能呈现平台，不人为增加波动。

## 历史

每 90 秒采样，按 UTC 的 1 小时、8 小时窗口记录真实 OHLC。主图显示 `close`，即窗口内最后一个有效样本，不做时间插值。

数据保存到 `data/weighted_funding.json`，8 小时最多 180 根，1 小时最多 240 根。重启继续积累，缺失窗口留空，首个窗口可能只覆盖启动后的部分时段。

存档格式升级为 `version: 2`，保存四家覆盖范围。旧 `version: 1` 的三家历史转入 `legacyHistory` 原样保留，新四家历史从升级后首次完整采样开始。不用新权重重算旧数据，也不在同一根 OHLC 中混合两种指标。迁移只在完整新样本成功后原子写入；首次采样失败时不改旧文件。不要将旧模块覆盖回去读取新格式存档。

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
| venues | string[] | 固定四家交易所 |
| fresh | boolean | 是否为最新完整四家样本 |
| status | string | `loading` / `ready` / `stale` / `degraded` |
| current | object/null | `rate`、`observedAt`、`totalOpenInterestUsd`、`sources` |
| current.sources | object[] | 各家的原始费率、周期、8h 等效值、单边美元持仓、权重、时间 |
| history8h / history1h | object[] | `time/open/high/low/close/firstSampleAt/lastSampleAt/samples` |
| legacyHistory | object/null | 旧三家覆盖范围及 `history8h/history1h`，不参与新四家绘图 |
| errors | object[] | 数据源失败信息 |
| storageError | string/null | 持久化失败提示 |
| sampleIntervalMs | number | `90000` |

采样异常时页面显示 `errors[].message` 的具体原因（包括聚合时间校验），保留上次有效值并标明非实时；后续完整采样通过后自动恢复，不补造暂停期间的历史点。

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

构造参数均可选：`getJson(url, body?)` 注入 HTTP 实现，无 `body` 时 GET，有 `body` 时只读 POST；`now()` 注入时钟，`storageFile` 指定存档路径（`null` 禁用存档），`fs` 注入文件系统用于测试。

Hyperliquid 口径依据：[资产上下文接口](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)、[每小时资金费率说明](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)。本模块不调用其交易、签名或钱包接口。

代理只读取操作人员设置的 `HTTPS_PROXY/https_proxy/ALL_PROXY/all_proxy/HTTP_PROXY/http_proxy`，支持 HTTP 与 SOCKS。代码不内置代理地址，不修改 `.env`。

## 验证

```bash
node --test scripts/test_weighted_funding.js scripts/test_funding_display.js scripts/test_spot_dca.js
```

正式服务由 `server.js` 启动该模块。生产保持现有 PM2 单进程 Fork 模式，部署后手动重启，保留历史存档。
