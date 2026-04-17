const express = require('express');
const axios = require('axios');
const path = require('path');
const moment = require('moment');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ================= 配置与状态 =================
const FEISHU_APP_ID = 'cli_a968a722e4bb1cd3';
const FEISHU_APP_SECRET = 'ouYoFfNmCN7UsJKpHkpubeXMWJVbUFVU';
// 【必填】接收消息的目标类型 (可选: email, user_id, chat_id)
const FEISHU_RECEIVE_ID_TYPE = 'ou_b7b65c6625c7122f6975ee7ea8039708'; 
// 【必填】对应的接收目标 (请填入你在飞书的登录邮箱，或群聊的 chat_id)
const FEISHU_RECEIVE_ID = 'oc_7d4999b7bfb5508c201ebfc9831fbf83'; 

let state = {
    resistancePrice: null, // 阻力价格 (假突破开空用)
    supportPrice: null,    // 支撑价格 (假跌破开多用)
    webhookUrl: null,      // 交易 Webhook 地址
    shortPayload: null,    // 做空参数
    longPayload: null,     // 做多参数
    
    // 假突破/假跌破 状态机
    hasBrokenResistance: false, // 标记是否曾向上突破过阻力价
    hasBrokenSupport: false,    // 标记是否曾向下跌破过支撑价

    isLocked: false,          // 标记配置是否已锁定
    isHoldingPosition: false, // 铁律：是否持仓中
    historyData: [], // 币安官方8小时结算历史数据
    realTimeHistory: [], // 实时资金费率历史数据（每1.5分钟记录一次，保存60条=90分钟）
    lastFundingRate: 0,
    currentPrice: 0,
    realTimeRate: 0,
    rate1h: 0,
    rateDaily: 0
};

// ================= 飞书通知模块 =================
let feishuToken = '';
let feishuTokenExpire = 0;

async function getFeishuToken() {
    if (feishuToken && Date.now() < feishuTokenExpire) return feishuToken;
    try {
        const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
            app_id: FEISHU_APP_ID,
            app_secret: FEISHU_APP_SECRET
        });
        if (res.data.code === 0) {
            feishuToken = res.data.tenant_access_token;
            feishuTokenExpire = Date.now() + (res.data.expire * 1000) - 60000; // 提前一分钟过期
            return feishuToken;
        }
    } catch (e) {
        console.error('获取飞书 Token 失败:', e.message);
    }
    return null;
}

async function sendFeishuMsg(title, text, isAlert = false) {
    if (!FEISHU_RECEIVE_ID || FEISHU_RECEIVE_ID.includes('YOUR_')) {
        console.log(`[飞书通知跳过] 未配置接收人 (FEISHU_RECEIVE_ID): ${title}`);
        return;
    }
    const token = await getFeishuToken();
    if (!token) return;

    try {
        let msgType = isAlert ? "post" : "text";
        let contentStr = isAlert 
            ? JSON.stringify({ zh_cn: { title: title, content: [[{ tag: "text", text: text }]] } })
            : JSON.stringify({ text: `${title}\n${text}` });

        await axios.post(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${FEISHU_RECEIVE_ID_TYPE}`, {
            receive_id: FEISHU_RECEIVE_ID,
            msg_type: msgType,
            content: contentStr
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch (err) {
        console.error('飞书通知发送失败:', err.response?.data?.msg || err.message);
    }
}

// ================= 核心盯盘逻辑 =================
let isFetching = false; // 防止定时任务因网络卡顿而产生并发堆积

async function fetchBinanceData() {
    if (isFetching) return; // 已经在请求中，跳过本次轮询
    isFetching = true;

    try {
        // 如果已经持仓，后续除了必要的记录，不再执行开仓逻辑
        // 我们依然拉取数据是为了更新图表和统计数据，但开仓判断将被拦截

        // 1. 获取实时价格和当前预测资金费率
        const premiumRes = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
        const price = parseFloat(premiumRes.data.markPrice);
        const realTimeRate = parseFloat(premiumRes.data.lastFundingRate);

        // 强健壮性校验：防止 API 异常或维护时返回脏数据导致系统崩溃
        if (isNaN(price) || isNaN(realTimeRate)) {
            console.error('⚠️ 警告: 币安 API 返回无效数据 (NaN)，跳过本次轮询。', premiumRes.data);
            return;
        }

        // 2. 每次请求获取足够的资金费率历史数据（保证能覆盖今天的结算）
        const fundingRes = await axios.get('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=100');
        const fundingHistory = fundingRes.data;

        // 仅保留最近 60 条用于给前端展示 8小时 历史图表
        state.historyData = fundingHistory.slice(-60).map(item => ({
            time: item.fundingTime,
            rate: parseFloat(item.fundingRate)
        }));

        // 3. 计算 1小时累计资金费率 (过去1小时内实时预测费率的均值/总和)
        // 注意：因为币安结算周期是8小时，真实的“过去1小时累计预测值”需要我们自己从实时记录里统计
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        let rate1h = 0;
        let count1h = 0;
        state.realTimeHistory.forEach(item => {
            if (item.time >= oneHourAgo) {
                rate1h += item.rate;
                count1h++;
            }
        });
        // 简单计算平均累计，如果刚启动没有数据，就默认用当前实时费率
        if (count1h > 0) {
            rate1h = rate1h / count1h;
        } else {
            rate1h = realTimeRate;
        }

        // 4. 计算日线累计资金费率 (UTC今日已结算总和 + 当前实时预测费率)
        const todayStart = moment.utc().startOf('day').valueOf();
        let settledRateToday = 0;
        fundingHistory.forEach(item => {
            if (item.fundingTime >= todayStart) {
                settledRateToday += parseFloat(item.fundingRate);
            }
        });
        
        // 修复 JS 浮点数精度问题（比如 0.1 + 0.2 = 0.30000000000000004）
        // 资金费率通常最多 8 位小数，我们统一四舍五入到 8 位避免脏数据
        const rateDaily = parseFloat((settledRateToday + realTimeRate).toFixed(8));

        // 费率突变检查 -> 红色富文本警报
        if (state.lastFundingRate !== 0 && Math.abs(realTimeRate - state.lastFundingRate) > 0.0001) {
            sendFeishuMsg('🚨 资金费率突变警报', `原费率: ${(state.lastFundingRate*100).toFixed(4)}%\n现费率: ${(realTimeRate*100).toFixed(4)}%`, true);
        }
        
        state.lastFundingRate = realTimeRate;
        state.currentPrice = price;
        state.realTimeRate = realTimeRate;
        state.rate1h = rate1h;
        state.rateDaily = rateDaily;

        // 保存实时资金费率记录用于绘制“纯1小时图表” (60个点 x 1.5分钟 = 90分钟)
        // 移除原先混入 8小时结算数据的错误逻辑，确保这仅仅是纯净的 1.5 分钟实时采样
        state.realTimeHistory.push({ time: Date.now(), rate: realTimeRate });
        if (state.realTimeHistory.length > 60) state.realTimeHistory.shift();

        // ================= 终端输出 =================
        let directionStr = "监控中";
        if (!state.isLocked) directionStr = "配置未锁定 (暂停监控)";
        else if (state.isHoldingPosition) directionStr = "持仓中 (屏蔽新信号)";
        else {
            if (state.hasBrokenResistance && price < state.resistancePrice && realTimeRate > 0) directionStr = "满足假突破做空";
            else if (state.hasBrokenResistance && price < state.resistancePrice && realTimeRate <= 0) directionStr = "假突破(费率为负,不空)";
            else if (state.hasBrokenSupport && price > state.supportPrice && realTimeRate < 0) directionStr = "满足假跌破做多";
            else if (state.hasBrokenSupport && price > state.supportPrice && realTimeRate >= 0) directionStr = "假跌破(费率为正,不多)";
            else if (state.hasBrokenResistance) directionStr = "已触及阻力，等待回落...";
            else if (state.hasBrokenSupport) directionStr = "已触及支撑，等待反弹...";
        }

        console.log(`[${moment().format('HH:mm:ss')}] 价格: ${price.toFixed(2)} | 实时费率: ${(realTimeRate*100).toFixed(4)}% | 1H费率: ${(rate1h*100).toFixed(4)}% | 日线费率: ${(rateDaily*100).toFixed(4)}% | 状态: ${directionStr}`);

        // ================= 策略判断 (假突破/假跌破 铁律执行) =================
        if (!state.isLocked) return; // 未锁定配置时不执行开仓判断
        if (state.isHoldingPosition) return; // 铁律：持仓中完全屏蔽新的开仓信号

        // 阶段 1：记录是否发生了突破/跌破
        if (state.resistancePrice && price >= state.resistancePrice && !state.hasBrokenResistance) {
            state.hasBrokenResistance = true;
            state.hasBrokenSupport = false; // 向上突破时，清空向下的跌破状态，防止行情剧烈波动导致双边挂起
            sendFeishuMsg('⚠️ 向上突破阻力位提醒', `当前价格 ${price} 已触及或突破阻力位 ${state.resistancePrice}。\n监控假突破回落中...`);
        }
        
        if (state.supportPrice && price <= state.supportPrice && !state.hasBrokenSupport) {
            state.hasBrokenSupport = true;
            state.hasBrokenResistance = false; // 向下跌破时，清空向上的突破状态，防止双边挂起
            sendFeishuMsg('⚠️ 向下跌破支撑位提醒', `当前价格 ${price} 已触及或跌破支撑位 ${state.supportPrice}。\n监控假跌破反弹中...`);
        }

        // 阶段 2：验证假突破 / 假跌破 并开仓
        if (state.resistancePrice && state.hasBrokenResistance && price < state.resistancePrice) {
            // 假突破：突破后又跌回阻力价下方
            if (realTimeRate > 0) {
                state.hasBrokenResistance = false; // 触发开仓后立刻重置状态，防重复并发
                if (!state.webhookUrl || !state.shortPayload) {
                    console.error('🚫 未配置 Webhook 地址或报文，无法执行开空！');
                    sendFeishuMsg('🚫 开空失败', '满足假突破条件，但未配置 Webhook 或报文。');
                } else {
                    sendFeishuMsg('🎯 假突破确认', `价格回落至阻力位 ${state.resistancePrice} 下方，且费率为正，准备开空！`);
                    await executeOrder('short', price, realTimeRate);
                }
            } else {
                // 铁律：如果资金费率为负（或0），不触发空单
                sendFeishuMsg('🚫 假突破取消 (费率限制)', `价格已回落，但资金费率为 ${(realTimeRate*100).toFixed(4)}% (非正数)。\n铁律：资金费率为负不触发空单！已重置状态。`);
                console.log('🚫 触发假突破但费率为负，取消开空，重置状态。');
                state.hasBrokenResistance = false; // 重置状态，需重新突破才能再次触发
            }
        } else if (state.supportPrice && state.hasBrokenSupport && price > state.supportPrice) {
            // 假跌破：跌破后又反弹回支撑价上方
            if (realTimeRate < 0) {
                state.hasBrokenSupport = false; // 触发开仓后立刻重置状态，防重复并发
                if (!state.webhookUrl || !state.longPayload) {
                    console.error('🚫 未配置 Webhook 地址或报文，无法执行开多！');
                    sendFeishuMsg('🚫 开多失败', '满足假跌破条件，但未配置 Webhook 或报文。');
                } else {
                    sendFeishuMsg('🎯 假跌破确认', `价格反弹至支撑位 ${state.supportPrice} 上方，且费率为负，准备开多！`);
                    await executeOrder('long', price, realTimeRate);
                }
            } else {
                // 铁律：如果资金费率为正（或0），不触发多单
                sendFeishuMsg('🚫 假跌破取消 (费率限制)', `价格已反弹，但资金费率为 ${(realTimeRate*100).toFixed(4)}% (非负数)。\n铁律：资金费率为正不触发多单！已重置状态。`);
                console.log('🚫 触发假跌破但费率为正，取消开多，重置状态。');
                state.hasBrokenSupport = false; // 重置状态，需重新跌破才能再次触发
            }
        }

    } catch (error) {
        console.error('获取币安数据失败:', error.message);
    } finally {
        isFetching = false; // 释放轮询锁
    }
}

// ================= 执行开仓 (Webhook) =================
async function executeOrder(type, price, rate) {
    const action = type === 'short' ? 'open_short' : 'open_long';
    const basePayload = type === 'short' ? state.shortPayload : state.longPayload;

    if (!state.webhookUrl || !basePayload) {
        console.error(`🚫 未配置 Webhook 地址或 ${action} 报文，放弃执行开仓并保持监控！`);
        return;
    }

    state.isHoldingPosition = true; // 只有校验通过，准备发送时才锁定


    // 动态替换 {{timenow}}
    let payloadStr = JSON.stringify(basePayload);
    payloadStr = payloadStr.replace(/{{timenow}}/g, moment().format('YYYY-MM-DD HH:mm:ss'));
    const payload = JSON.parse(payloadStr);

    try {
        console.log(`\n================ 开仓信号触发 ================`);
        console.log(`执行动作: ${action} | 成交价格: ${price} | 费率: ${(rate*100).toFixed(4)}%`);
        const res = await axios.post(state.webhookUrl, payload);
        console.log(`Webhook 响应: ${res.status}`);
        console.log(`==============================================\n`);
        
        sendFeishuMsg('🔥 开仓信号已触发 (假突破/跌破)', `动作: ${action}\n成交价: ${price}\n触发费率: ${(rate*100).toFixed(4)}%\n\n✅ 已进入持仓状态，屏蔽后续新开仓信号。`);
    } catch (err) {
        console.error('🚨 Webhook 发送失败 (致命错误):', err.message);
        sendFeishuMsg('🚨 Webhook 发送失败 (致命错误)', `动作: ${action} 执行时发生网络错误: ${err.message}\n\n⚠️ 警告：为了防止无限重试爆仓，系统已被安全锁定在【持仓状态】。请人工检查交易所实际仓位情况，并在排查网络后重启服务！`, true);
        // 铁律安全：坚决不释放锁 (state.isHoldingPosition 保持 true)
    }
}

// ================= API 路由 =================
app.get('/api/status', (req, res) => {
    res.json(state);
});

app.post('/api/config', (req, res) => {
    const { resistancePrice, supportPrice, webhookUrl, shortPayload, longPayload } = req.body;
    
    // 基础安全校验：防止做多/做空报文填反
    if (shortPayload && shortPayload.action !== 'open_short') {
        return res.status(400).json({ error: '做空报文的 action 必须为 open_short' });
    }
    if (longPayload && longPayload.action !== 'open_long') {
        return res.status(400).json({ error: '做多报文的 action 必须为 open_long' });
    }

    // 保存配置并锁定
    state.resistancePrice = parseFloat(resistancePrice);
    state.supportPrice = parseFloat(supportPrice);
    state.webhookUrl = webhookUrl;
    state.shortPayload = typeof shortPayload === 'string' ? JSON.parse(shortPayload) : shortPayload;
    state.longPayload = typeof longPayload === 'string' ? JSON.parse(longPayload) : longPayload;
    state.isLocked = true;
    
    res.json({ success: true, state });
});

app.post('/api/reset', (req, res) => {
    state.isLocked = false;
    state.isHoldingPosition = false;
    state.hasBrokenResistance = false;
    state.hasBrokenSupport = false;
    // 仅解除锁定并清空状态机，保留所有已填写的参数方便直接修改
    
    sendFeishuMsg('🔓 策略已解锁', '持仓锁定已解除，等待修改配置并重新锁定。');
    res.json({ success: true, state });
});

// 定时任务：每 1.5 分钟（90秒）执行一次盯盘
setInterval(fetchBinanceData, 90 * 1000);
fetchBinanceData();

// 飞书定时推送：每 4 小时推送一次
setInterval(() => {
    sendFeishuMsg('📊 资金费率定时推送', `当前价格: ${state.currentPrice}\n实时费率: ${(state.realTimeRate*100).toFixed(4)}%\n1小时累计: ${(state.rate1h*100).toFixed(4)}%\n日线累计: ${(state.rateDaily*100).toFixed(4)}%`);
}, 4 * 60 * 60 * 1000);

app.listen(3000, () => {
    console.log('量化盯盘服务已启动: http://localhost:3000');
    console.log('配置规则: 假突破/假跌破策略 | 90秒轮询 | 严格防重复开仓');
});