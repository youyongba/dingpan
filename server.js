require('dotenv').config();

const express = require('express');
const axios = require('axios');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const regimeMod = require('./regimeModule');

// ================= 环境变量与常量 =================
const PORT = parseInt(process.env.PORT, 10) || 3001;

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_RECEIVE_ID_TYPE = process.env.FEISHU_RECEIVE_ID_TYPE || '';
const FEISHU_RECEIVE_ID = process.env.FEISHU_RECEIVE_ID || '';
const VALID_RECEIVE_TYPES = ['open_id', 'union_id', 'user_id', 'email', 'chat_id'];

const CONFIG_AUTH_TOKEN = process.env.CONFIG_AUTH_TOKEN || '';

const BINANCE_TIMEOUT_MS = parseInt(process.env.BINANCE_TIMEOUT_MS, 10) || 10000;

// 近 1H 瞬时费率均值铁律参数
const RATE1H_MIN_ABS = parseFloat(process.env.RATE1H_MIN_ABS) || 0.00005; // 默认 0.5bp
const RATE1H_MIN_SAMPLES = parseInt(process.env.RATE1H_MIN_SAMPLES, 10) || 10;

// 资金费率突变告警阈值 (单位: 小数, 0.0005 = 5bp)
const RATE_JUMP_ALERT_THRESHOLD = 0.0005;

// premiumIndex 轮询周期
const POLL_INTERVAL_MS = 90 * 1000;
// 飞书心跳周期 (1 小时定时一次)
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
// 方向变化防抖: 新方向要连续 N 次才触发告警
const DIRECTION_CHANGE_CONFIRM = 2;



// 启动时的环境校验
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_RECEIVE_ID || !FEISHU_RECEIVE_ID_TYPE) {
    console.warn('⚠️  飞书相关环境变量未完全配置，飞书告警将被静默跳过。');
}
if (FEISHU_RECEIVE_ID_TYPE && !VALID_RECEIVE_TYPES.includes(FEISHU_RECEIVE_ID_TYPE)) {
    console.warn(`⚠️  FEISHU_RECEIVE_ID_TYPE=${FEISHU_RECEIVE_ID_TYPE} 非法, 合法值: ${VALID_RECEIVE_TYPES.join(', ')}。`);
}
if (!CONFIG_AUTH_TOKEN) {
    console.warn('⚠️  CONFIG_AUTH_TOKEN 未设置，/api/reset (清空历史数据) 将拒绝所有请求。');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

// === Regime 监控（独立模块）：JSON 接口 + Chart.js 面板 + 飞书通知 ===
app.use('/api/regime', regimeMod.router);
// 直接访问 /regime 即跳转到面板
app.get('/regime', (req, res) => res.redirect('/api/regime/page'));
// 依赖注入：飞书通知（支持富文本 rich / 纯文本 / alert）
// lazy wrapper 避免声明顺序问题
regimeMod.setNotifier((title, body, opts = {}) => {
    if (opts && Array.isArray(opts.rich)) {
        sendFeishuRichMsg(title, opts.rich);
    } else {
        sendFeishuMsg(title, body, !!(opts && opts.isAlert));
    }
});
// 注入资金费率数据 getter，供 regime 模块构造"手动刷新全量快照"消息
regimeMod.setFundingProvider(() => ({
    rate1hAvg: state.rate1hAvg,
    rate1hSamples: state.rate1hSamples,
    rate1hDirection: state.rate1hDirection,
    stableDirection: state.stableDirection,
    predictedFundingRate: state.predictedFundingRate,
    lastSettledFundingRate: state.lastSettledFundingRate,
    currentPrice: state.currentPrice,
    fmtPct: fmtPctMaybe,
}));
// ================= 运行态 =================
let state = {
    historyData: [],      // 币安8小时已结算费率历史 (60 条)
    realTimeHistory: [],  // 每轮轮询采样的"瞬时预测费率"快照 (60 条 ~ 90分钟)
    rate1hHistory: [],    // 每轮轮询采样的"近 1H 均值"快照 (240 条 ~ 6小时)

    lastSettledFundingRate: null, // 上一期已结算费率 (币安返回)
    predictedFundingRate: null,   // 当前瞬时预测费率 (自算)
    prevPredictedFundingRate: null, // 用于突变告警

    // 近 1H 均值情绪分析
    rate1hDirection: 'warming_up',  // warming_up / neutral / long_crowded / short_crowded
    rate1hSamples: 0,
    isStrongSignal: false,          // 瞬时与 1H 均值同向
    isReversalWarning: false,       // 瞬时与 1H 均值反向

    // 方向变化防抖
    stableDirection: 'warming_up',
    pendingDirection: null,
    pendingDirectionCount: 0,

    // 费率均值穿 0 轴检测（只记多/空，neutral 不更新，避免抖动重复推送）
    // null | 'LONG_CROWD' | 'SHORT_CROWD'
    lastCrowdedSignal: null,

    // 当前行情
    currentPrice: 0,
    indexPrice: 0,
    interestRate: 0,
    rate1hAvg: null,
    rateDailySettledSum: null,
    rateDailyWithPredict: null
};

// ================= 工具方法 =================
function authMiddleware(req, res, next) {
    if (!CONFIG_AUTH_TOKEN) {
        return res.status(503).json({ error: '服务端未设置 CONFIG_AUTH_TOKEN, 已禁用 /api/reset 接口。' });
    }
    const token = req.headers['x-auth-token'];
    if (token !== CONFIG_AUTH_TOKEN) {
        return res.status(401).json({ error: '鉴权失败: X-Auth-Token 请求头缺失或错误。' });
    }
    return next();
}

function fmtPctMaybe(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? (v * 100).toFixed(4) + '%' : '--';
}

function formatDirectionLabel(direction, isStrong, isReversal, samples) {
    if (direction === 'long_crowded') return `多头拥挤 → 可做空${isStrong ? ' 🔥' : isReversal ? ' ⚠️' : ''}`;
    if (direction === 'short_crowded') return `空头拥挤 → 可做多${isStrong ? ' 🔥' : isReversal ? ' ⚠️' : ''}`;
    if (direction === 'warming_up') return `暖机中 (${samples || 0}/${RATE1H_MIN_SAMPLES} 采样)`;
    return '中性 (无明显拥挤)';
}

// ================= 飞书通知模块 =================
let feishuToken = '';
let feishuTokenExpire = 0;
let feishuTokenPromise = null;

async function getFeishuToken() {
    if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) return null;
    if (feishuToken && Date.now() < feishuTokenExpire) return feishuToken;
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

// 飞书消息串行队列
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

// ================= 飞书富文本 (post) 消息发送（支持加粗高亮 + 多段多行） =================
/**
 * contentLines 格式：Array<Array<Segment>>  每个子数组代表一行。
 * Segment: { text: string, bold?: boolean, color?: string }
 * 例：
 *   [
 *     [{text:'入场:', bold:true}, {text:' 74783.35'}],
 *     [{text:'止损:', bold:true}, {text:' 75463.89'}]
 *   ]
 */
async function feishuSendRichImpl(title, contentLines, retry = 2) {
    if (!FEISHU_RECEIVE_ID || !FEISHU_RECEIVE_ID_TYPE || !VALID_RECEIVE_TYPES.includes(FEISHU_RECEIVE_ID_TYPE)) {
        console.log(`[飞书通知跳过] 未正确配置接收方 (type=${FEISHU_RECEIVE_ID_TYPE}): ${title}`);
        return;
    }
    const token = await getFeishuToken();
    if (!token) return;

    // 转 Feishu post content 结构
    const post_content = contentLines.map(line =>
        (line.length ? line : [{ text: ' ' }]).map(seg => {
            const node = { tag: 'text', text: String(seg.text ?? '') };
            const style = [];
            if (seg.bold) style.push('bold');
            if (seg.italic) style.push('italic');
            if (style.length) node.style = style;
            return node;
        })
    );

    const contentStr = JSON.stringify({ zh_cn: { title, content: post_content } });
    let lastErr = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
        try {
            const resp = await axios.post(
                `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${FEISHU_RECEIVE_ID_TYPE}`,
                { receive_id: FEISHU_RECEIVE_ID, msg_type: 'post', content: contentStr },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
            );
            if (resp.data && resp.data.code !== 0) {
                console.error('飞书富文本业务错误:', resp.data);
                lastErr = new Error(`biz=${resp.data.code}`);
                // 99991663/99991664 token 过期类错误才重试
                if (![99991663, 99991664].includes(resp.data.code)) return;
            } else {
                return; // 成功
            }
        } catch (err) {
            lastErr = err;
            console.error(`飞书富文本第 ${attempt + 1} 次发送失败:`, err.response?.data?.msg || err.message);
        }
        if (attempt < retry) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
    if (lastErr) console.error('飞书富文本最终失败:', lastErr.message);
}

function sendFeishuRichMsg(title, contentLines) {
    if (feishuQueueDepth >= FEISHU_QUEUE_MAX_DEPTH) {
        console.warn(`[飞书队列溢出] 已有 ${feishuQueueDepth} 条 pending, 丢弃富文本: ${title}`);
        return;
    }
    feishuQueueDepth++;
    feishuQueue = feishuQueue
        .then(() => feishuSendRichImpl(title, contentLines))
        .catch(e => console.error('飞书富文本队列异常:', e.message))
        .finally(() => { feishuQueueDepth--; });
}

// ================= 近 1 小时瞬时费率均值分析 =================
function analyze1hRate(rate1hAvg, sampleCount, predictedRate) {
    const result = {
        direction: 'warming_up',
        samples: sampleCount || 0,
        isStrong: false,
        isReversalWarning: false
    };

    if (!sampleCount || sampleCount < RATE1H_MIN_SAMPLES) {
        result.direction = 'warming_up';
        return result;
    }
    if (typeof rate1hAvg !== 'number' || !Number.isFinite(rate1hAvg)) {
        result.direction = 'warming_up';
        return result;
    }

    if (Math.abs(rate1hAvg) < RATE1H_MIN_ABS) {
        result.direction = 'neutral';
        return result;
    }

    const sign = rate1hAvg > 0 ? 1 : -1;
    result.direction = sign > 0 ? 'long_crowded' : 'short_crowded';

    if (typeof predictedRate === 'number' && Number.isFinite(predictedRate)) {
        const sameSign = (predictedRate > 0 && sign > 0) || (predictedRate < 0 && sign < 0);
        if (sameSign) {
            result.isStrong = true;
        } else if (Math.sign(predictedRate) !== 0 && Math.sign(predictedRate) !== sign) {
            result.isReversalWarning = true;
        }
    }

    return result;
}

// ================= 核心盯盘逻辑 =================
let isFetching = false;

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
        const lastSettledFundingRate = parseFloat(d.lastFundingRate);

        if (
            !Number.isFinite(price) ||
            !Number.isFinite(indexPrice) || indexPrice <= 0 ||
            !Number.isFinite(interestRate) ||
            !Number.isFinite(lastSettledFundingRate)
        ) {
            console.error('⚠️ 币安 API 返回无效数据, 跳过本轮。', d);
            return;
        }

        // 自算瞬时预测费率
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

        // 计算 1H 均值 (基于 realTimeHistory, 不含本轮新点)
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        let sum1h = 0;
        let count1h = 0;
        state.realTimeHistory.forEach(item => {
            if (item.time >= oneHourAgo) {
                sum1h += item.rate;
                count1h++;
            }
        });
        // 把本轮最新点也计入, 让分析反映当下
        const rate1hAvgInclCurrent = count1h > 0
            ? (sum1h + predictedFundingRate) / (count1h + 1)
            : predictedFundingRate;
        const samplesInclCurrent = count1h + 1;

        // UTC 日线已结算累计
        const todayStart = moment.utc().startOf('day').valueOf();
        let settledRateToday = 0;
        fundingHistory.forEach(item => {
            if (item.fundingTime >= todayStart) {
                settledRateToday += parseFloat(item.fundingRate);
            }
        });
        const rateDailySettledSum = parseFloat(settledRateToday.toFixed(8));
        const rateDailyWithPredict = parseFloat((settledRateToday + predictedFundingRate).toFixed(8));

        // 费率突变告警
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

        // 分析 1H 均值方向
        const analysis = analyze1hRate(rate1hAvgInclCurrent, samplesInclCurrent, predictedFundingRate);
        state.rate1hDirection = analysis.direction;
        state.rate1hSamples = analysis.samples;
        state.isStrongSignal = analysis.isStrong;
        state.isReversalWarning = analysis.isReversalWarning;

        // 方向变化防抖检测 + 告警
        if (analysis.direction !== state.stableDirection) {
            if (state.pendingDirection === analysis.direction) {
                state.pendingDirectionCount += 1;
            } else {
                state.pendingDirection = analysis.direction;
                state.pendingDirectionCount = 1;
            }
            if (state.pendingDirectionCount >= DIRECTION_CHANGE_CONFIRM) {
                const fromDirection = state.stableDirection;
                state.stableDirection = analysis.direction;
                state.pendingDirection = null;
                state.pendingDirectionCount = 0;
                const trigger = fromDirection === 'warming_up' ? 'initial' : 'direction_change';
                heartbeat(trigger, fromDirection);

                // 穿 0 轴检测（资金费率均值从负转正 / 正转负）
                detectRate1hCross(analysis.direction, rate1hAvgInclCurrent);
            }
        } else {
            state.pendingDirection = null;
            state.pendingDirectionCount = 0;
        }

        // 更新 state
        state.lastSettledFundingRate = lastSettledFundingRate;
        state.predictedFundingRate = predictedFundingRate;
        state.currentPrice = price;
        state.indexPrice = indexPrice;
        state.interestRate = interestRate;
        state.rate1hAvg = rate1hAvgInclCurrent;
        state.rateDailySettledSum = rateDailySettledSum;
        state.rateDailyWithPredict = rateDailyWithPredict;

        const nowTs = Date.now();
        state.realTimeHistory.push({ time: nowTs, rate: predictedFundingRate });
        if (state.realTimeHistory.length > 60) state.realTimeHistory.shift();

        if (state.rate1hDirection !== 'warming_up' && Number.isFinite(rate1hAvgInclCurrent)) {
            state.rate1hHistory.push({ time: nowTs, rate: rate1hAvgInclCurrent });
            if (state.rate1hHistory.length > 240) state.rate1hHistory.shift();
        }

        // 终端日志
        const rate1hLabel = formatDirectionLabel(
            state.rate1hDirection, state.isStrongSignal, state.isReversalWarning, state.rate1hSamples
        );
        const rate1hAvgStr = Number.isFinite(state.rate1hAvg) ? (state.rate1hAvg * 100).toFixed(4) + '%' : '--';

        console.log(
            `[${moment().format('HH:mm:ss')}] 价: ${price.toFixed(2)} | 瞬时: ${(predictedFundingRate * 100).toFixed(4)}% | 近1H均值: ${rate1hAvgStr} (${rate1hLabel}) | 上期结算: ${(lastSettledFundingRate * 100).toFixed(4)}%`
        );
    } catch (error) {
        console.error('盯盘轮询失败:', error.message);
    } finally {
        isFetching = false;
    }
}

// ================= API 路由 =================
app.get('/api/status', (req, res) => {
    res.json(state);
});

// 清空历史数据 (仅保留给前端的"重置图表"使用)
app.post('/api/reset', authMiddleware, (req, res) => {
    state.historyData = [];
    state.realTimeHistory = [];
    state.rate1hHistory = [];
    state.lastSettledFundingRate = null;
    state.predictedFundingRate = null;
    state.prevPredictedFundingRate = null;
    state.rate1hDirection = 'warming_up';
    state.rate1hSamples = 0;
    state.isStrongSignal = false;
    state.isReversalWarning = false;
    state.stableDirection = 'warming_up';
    state.pendingDirection = null;
    state.pendingDirectionCount = 0;
    state.currentPrice = 0;
    state.indexPrice = 0;
    state.interestRate = 0;
    state.rate1hAvg = null;
    state.rateDailySettledSum = null;
    state.rateDailyWithPredict = null;

    sendFeishuMsg('🧹 历史数据已清空', '盯盘状态已重置, 将在下次行情到达后重新暖机。');
    res.json({ success: true });
});

// ================= 资金费率穿 0 轴检测（含状态持久化） =================
// 配置项: 状态持久化文件路径
const FUNDING_STATE_FILE = process.env.FUNDING_NOTIFY_STATE_PATH
    || path.join(__dirname, 'data', 'funding_notify_state.json');

function loadFundingNotifyState() {
    try {
        const raw = fs.readFileSync(FUNDING_STATE_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && (obj.lastCrowdedSignal === 'LONG_CROWD' || obj.lastCrowdedSignal === 'SHORT_CROWD')) {
            state.lastCrowdedSignal = obj.lastCrowdedSignal;
            console.log(`[state] 资金费率通知状态已恢复: lastCrowdedSignal=${obj.lastCrowdedSignal}`);
        }
    } catch (e) { /* 文件不存在则忽略 */ }
}
function saveFundingNotifyState() {
    try {
        const dir = path.dirname(FUNDING_STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(FUNDING_STATE_FILE, JSON.stringify({
            lastCrowdedSignal: state.lastCrowdedSignal,
            savedAt: new Date().toISOString(),
        }, null, 2));
    } catch (e) { console.error('[state] saveFundingNotifyState 失败:', e.message); }
}
loadFundingNotifyState();

/**
 * 只在"多头拥挤 ↔ 空头拥挤"之间切换时发穿轴消息（含经 neutral 中转）。
 * 首次确立 crowded 信号不推送（因为没有"从"的方向）。
 * 仅在穿 0 轴的瞬间推送一次，相同方向连续不重复。
 */
function detectRate1hCross(newDirection, rate1hAvg) {
    let changed = false;
    if (newDirection === 'long_crowded') {
        if (state.lastCrowdedSignal === 'SHORT_CROWD') {
            sendCrowdedCrossMsg('up', rate1hAvg);
        }
        if (state.lastCrowdedSignal !== 'LONG_CROWD') {
            state.lastCrowdedSignal = 'LONG_CROWD';
            changed = true;
        }
    } else if (newDirection === 'short_crowded') {
        if (state.lastCrowdedSignal === 'LONG_CROWD') {
            sendCrowdedCrossMsg('down', rate1hAvg);
        }
        if (state.lastCrowdedSignal !== 'SHORT_CROWD') {
            state.lastCrowdedSignal = 'SHORT_CROWD';
            changed = true;
        }
    }
    // neutral / warming_up: 不更新 lastCrowdedSignal, 也不推送
    if (changed) saveFundingNotifyState();
}

function sendCrowdedCrossMsg(direction, rate1hAvg) {
    const isUp = direction === 'up';
    const title = isUp
        ? '🔥 资金费率信号：多头拥挤（向上穿 0 轴）'
        : '💨 资金费率信号：空头拥挤（向下穿 0 轴）';
    const crossDir = isUp ? '从负转正' : '从正转负';
    const interpretation = isUp
        ? '资金费率由负转正，多头开始付费给空头 → 情绪偏多；若后续继续攀升需警惕多头过度拥挤引发的反向猎杀。'
        : '资金费率由正转负，空头开始付费给多头 → 情绪偏空；若后续继续走低需警惕空头过度拥挤引发的反向猎杀。';

    sendFeishuRichMsg(title, [
        [{ text: '⏰ 推送时间：', bold: true }, { text: new Date().toLocaleString() }],
        [{ text: '📊 当前状态：', bold: true }, { text: isUp ? '多头拥挤' : '空头拥挤' }],
        [{ text: '📐 穿轴方向：', bold: true }, { text: crossDir + '（近 1H 瞬时费率均值）' }],
        [{ text: '🎯 当前 1H 均值：', bold: true }, { text: fmtPctMaybe(rate1hAvg) }],
        [{ text: '💵 瞬时预测费率：', bold: true }, { text: fmtPctMaybe(state.predictedFundingRate) }],
        [{ text: '💵 上期已结算：', bold: true }, { text: fmtPctMaybe(state.lastSettledFundingRate) }],
        [{ text: '💡 解读：', bold: true }, { text: interpretation }],
    ]);
}

// ================= 心跳 =================
async function heartbeat(trigger = 'periodic', fromDirection = null) {
    if (state.predictedFundingRate === null) {
        if (trigger !== 'direction_change') {
            sendFeishuMsg('⏳ 心跳: 尚未取到行情', '服务在线但 Binance 行情尚未首次就绪, 请关注。');
        }
        return;
    }

    const curLabel = formatDirectionLabel(
        state.rate1hDirection, state.isStrongSignal, state.isReversalWarning, state.rate1hSamples
    );

    let title;
    let header;
    if (trigger === 'direction_change') {
        const fromLabel = formatDirectionLabel(fromDirection, false, false, state.rate1hSamples);
        title = '🔄 近1H情绪方向变化';
        header = `方向切换: ${fromLabel}  →  ${curLabel}\n\n`;
    } else if (trigger === 'initial') {
        title = '🚀 首次数据心跳';
        header = '';
    } else {
        title = '📊 每小时盯盘心跳';
        header = '';
    }

    sendFeishuMsg(
        title,
        header +
        `当前价格: ${state.currentPrice || '--'}\n` +
        `🎯 近1H情绪: ${curLabel}\n` +
        `近1H瞬时费率均值: ${fmtPctMaybe(state.rate1hAvg)} (采样 ${state.rate1hSamples} 点)\n` +
        `当下瞬时费率: ${fmtPctMaybe(state.predictedFundingRate)}\n` +
        `上期已结算 (参考): ${fmtPctMaybe(state.lastSettledFundingRate)}`
    );
}

// ================= 启动 =================
setInterval(fetchBinanceData, POLL_INTERVAL_MS);
fetchBinanceData();

setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`盯盘服务已启动: http://localhost:${PORT}`);
    console.log(
        `规则: ${POLL_INTERVAL_MS / 1000}s 轮询 | 近1H均值拥挤阈值 ${(RATE1H_MIN_ABS * 100).toFixed(4)}% | 方向变化防抖 ${DIRECTION_CHANGE_CONFIRM} 次 | 心跳 ${HEARTBEAT_INTERVAL_MS / 60000} 分钟`
    );
    sendFeishuRichMsg('✅ BTC/USDT 量化监控系统已启动成功', [
        [{ text: '⏰ 启动时间：', bold: true }, { text: new Date().toLocaleString() }],
        [{ text: '🚪 监听端口：', bold: true }, { text: String(PORT) }],
        [{ text: '📊 监控内容：', bold: true }, { text: '资金费率穿轴 · 宏观 Regime · 交易计划' }],
        [{ text: '🧭 模式：', bold: true }, { text: '纯盯盘（不自动下单）' }],
    ]);
});
