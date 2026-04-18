require('dotenv').config();

const express = require('express');
const axios = require('axios');
const moment = require('moment');

// ================= 环境变量与常量 =================
const PORT = parseInt(process.env.PORT, 10) || 3001;

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_RECEIVE_ID_TYPE = process.env.FEISHU_RECEIVE_ID_TYPE || '';
const FEISHU_RECEIVE_ID = process.env.FEISHU_RECEIVE_ID || '';
const VALID_RECEIVE_TYPES = ['open_id', 'union_id', 'user_id', 'email', 'chat_id'];

const CONFIG_AUTH_TOKEN = process.env.CONFIG_AUTH_TOKEN || '';

const MIN_REVERSAL_PCT = parseFloat(process.env.MIN_REVERSAL_PCT) || 0.0005; // 默认 0.05%
const CONFIRM_COUNT = parseInt(process.env.CONFIRM_COUNT, 10) || 2;
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 10000;
const BINANCE_TIMEOUT_MS = parseInt(process.env.BINANCE_TIMEOUT_MS, 10) || 10000;

// SSRF 防御: 是否允许 webhook 指向内网/回环地址 (仅在内网中间件场景显式开启)
const ALLOW_INTERNAL_WEBHOOK = String(process.env.ALLOW_INTERNAL_WEBHOOK || '').toLowerCase() === 'true';

// ========== 日内超短线 - 近 1 小时瞬时费率均值铁律参数 ==========
// 策略核心信号: 过去 1 小时瞬时预测费率的平均值
//   均值 >  +RATE1H_MIN_ABS  → 近期多头拥挤 → 跟主力做空
//   均值 <  -RATE1H_MIN_ABS  → 近期空头拥挤 → 跟主力做多
//   |均值| <= RATE1H_MIN_ABS → 市场中性, 不开仓
const RATE1H_MIN_ABS = parseFloat(process.env.RATE1H_MIN_ABS) || 0.00005; // 默认 0.5bp
// 最少需要多少个采样点才视为"1 小时均值有效" (默认 10 = 约 15 分钟采样, 避免冷启动)
const RATE1H_MIN_SAMPLES = parseInt(process.env.RATE1H_MIN_SAMPLES, 10) || 10;

// 资金费率突变告警阈值 (单位: 小数, 0.0005 = 5bp) - 仅用于预测费率突变告警, 不用于策略判断
const RATE_JUMP_ALERT_THRESHOLD = 0.0005;
// premiumIndex 轮询周期
const POLL_INTERVAL_MS = 90 * 1000;
// 飞书心跳周期
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000;

// 启动时的环境校验
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_RECEIVE_ID || !FEISHU_RECEIVE_ID_TYPE) {
    console.warn('⚠️  飞书相关环境变量未完全配置，飞书告警将被静默跳过。');
}
if (FEISHU_RECEIVE_ID_TYPE && !VALID_RECEIVE_TYPES.includes(FEISHU_RECEIVE_ID_TYPE)) {
    console.warn(`⚠️  FEISHU_RECEIVE_ID_TYPE=${FEISHU_RECEIVE_ID_TYPE} 非法, 合法值: ${VALID_RECEIVE_TYPES.join(', ')}。飞书告警将失败。`);
}
if (!CONFIG_AUTH_TOKEN) {
    console.warn('⚠️  CONFIG_AUTH_TOKEN 未设置，/api/config 和 /api/reset 将拒绝所有请求（防止裸奔）。');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ================= 运行态 =================
let state = {
    resistancePrice: null,
    supportPrice: null,
    webhookUrl: null,
    shortPayload: null,
    longPayload: null,

    // 假突破/假跌破 状态机
    hasBrokenResistance: false,
    hasBrokenSupport: false,
    // 突破后的极端价（开空用最高价, 开多用最低价）——用于计算最小反转幅度
    breakHighPrice: null,
    breakLowPrice: null,
    // 回落/反弹的连续确认次数 (防 tick 抖动误触发)
    reversalConfirmShort: 0,
    reversalConfirmLong: 0,

    isLocked: false,
    isHoldingPosition: false,
    // 开仓流转状态：idle | pending | confirmed | failed
    orderStatus: 'idle',
    lastOrderError: null,
    // 会话 ID: 每次 config/reset 自增, 用于让正在 pending 的 executeOrder 在响应返回时
    // 识别自己是否已被作废 (防止 reset/reconfig 与正在飞的 webhook 请求产生脏状态)
    sessionId: 0,

    historyData: [],      // 币安8小时已结算费率历史 (60 条)
    realTimeHistory: [],  // 每轮轮询采样的"瞬时预测费率"快照 (60 条 ~ 90分钟)
    rate1hHistory: [],    // 每轮轮询采样的"近 1H 均值"快照 (240 条 ~ 6小时, 便于观察情绪趋势)

    // 8 小时周期的"上一次已结算费率" (来自 premiumIndex.lastFundingRate, 每 8 小时更新一次)
    lastSettledFundingRate: null,

    // 瞬时预测费率 (每 90s 采样一次, 用于算 1h 均值和给前端展示)
    predictedFundingRate: null,
    prevPredictedFundingRate: null,

    // 【日内超短线核心铁律】近 1 小时瞬时费率均值分析
    // rate1hDirection: 'long_crowded' (多头拥挤→可做空) / 'short_crowded' (空头拥挤→可做多) / 'neutral' (中性, 不开仓) / 'warming_up' (采样不足)
    // rate1hSamples: 过去 1h 实际采样点数
    // isStrongSignal: 瞬时费率与 1h 均值同向 (双重确认, 标记为强信号)
    // isReversalWarning: 瞬时费率与 1h 均值反向 (近期情绪可能翻转, 开仓但警告)
    rate1hDirection: 'warming_up',
    rate1hSamples: 0,
    isStrongSignal: false,
    isReversalWarning: false,

    // 供前端展示/策略判断使用
    currentPrice: 0,
    indexPrice: 0,
    interestRate: 0,
    rate1hAvg: null,         // 过去 1 小时 predictedFundingRate 的均值, null 表示未就绪
    rateDailySettledSum: null, // UTC 今日已结算费率累加, null 表示未就绪
    rateDailyWithPredict: null // 今日已结算累加 + 当前预测
};

// ================= 工具方法 =================
const LAST_ERROR_MAX_LEN = 500;

function truncateError(str) {
    if (typeof str !== 'string') return String(str);
    return str.length > LAST_ERROR_MAX_LEN ? str.slice(0, LAST_ERROR_MAX_LEN) + '...(truncated)' : str;
}

function maskToken(token) {
    if (!token) return '';
    if (token.length <= 6) return '***';
    return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

// 判断 hostname 是否为内网 / 回环 / 保留地址
// 关键点:
//   - 域名: 仅 localhost / *.localhost / *.local / *.internal 视为内网 (不匹配 "fcompany.com" 等合法域名)
//   - IPv4 字面量: 覆盖 10/8, 127/8, 0/8, 169.254/16, 172.16-31/12, 192.168/16, 224+
//   - IPv6 字面量 (必须含冒号才匹配 IPv6 规则, 避免把域名误判为 IPv6):
//       ::1 (loopback) / fc00::/7 (ULA, 即 fc 或 fd 开头) / fe80::/10 (link-local) / ::ffff:<ipv4-mapped>
function isInternalHost(hostname) {
    if (!hostname) return true;
    const h = hostname.toLowerCase();

    // 域名特判 (localhost 及保留 TLD)
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

    // IPv4 字面量
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a >= 224) return true;
        return false;
    }

    // IPv6 字面量 (URL 解析后 hostname 不带 [], 但仍包含冒号)
    if (h.includes(':')) {
        if (h === '::' || h === '::1') return true;
        // fc00::/7 = fc00:: ~ fdff::
        if (/^fc[0-9a-f]{0,2}:/.test(h) || h === 'fc' || /^fd[0-9a-f]{0,2}:/.test(h) || h === 'fd') return true;
        // fe80::/10 link-local
        if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
        // ::ffff:<ipv4> IPv4-mapped IPv6. 提取尾部 IPv4 再递归判断
        const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        if (mapped) return isInternalHost(mapped[1]);
        // 其它 IPv6 形如 2001:db8::1 / 240e::... 都是公网或文档地址, 不拦
        return false;
    }

    // 其它域名一律视为公网
    return false;
}

function isValidHttpUrl(str) {
    if (typeof str !== 'string') return false;
    try {
        const u = new URL(str);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        if (!ALLOW_INTERNAL_WEBHOOK && isInternalHost(u.hostname)) return false;
        return true;
    } catch (_) {
        return false;
    }
}

function authMiddleware(req, res, next) {
    if (!CONFIG_AUTH_TOKEN) {
        return res.status(503).json({ error: '服务端未设置 CONFIG_AUTH_TOKEN, 已禁用所有修改型接口以防止裸奔。' });
    }
    const token = req.headers['x-auth-token'];
    if (token !== CONFIG_AUTH_TOKEN) {
        return res.status(401).json({ error: '鉴权失败: X-Auth-Token 请求头缺失或错误。' });
    }
    return next();
}

// 脱敏后的 state，仅用于 /api/status
function getPublicState() {
    const masked = { ...state };
    if (masked.webhookUrl) {
        masked.webhookUrl = maskToken(masked.webhookUrl);
    }
    // 报文里可能包含 API Key 等敏感字段，前端只需要知道"有没有配置"
    masked.shortPayloadConfigured = !!state.shortPayload;
    masked.longPayloadConfigured = !!state.longPayload;
    delete masked.shortPayload;
    delete masked.longPayload;
    return masked;
}

// ================= 飞书通知模块 =================
let feishuToken = '';
let feishuTokenExpire = 0;
let feishuTokenPromise = null; // single-flight: 避免并发 sendFeishuMsg 触发多次 token 获取

async function getFeishuToken() {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return null;
    if (feishuToken && Date.now() < feishuTokenExpire) return feishuToken;
    // 已有 pending 请求 → 复用, 避免并发打多次 token 接口
    if (feishuTokenPromise) return feishuTokenPromise;

    feishuTokenPromise = (async () => {
        try {
            const res = await axios.post(
                'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
                { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
                { timeout: 10000 }
            );
            if (res.data.code === 0) {
                feishuToken = res.data.tenant_access_token;
                feishuTokenExpire = Date.now() + (res.data.expire * 1000) - 60000;
                return feishuToken;
            }
            console.error('获取飞书 Token 失败, 业务错误:', res.data);
        } catch (e) {
            console.error('获取飞书 Token 失败:', e.message);
        }
        return null;
    })().finally(() => {
        feishuTokenPromise = null;
    });
    return feishuTokenPromise;
}

// 消息串行队列: 保证 sendFeishuMsg 调用的发送顺序 (避免并发 axios 请求到达飞书时顺序错乱)
let feishuQueue = Promise.resolve();
const FEISHU_QUEUE_MAX_DEPTH = 50;
let feishuQueueDepth = 0;

async function feishuSendImpl(title, text, isAlert) {
    if (!FEISHU_RECEIVE_ID || !FEISHU_RECEIVE_ID_TYPE || !VALID_RECEIVE_TYPES.includes(FEISHU_RECEIVE_ID_TYPE)) {
        console.log(`[飞书通知跳过] 未正确配置接收方 (type=${FEISHU_RECEIVE_ID_TYPE}): ${title}`);
        return;
    }
    const token = await getFeishuToken();
    if (!token) return;

    try {
        const msgType = isAlert ? 'post' : 'text';
        const contentStr = isAlert
            ? JSON.stringify({ zh_cn: { title: title, content: [[{ tag: 'text', text: text }]] } })
            : JSON.stringify({ text: `${title}\n${text}` });

        const resp = await axios.post(
            `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${FEISHU_RECEIVE_ID_TYPE}`,
            { receive_id: FEISHU_RECEIVE_ID, msg_type: msgType, content: contentStr },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );
        if (resp.data && resp.data.code !== 0) {
            console.error('飞书接口业务错误:', resp.data);
        }
    } catch (err) {
        console.error('飞书通知发送失败:', err.response?.data?.msg || err.message);
    }
}

function sendFeishuMsg(title, text, isAlert = false) {
    if (feishuQueueDepth >= FEISHU_QUEUE_MAX_DEPTH) {
        console.warn(`[飞书队列溢出] 已有 ${feishuQueueDepth} 条 pending, 丢弃: ${title}`);
        return;
    }
    feishuQueueDepth++;
    feishuQueue = feishuQueue
        .then(() => feishuSendImpl(title, text, isAlert))
        .catch(e => console.error('飞书队列异常:', e.message))
        .finally(() => { feishuQueueDepth--; });
}

// ================= 近 1 小时瞬时费率均值分析 (日内超短线铁律核心) =================
// 输入:
//   rate1hAvg: 已在 fetchBinanceData 里算好的 1h 均值 (null 表示尚未就绪)
//   sampleCount: 1h 窗口内实际采样点数
//   predictedRate: 当前瞬时预测费率 (用于与均值做符号对比)
// 返回: { direction, samples, isStrong, isReversalWarning }
//   direction: 'long_crowded' / 'short_crowded' / 'neutral' / 'warming_up'
function analyze1hRate(rate1hAvg, sampleCount, predictedRate) {
    const result = {
        direction: 'warming_up',
        samples: sampleCount || 0,
        isStrong: false,
        isReversalWarning: false
    };

    // 采样点不足 → 暖机中, 不开仓
    if (!sampleCount || sampleCount < RATE1H_MIN_SAMPLES) {
        result.direction = 'warming_up';
        return result;
    }
    if (typeof rate1hAvg !== 'number' || !Number.isFinite(rate1hAvg)) {
        result.direction = 'warming_up';
        return result;
    }

    // 均值绝对值不够 → 市场中性
    if (Math.abs(rate1hAvg) < RATE1H_MIN_ABS) {
        result.direction = 'neutral';
        return result;
    }

    // 判定方向
    const sign = rate1hAvg > 0 ? 1 : -1;
    result.direction = sign > 0 ? 'long_crowded' : 'short_crowded';

    // 对比瞬时费率: 同向=强信号, 反向=转向警告
    if (typeof predictedRate === 'number' && Number.isFinite(predictedRate)) {
        const sameSign = (predictedRate > 0 && sign > 0) || (predictedRate < 0 && sign < 0);
        if (sameSign) {
            result.isStrong = true;
        } else if (Math.sign(predictedRate) !== 0 && Math.sign(predictedRate) !== sign) {
            // 瞬时和 1h 均值符号相反 → 近期情绪可能刚刚翻转
            result.isReversalWarning = true;
        }
    }

    return result;
}

// ================= 核心盯盘逻辑 =================
let isFetching = false;

function resetBreakState(side) {
    if (side === 'short' || side === 'both') {
        state.hasBrokenResistance = false;
        state.breakHighPrice = null;
        state.reversalConfirmShort = 0;
    }
    if (side === 'long' || side === 'both') {
        state.hasBrokenSupport = false;
        state.breakLowPrice = null;
        state.reversalConfirmLong = 0;
    }
}

async function fetchBinanceData() {
    if (isFetching) return;
    isFetching = true;

    try {
        const premiumRes = await axios.get(
            'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',
            { timeout: BINANCE_TIMEOUT_MS }
        );
        const d = premiumRes.data || {};
        const price = parseFloat(d.markPrice);
        const indexPrice = parseFloat(d.indexPrice);
        const interestRate = parseFloat(d.interestRate);
        const lastSettledFundingRate = parseFloat(d.lastFundingRate); // 上一期已结算, 每 8h 更新

        if (
            !Number.isFinite(price) ||
            !Number.isFinite(indexPrice) || indexPrice <= 0 ||
            !Number.isFinite(interestRate) ||
            !Number.isFinite(lastSettledFundingRate)
        ) {
            console.error('⚠️ 币安 API 返回无效数据, 跳过本轮。', d);
            return;
        }

        // 计算真正的"实时预测下一期资金费率"
        // 参考币安官方公式: FundingRate = premium + clamp(interestRate - premium, -0.0005, 0.0005)
        // 注意: 币安的 clamp 边界是 0.05% (即 0.0005), 不是 5%
        const premium = (price - indexPrice) / indexPrice;
        const clamp = Math.max(-0.0005, Math.min(0.0005, interestRate - premium));
        const predictedFundingRate = parseFloat((premium + clamp).toFixed(10));

        const fundingRes = await axios.get(
            'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=60',
            { timeout: BINANCE_TIMEOUT_MS }
        );
        const fundingHistory = fundingRes.data;

        state.historyData = fundingHistory.map(item => ({
            time: item.fundingTime,
            rate: parseFloat(item.fundingRate)
        }));

        // 1 小时均值 (对 predictedFundingRate 的历史采样取平均)
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        let sum1h = 0;
        let count1h = 0;
        state.realTimeHistory.forEach(item => {
            if (item.time >= oneHourAgo) {
                sum1h += item.rate;
                count1h++;
            }
        });
        const rate1hAvg = count1h > 0 ? (sum1h / count1h) : predictedFundingRate;

        // 日线已结算累计 (UTC) + 当前预测
        const todayStart = moment.utc().startOf('day').valueOf();
        let settledRateToday = 0;
        fundingHistory.forEach(item => {
            if (item.fundingTime >= todayStart) {
                settledRateToday += parseFloat(item.fundingRate);
            }
        });
        const rateDailySettledSum = parseFloat(settledRateToday.toFixed(8));
        const rateDailyWithPredict = parseFloat((settledRateToday + predictedFundingRate).toFixed(8));

        // 费率突变告警: 对真正的"预测费率"做跳变比较
        if (
            state.prevPredictedFundingRate !== null &&
            Math.abs(predictedFundingRate - state.prevPredictedFundingRate) > RATE_JUMP_ALERT_THRESHOLD
        ) {
            sendFeishuMsg(
                '🚨 预测资金费率突变警报',
                `原预测费率: ${(state.prevPredictedFundingRate * 100).toFixed(4)}%\n现预测费率: ${(predictedFundingRate * 100).toFixed(4)}%`,
                true
            );
        }
        state.prevPredictedFundingRate = predictedFundingRate;

        // 【日内超短线核心】近 1 小时瞬时费率均值分析
        // 注意: rate1hAvg 和 count1h 已经在上面计算好 (基于 realTimeHistory, 不含本轮新 push 的点)
        // 为了让分析包含本轮最新点, 临时把它计入
        const rate1hAvgInclCurrent = count1h > 0
            ? (sum1h + predictedFundingRate) / (count1h + 1)
            : predictedFundingRate;
        const samplesInclCurrent = count1h + 1;
        const analysis = analyze1hRate(rate1hAvgInclCurrent, samplesInclCurrent, predictedFundingRate);
        state.rate1hDirection = analysis.direction;
        state.rate1hSamples = analysis.samples;
        state.isStrongSignal = analysis.isStrong;
        state.isReversalWarning = analysis.isReversalWarning;

        state.lastSettledFundingRate = lastSettledFundingRate;
        state.predictedFundingRate = predictedFundingRate;
        state.currentPrice = price;
        state.indexPrice = indexPrice;
        state.interestRate = interestRate;
        state.rate1hAvg = rate1hAvgInclCurrent; // 用包含本轮的值, 供前端和策略判断
        state.rateDailySettledSum = rateDailySettledSum;
        state.rateDailyWithPredict = rateDailyWithPredict;

        const nowTs = Date.now();
        state.realTimeHistory.push({ time: nowTs, rate: predictedFundingRate });
        if (state.realTimeHistory.length > 60) state.realTimeHistory.shift();

        // 1H 均值走势: 保留 240 条 (每 90s 一点, ~6 小时), 只在有效时才记录 (暖机完成)
        if (state.rate1hDirection !== 'warming_up' && Number.isFinite(rate1hAvgInclCurrent)) {
            state.rate1hHistory.push({ time: nowTs, rate: rate1hAvgInclCurrent });
            if (state.rate1hHistory.length > 240) state.rate1hHistory.shift();
        }

        // ================= 终端输出 =================
        let directionStr = '监控中';
        if (!state.isLocked) directionStr = '配置未锁定 (暂停监控)';
        else if (state.isHoldingPosition) directionStr = '持仓中 (屏蔽新信号)';
        else if (state.hasBrokenResistance) directionStr = '已触及阻力, 等待回落确认...';
        else if (state.hasBrokenSupport) directionStr = '已触及支撑, 等待反弹确认...';

        let rate1hLabel;
        if (state.rate1hDirection === 'long_crowded') rate1hLabel = `多头拥挤(可做空)${state.isStrongSignal ? '🔥' : state.isReversalWarning ? '⚠️' : ''}`;
        else if (state.rate1hDirection === 'short_crowded') rate1hLabel = `空头拥挤(可做多)${state.isStrongSignal ? '🔥' : state.isReversalWarning ? '⚠️' : ''}`;
        else if (state.rate1hDirection === 'warming_up') rate1hLabel = `暖机中(${state.rate1hSamples}/${RATE1H_MIN_SAMPLES})`;
        else rate1hLabel = '中性';
        const rate1hAvgStr = Number.isFinite(state.rate1hAvg) ? (state.rate1hAvg * 100).toFixed(4) + '%' : '--';

        console.log(
            `[${moment().format('HH:mm:ss')}] 价: ${price.toFixed(2)} | 瞬时: ${(predictedFundingRate * 100).toFixed(4)}% | 近1H均值: ${rate1hAvgStr} (${rate1hLabel}) | 上期结算: ${(lastSettledFundingRate * 100).toFixed(4)}% | 状态: ${directionStr}`
        );

        // ================= 策略判断 =================
        if (!state.isLocked) return;
        if (state.isHoldingPosition) return;
        if (state.orderStatus === 'pending') return; // 正在发送开仓请求, 本轮不再判断

        // 配置健壮性兜底
        if (!Number.isFinite(state.resistancePrice) || !Number.isFinite(state.supportPrice)) return;
        if (state.resistancePrice <= state.supportPrice) return; // 理论上 /api/config 已拦截, 双重保险

        // 阶段 1: 判断是否触及阻力/支撑, 并记录突破极端价
        // 注意: 当价格从"已突破阻力"直接穿透到支撑价以下, 说明市场已进入真正的单边下跌,
        // 此时继续等待"假突破回落"没有意义, 必须立刻清空向上突破状态 (反之亦然)
        if (state.hasBrokenResistance && price <= state.supportPrice) {
            console.log('⚠️ 价格已穿透支撑价, 取消待回落做空监控 (市场进入真正下跌)');
            sendFeishuMsg(
                '⚠️ 穿透对立面, 取消假突破',
                `价格 ${price} 已跌破支撑位 ${state.supportPrice}, 之前的"突破阻力等待回落"状态机已清空, 改为监控支撑反弹。`
            );
            resetBreakState('short');
        }
        if (state.hasBrokenSupport && price >= state.resistancePrice) {
            console.log('⚠️ 价格已穿透阻力价, 取消待反弹做多监控 (市场进入真正上涨)');
            sendFeishuMsg(
                '⚠️ 穿透对立面, 取消假跌破',
                `价格 ${price} 已突破阻力位 ${state.resistancePrice}, 之前的"跌破支撑等待反弹"状态机已清空, 改为监控阻力回落。`
            );
            resetBreakState('long');
        }

        if (price >= state.resistancePrice) {
            if (!state.hasBrokenResistance) {
                state.hasBrokenResistance = true;
                state.breakHighPrice = price;
                state.reversalConfirmShort = 0;
                sendFeishuMsg(
                    '⚠️ 向上突破阻力位',
                    `当前价格 ${price} 触及/突破阻力位 ${state.resistancePrice}, 记录极端价并等待回落确认...`
                );
            } else {
                // 已在突破状态, 价格又回到阻力上方
                //   - 若创新高: 刷新 breakHighPrice
                //   - 无论是否创新高: 由于价格重新站上阻力, "回落"过程中断, 需重置确认计数
                if (price > (state.breakHighPrice || 0)) {
                    state.breakHighPrice = price;
                }
                state.reversalConfirmShort = 0;
            }
        }

        if (price <= state.supportPrice) {
            if (!state.hasBrokenSupport) {
                state.hasBrokenSupport = true;
                state.breakLowPrice = price;
                state.reversalConfirmLong = 0;
                sendFeishuMsg(
                    '⚠️ 向下跌破支撑位',
                    `当前价格 ${price} 触及/跌破支撑位 ${state.supportPrice}, 记录极端价并等待反弹确认...`
                );
            } else {
                if (price < (state.breakLowPrice || Infinity)) {
                    state.breakLowPrice = price;
                }
                state.reversalConfirmLong = 0;
            }
        }

        // 阶段 2: 回落/反弹确认 + 资金费率方向校验 + 最小幅度校验
        // 关键: "连续确认" 语义要求每一次轮询都必须满足最小反转幅度;
        //       若本轮回落幅度不足, 必须重置计数, 否则会退化为 "累计确认"
        // 做空 (假突破)
        if (state.hasBrokenResistance && price < state.resistancePrice) {
            const reversalPct =
                state.breakHighPrice && state.breakHighPrice > 0
                    ? (state.breakHighPrice - price) / state.breakHighPrice
                    : 0;

            if (reversalPct >= MIN_REVERSAL_PCT) {
                state.reversalConfirmShort += 1;
                if (state.reversalConfirmShort >= CONFIRM_COUNT) {
                    // 【日内超短线铁律】做空需要"多头拥挤" → 主力即将向下猎杀多头
                    if (state.rate1hDirection === 'long_crowded') {
                        if (!state.webhookUrl || !state.shortPayload) {
                            console.error('🚫 未配置 Webhook 或做空报文, 无法执行开空');
                            sendFeishuMsg('🚫 开空失败', '满足假突破条件, 但未配置 Webhook 或做空报文。');
                            resetBreakState('short');
                        } else {
                            let strength = '✅ 正常信号';
                            if (state.isStrongSignal) strength = '🔥 强信号 (瞬时+近1H均值 双同向)';
                            else if (state.isReversalWarning) strength = '⚠️ 转向警告 (瞬时已翻负, 近1H均值仍为正)';
                            sendFeishuMsg(
                                '🎯 假突破开空确认 - 猎杀多头',
                                `${strength}\n` +
                                `极端高点 ${state.breakHighPrice} → 回落至 ${price} (幅度 ${(reversalPct * 100).toFixed(3)}%)\n` +
                                `近 1H 瞬时费率均值: ${(state.rate1hAvg * 100).toFixed(4)}% > 0 (采样 ${state.rate1hSamples} 点)\n` +
                                `当下瞬时: ${(predictedFundingRate * 100).toFixed(4)}%, 准备开空!`
                            );
                            await executeOrder('short', price, state.rate1hAvg);
                        }
                    } else {
                        const reason = state.rate1hDirection === 'short_crowded'
                            ? `空头拥挤 (近1H均值 ${(state.rate1hAvg * 100).toFixed(4)}% < 0)`
                            : state.rate1hDirection === 'warming_up'
                                ? `暖机中 (近1H采样 ${state.rate1hSamples}/${RATE1H_MIN_SAMPLES} 不足)`
                                : `市场中性 (近1H均值 ${Number.isFinite(state.rate1hAvg) ? (state.rate1hAvg * 100).toFixed(4) + '%' : '--'})`;
                        sendFeishuMsg(
                            '🚫 假突破取消 (近1H情绪不符)',
                            `价格已回落, 但近 1 小时瞬时费率均值方向为 ${reason}, 不符合做空铁律 (需多头拥挤)。已重置状态等待下一次机会。`
                        );
                        console.log(`🚫 假突破但近1H方向=${state.rate1hDirection}, 取消开空`);
                        resetBreakState('short');
                    }
                }
            } else if (state.reversalConfirmShort > 0) {
                console.log(`↩️ 回落幅度 ${(reversalPct * 100).toFixed(4)}% 不足 ${(MIN_REVERSAL_PCT * 100).toFixed(4)}%, 重置做空确认计数`);
                state.reversalConfirmShort = 0;
            }
        }

        // 做多 (假跌破) - 需要"空头拥挤" → 主力即将向上猎杀空头
        if (state.hasBrokenSupport && price > state.supportPrice) {
            const reversalPct =
                state.breakLowPrice && state.breakLowPrice > 0
                    ? (price - state.breakLowPrice) / state.breakLowPrice
                    : 0;

            if (reversalPct >= MIN_REVERSAL_PCT) {
                state.reversalConfirmLong += 1;
                if (state.reversalConfirmLong >= CONFIRM_COUNT) {
                    if (state.rate1hDirection === 'short_crowded') {
                        if (!state.webhookUrl || !state.longPayload) {
                            console.error('🚫 未配置 Webhook 或做多报文, 无法执行开多');
                            sendFeishuMsg('🚫 开多失败', '满足假跌破条件, 但未配置 Webhook 或做多报文。');
                            resetBreakState('long');
                        } else {
                            let strength = '✅ 正常信号';
                            if (state.isStrongSignal) strength = '🔥 强信号 (瞬时+近1H均值 双同向)';
                            else if (state.isReversalWarning) strength = '⚠️ 转向警告 (瞬时已翻正, 近1H均值仍为负)';
                            sendFeishuMsg(
                                '🎯 假跌破开多确认 - 猎杀空头',
                                `${strength}\n` +
                                `极端低点 ${state.breakLowPrice} → 反弹至 ${price} (幅度 ${(reversalPct * 100).toFixed(3)}%)\n` +
                                `近 1H 瞬时费率均值: ${(state.rate1hAvg * 100).toFixed(4)}% < 0 (采样 ${state.rate1hSamples} 点)\n` +
                                `当下瞬时: ${(predictedFundingRate * 100).toFixed(4)}%, 准备开多!`
                            );
                            await executeOrder('long', price, state.rate1hAvg);
                        }
                    } else {
                        const reason = state.rate1hDirection === 'long_crowded'
                            ? `多头拥挤 (近1H均值 ${(state.rate1hAvg * 100).toFixed(4)}% > 0)`
                            : state.rate1hDirection === 'warming_up'
                                ? `暖机中 (近1H采样 ${state.rate1hSamples}/${RATE1H_MIN_SAMPLES} 不足)`
                                : `市场中性 (近1H均值 ${Number.isFinite(state.rate1hAvg) ? (state.rate1hAvg * 100).toFixed(4) + '%' : '--'})`;
                        sendFeishuMsg(
                            '🚫 假跌破取消 (近1H情绪不符)',
                            `价格已反弹, 但近 1 小时瞬时费率均值方向为 ${reason}, 不符合做多铁律 (需空头拥挤)。已重置状态等待下一次机会。`
                        );
                        console.log(`🚫 假跌破但近1H方向=${state.rate1hDirection}, 取消开多`);
                        resetBreakState('long');
                    }
                }
            } else if (state.reversalConfirmLong > 0) {
                console.log(`↩️ 反弹幅度 ${(reversalPct * 100).toFixed(4)}% 不足 ${(MIN_REVERSAL_PCT * 100).toFixed(4)}%, 重置做多确认计数`);
                state.reversalConfirmLong = 0;
            }
        }
    } catch (error) {
        console.error('盯盘轮询失败:', error.message);
    } finally {
        isFetching = false;
    }
}

// ================= 执行开仓 (Webhook) =================
async function executeOrder(type, price, rate) {
    const action = type === 'short' ? 'open_short' : 'open_long';
    const basePayload = type === 'short' ? state.shortPayload : state.longPayload;
    // 捕获本次 executeOrder 调用的会话 ID. 若在 await 期间用户调用 /api/reset 或 /api/config,
    // 会话 ID 会发生变化, 响应返回时我们必须放弃对 state 的任何写操作.
    const mySession = state.sessionId;
    const sessionValid = () => state.sessionId === mySession;

    if (!state.webhookUrl || !basePayload) {
        console.error(`🚫 未配置 Webhook 或 ${action} 报文, 放弃执行`);
        return;
    }

    state.orderStatus = 'pending';
    state.lastOrderError = null;

    // 动态替换 {{timenow}} (在挂持仓锁之前做, 因为解析失败时没有任何 HTTP 请求发出)
    let payloadStr = JSON.stringify(basePayload);
    payloadStr = payloadStr.replace(/{{timenow}}/g, moment().format('YYYY-MM-DD HH:mm:ss'));
    let payload;
    try {
        payload = JSON.parse(payloadStr);
    } catch (e) {
        if (sessionValid()) {
            state.orderStatus = 'failed';
            state.lastOrderError = truncateError(`报文模板解析失败: ${e.message}`);
            state.isHoldingPosition = false;
            resetBreakState(type);
        }
        console.error('🚨 报文 JSON 解析失败, 未发送请求, 已释放持仓锁并等待用户修复配置:', e.message);
        sendFeishuMsg(
            '🚨 报文解析失败',
            `动作: ${action} 的 payload 模板在替换 {{timenow}} 后无法解析: ${e.message}\n\n未发送任何 HTTP 请求, 系统已释放持仓锁。请解锁并修复做空/做多报文!`,
            true
        );
        return;
    }

    // 报文校验通过, 真正进入发送流程才挂锁
    state.isHoldingPosition = true;

    try {
        console.log('\n================ 开仓信号触发 ================');
        console.log(`执行动作: ${action} | 成交价格: ${price} | 费率: ${(rate * 100).toFixed(4)}%`);

        const res = await axios.post(state.webhookUrl, payload, { timeout: WEBHOOK_TIMEOUT_MS });
        console.log(`Webhook HTTP 响应: ${res.status}`);
        console.log('==============================================\n');

        // 业务语义校验:
        //  - body 是对象: 检查 success / ok / code / status / error 字段
        //  - body 是字符串: 检查是否包含失败关键字
        //  - body 为 null/undefined/数组: 按 HTTP 2xx 视为成功
        const body = res.data;
        const isObj = body && typeof body === 'object' && !Array.isArray(body);
        const successCodes = new Set([0, 200, '0', '200', 'ok', 'OK', 'success', 'SUCCESS']);
        const failureStatus = new Set(['failed', 'FAILED', 'error', 'ERROR', 'fail', 'FAIL']);

        let businessFailed = false;
        if (isObj) {
            businessFailed = (
                body.success === false ||
                body.ok === false ||
                (typeof body.code !== 'undefined' && !successCodes.has(body.code)) ||
                (typeof body.status === 'string' && failureStatus.has(body.status)) ||
                (typeof body.error !== 'undefined' && body.error !== null && body.error !== '' && body.error !== false)
            );
        } else if (typeof body === 'string' && body.trim()) {
            const lower = body.toLowerCase();
            businessFailed = /\b(failed|failure|error|exception|insufficient|rejected|denied|invalid)\b/.test(lower);
        }

        if (businessFailed) {
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            if (sessionValid()) {
                state.orderStatus = 'failed';
                state.lastOrderError = truncateError(`Webhook 业务失败: ${bodyStr}`);
                state.isHoldingPosition = false;
                resetBreakState(type);
            } else {
                console.warn('⚠️ executeOrder 业务失败但会话已变更 (用户已 reset/reconfig), 忽略 state 写回');
            }
            console.error('🚨 Webhook 返回业务失败, 已释放持仓锁:', body);
            sendFeishuMsg(
                '🚨 开仓业务失败',
                `动作: ${action}\n成交价: ${price}\n费率: ${(rate * 100).toFixed(4)}%\nWebhook 响应: ${bodyStr.slice(0, 500)}\n\n已释放持仓锁, 系统继续监控。请排查交易中间件!`,
                true
            );
            return;
        }

        // 正常成功, 锁定成功并清理状态机 (仅在会话仍有效时写 state)
        if (sessionValid()) {
            state.orderStatus = 'confirmed';
            resetBreakState(type);
        } else {
            console.warn('⚠️ executeOrder 成功返回, 但本次会话已被 reset/reconfig 作废, 不再写回 state (实际仓位需人工检查交易所!)');
            sendFeishuMsg(
                '⚠️ Webhook 成功返回但会话已作废',
                `动作: ${action} 的 webhook 已成功返回, 但期间用户触发了 reset/reconfig, 实际仓位已脱离系统跟踪!\n请立刻登录交易所确认仓位!`,
                true
            );
            return;
        }

        sendFeishuMsg(
            '🔥 开仓信号已触发 (假突破/跌破)',
            `动作: ${action}\n成交价: ${price}\n触发费率: ${(rate * 100).toFixed(4)}%\n\n✅ 已进入持仓状态, 屏蔽后续新开仓信号。`
        );
    } catch (err) {
        // 网络/超时类错误: 无法确定是否真的开仓成功, 坚决不释放持仓锁
        if (sessionValid()) {
            state.orderStatus = 'failed';
            state.lastOrderError = truncateError(String(err.message || err));
            // 铁律: 不清 resetBreakState, 也不释放 isHoldingPosition
        } else {
            console.warn('⚠️ executeOrder 网络失败但会话已变更, 忽略 state 写回 (仍需人工确认交易所仓位)');
        }
        console.error('🚨 Webhook 发送失败 (无法确认是否成交):', err.message);
        sendFeishuMsg(
            '🚨 Webhook 发送失败 (致命)',
            `动作: ${action} 执行时发生网络/超时错误: ${err.message}\n\n⚠️ 无法确认是否真的开仓! 为防重试爆仓, 系统已锁定持仓状态。请人工登录交易所查看实际仓位!`,
            true
        );
    }
}

// ================= API 路由 =================
app.get('/api/status', (req, res) => {
    res.json(getPublicState());
});

app.post('/api/config', authMiddleware, (req, res) => {
    if (state.isLocked) {
        return res.status(409).json({ error: '策略已锁定, 请先调用 /api/reset 解锁后再修改配置。' });
    }

    const { resistancePrice, supportPrice, webhookUrl, shortPayload, longPayload, confirmRisk } = req.body || {};

    const rp = parseFloat(resistancePrice);
    const sp = parseFloat(supportPrice);
    if (!Number.isFinite(rp) || rp <= 0) return res.status(400).json({ error: '阻力价格必须是正数。' });
    if (!Number.isFinite(sp) || sp <= 0) return res.status(400).json({ error: '支撑价格必须是正数。' });
    if (rp <= sp) return res.status(400).json({ error: '阻力价格必须大于支撑价格。' });

    if (!isValidHttpUrl(webhookUrl)) {
        return res.status(400).json({
            error: 'Webhook 地址必须是合法的 http/https URL, 且不能指向内网/回环地址 (如需使用内网中间件, 请在 .env 中设置 ALLOW_INTERNAL_WEBHOOK=true)。'
        });
    }

    let parsedShort = shortPayload;
    let parsedLong = longPayload;
    try {
        if (typeof parsedShort === 'string') parsedShort = JSON.parse(parsedShort);
        if (typeof parsedLong === 'string') parsedLong = JSON.parse(parsedLong);
    } catch (e) {
        return res.status(400).json({ error: 'JSON 报文格式错误: ' + e.message });
    }

    if (!parsedShort || typeof parsedShort !== 'object' || Array.isArray(parsedShort)) {
        return res.status(400).json({ error: '做空报文必须是非空 JSON 对象。' });
    }
    if (!parsedLong || typeof parsedLong !== 'object' || Array.isArray(parsedLong)) {
        return res.status(400).json({ error: '做多报文必须是非空 JSON 对象。' });
    }

    // 风险防御: 如果 payload 包含 action 字段, 强校验多空不要填反
    if (typeof parsedShort.action !== 'undefined' && parsedShort.action !== 'open_short') {
        return res.status(400).json({ error: '做空报文包含 action 字段但值不是 open_short, 疑似多空填反!' });
    }
    if (typeof parsedLong.action !== 'undefined' && parsedLong.action !== 'open_long') {
        return res.status(400).json({ error: '做多报文包含 action 字段但值不是 open_long, 疑似多空填反!' });
    }
    // 只要任意一侧没有 action 字段, 就无法自动校验多空是否填反, 要求前端显式确认
    const shortHasAction = typeof parsedShort.action !== 'undefined';
    const longHasAction = typeof parsedLong.action !== 'undefined';
    if ((!shortHasAction || !longHasAction) && !confirmRisk) {
        return res.status(400).json({
            error: '做空或做多报文缺少 action 字段, 无法自动校验多空是否填反。请在前端勾选风险确认 (confirmRisk=true) 后再提交。'
        });
    }

    state.resistancePrice = rp;
    state.supportPrice = sp;
    state.webhookUrl = webhookUrl;
    state.shortPayload = parsedShort;
    state.longPayload = parsedLong;
    state.isLocked = true;

    // 新配置锁定 → 状态机清零, 同时清理上一轮残留的订单状态
    resetBreakState('both');
    state.isHoldingPosition = false;
    state.orderStatus = 'idle';
    state.lastOrderError = null;
    // 会话 ID 递增: 让任何正在 pending 的 executeOrder 感知到 "会话已变更", 放弃对 state 的写回
    state.sessionId += 1;

    sendFeishuMsg('🔒 策略已锁定', `阻力: ${rp} | 支撑: ${sp}\n开始盯盘!`);

    res.json({ success: true, state: getPublicState() });
});

app.post('/api/reset', authMiddleware, (req, res) => {
    const { clearHistory } = req.body || {};

    state.isLocked = false;
    state.isHoldingPosition = false;
    state.orderStatus = 'idle';
    state.lastOrderError = null;
    resetBreakState('both');
    // 会话 ID 递增: 让任何正在 pending 的 executeOrder 感知到 "会话已变更", 放弃对 state 的写回
    state.sessionId += 1;

    if (clearHistory) {
        state.historyData = [];
        state.realTimeHistory = [];
        state.rate1hHistory = [];
        state.lastSettledFundingRate = null;
        state.predictedFundingRate = null;
        state.prevPredictedFundingRate = null;
        state.currentPrice = 0;
        state.indexPrice = 0;
        state.interestRate = 0;
        state.rate1hAvg = null;
        state.rateDailySettledSum = null;
        state.rateDailyWithPredict = null;
    }

    sendFeishuMsg('🔓 策略已解锁', `持仓锁定已解除${clearHistory ? ', 历史数据已清空' : ''}。`);
    res.json({ success: true, state: getPublicState() });
});

// ================= 启动 =================
setInterval(fetchBinanceData, POLL_INTERVAL_MS);
fetchBinanceData();

function fmtPctMaybe(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? (v * 100).toFixed(4) + '%' : '--';
}

async function heartbeat() {
    if (state.predictedFundingRate === null) {
        sendFeishuMsg('⏳ 心跳: 尚未取到行情', '服务在线但 Binance 行情尚未首次就绪, 请关注。');
        return;
    }
    let rate1hLabel;
    if (state.rate1hDirection === 'long_crowded') {
        rate1hLabel = `多头拥挤 → 可做空${state.isStrongSignal ? ' 🔥' : state.isReversalWarning ? ' ⚠️' : ''}`;
    } else if (state.rate1hDirection === 'short_crowded') {
        rate1hLabel = `空头拥挤 → 可做多${state.isStrongSignal ? ' 🔥' : state.isReversalWarning ? ' ⚠️' : ''}`;
    } else if (state.rate1hDirection === 'warming_up') {
        rate1hLabel = `暖机中 (${state.rate1hSamples}/${RATE1H_MIN_SAMPLES} 采样)`;
    } else {
        rate1hLabel = '中性 (不开仓)';
    }
    sendFeishuMsg(
        '📊 盯盘心跳',
        `当前价格: ${state.currentPrice || '--'}\n` +
        `🎯 近1H情绪: ${rate1hLabel}\n` +
        `近1H瞬时费率均值: ${fmtPctMaybe(state.rate1hAvg)} (采样 ${state.rate1hSamples} 点)\n` +
        `当下瞬时费率: ${fmtPctMaybe(state.predictedFundingRate)}\n` +
        `上期已结算 (参考): ${fmtPctMaybe(state.lastSettledFundingRate)}`
    );
}
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`量化盯盘服务已启动: http://localhost:${PORT}`);
    console.log(
        `规则: 90s 轮询 | 假突破/跌破 | 最小反转 ${(MIN_REVERSAL_PCT * 100).toFixed(3)}% | 连续确认 ${CONFIRM_COUNT} 次`
    );
    sendFeishuMsg(
        '✅ 盯盘服务已上线',
        `端口: ${PORT}\n策略: 假突破/跌破\n最小反转幅度: ${(MIN_REVERSAL_PCT * 100).toFixed(3)}%\n连续确认次数: ${CONFIRM_COUNT}`
    );
    // 启动后 30 秒再发首次数据心跳 (给首轮 fetchBinanceData 留时间)
    setTimeout(heartbeat, 30 * 1000);
});
