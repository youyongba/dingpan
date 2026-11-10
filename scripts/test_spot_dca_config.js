const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/SpotDCA.html'), 'utf8');

// The real engine routes run in isolation: no real keys, network, orders, or live archive writes.
function createEngine({ withKeys = false } = {}) {
    let persisted;
    let failWrites = false;
    const routes = new Map();
    const intervals = [];
    let lookup = async () => { throw new Error('No lookup configured'); };
    let httpGet = async () => { throw new Error('Network disabled'); };
    const httpRequests = [];
    const router = { get() {}, post(name, ...handlers) { routes.set(name, handlers.at(-1)); } };
    class Server extends EventEmitter { constructor() { super(); this.clients = []; } }
    const bot = {
        botSignalState: { isExecuting: false }, startBotLoop() {}, setApiKeys() {},
        getTradeRevision: () => 0, setOnStateChangeCallback() {}, getCurrentPrice: () => 0,
        notifyManualTrade() {}, queryOrder: (...args) => lookup(...args)
    };
    const sandbox = {
        module: { exports: {} }, __dirname: root, process: { env: withKeys ? {
            BINANCE_SPOT_API_KEY: 'isolated-test-key', BINANCE_SPOT_API_SECRET: 'isolated-test-secret'
        } : {}, cwd: () => root },
        console: { log() {}, error() {} }, setInterval: fn => intervals.push(fn),
        require: name => {
            if (name === 'fs') return { existsSync: () => false, openSync: () => 1,
                writeFileSync: (_, text) => {
                    if (failWrites) throw new Error('EACCES');
                    persisted = JSON.parse(text);
                },
                fsyncSync() {}, closeSync() {}, renameSync() {} };
            if (name === 'express') return { Router: () => router, json: () => () => {} };
            if (name === 'dotenv') return { config: () => ({ parsed: {} }) };
            if (name === 'axios') return { get: async (url, options) => {
                httpRequests.push({ url, options });
                return httpGet(url, options);
            } };
            if (name === './spotAutoBot') return bot;
            if (name === './lib/spotOrderRecovery') return require('../lib/spotOrderRecovery');
            if (name === 'ws') return { Server };
            if (name.startsWith('./')) return {};
            return require(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'spotDcaEngine.js'), 'utf8'), sandbox);
    /** @type {typeof import('../spotDcaEngine')} */
    const engine = sandbox.module.exports;
    return { ...engine, bot,
        httpRequests, setHttp(fn) { httpGet = fn; },
        pollBalances: () => intervals.find(fn => fn.name === 'fetchBalances')(),
        failWrites(value = true) { failWrites = value; },
        setLookup(fn) { lookup = fn; },
        reconcile: () => intervals.at(-1)(),
        persisted: () => persisted,
        async config(body) {
            const response = { code: 200, body: null,
                status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
            await routes.get('/config')({ body }, response);
            return response;
        }
    };
}

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
}

async function createUI(engine = createEngine()) {
    const elements = new Map();
    for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const attrs = match[2];
        const el = { id: match[3], className: /class="([^"]*)"/.exec(attrs)?.[1] || '',
            value: /value="([^"]*)"/.exec(attrs)?.[1] || '', checked: /\bchecked\b/.test(attrs),
            textContent: '', innerHTML: '', style: {}, addEventListener() {},
            closest() { throw new Error('Do not use an ambiguous ancestor selector'); } };
        el.classList = {
            add(...names) { el.className = [...new Set([...el.className.split(/\s+/), ...names])].join(' '); },
            remove(...names) { el.className = el.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            contains(name) { return el.className.split(/\s+/).includes(name); }
        };
        elements.set(el.id, el);
    }
    const alerts = [];
    const requests = [];
    let customFetch;
    const sandbox = {
        console: { log() {}, error() {} }, document: { getElementById: id => elements.get(id) || null,
            querySelectorAll: () => [] },
        localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
        alert: text => alerts.push(text), confirm: () => false, setInterval() {},
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (customFetch) return customFetch(url, options);
            if (url.endsWith('/status')) return response({ ok: true, config: engine.getConfig(), state: engine.getState() });
            if (url.endsWith('/config')) {
                const result = await engine.config(JSON.parse(options.body));
                return response(result.body, result.code);
            }
            throw new Error(`Unexpected URL: ${url}`);
        },
        module: { exports: {} }
    };
    const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
        .map(match => match[1]).find(text => text.includes('let currentConfig'));
    vm.runInNewContext(source + '\nmodule.exports = {openConfig, closeConfig, setTradeMode, saveConfig, fetchStatus, renderUI, getFuturesPositionViews, applyGeneratedStrategy, getConfig:()=>currentConfig};', sandbox);
    await new Promise(resolve => setImmediate(resolve));
    return { ...sandbox.module.exports, elements, alerts, requests, engine,
        setFetch(fn) { customFetch = fn; } };
}

function registerTests() {
    test('合约草稿只切换表单，保存成功后立即显示做多和做空按钮', async () => {
        const ui = await createUI();
        await ui.openConfig();
        ui.setTradeMode('futures');
        assert.equal(ui.elements.get('cfg-futures-section').classList.contains('hidden'), false);
        assert.equal(ui.elements.get('cfg-dca-amount-section').classList.contains('hidden'), true);
        assert.equal(ui.getConfig().tradeMode, 'spot');
        await ui.saveConfig();
        assert.equal(ui.engine.getConfig().tradeMode, 'futures');
        assert.equal(ui.engine.persisted().config.tradeMode, 'futures');
        assert.equal(ui.elements.get('ui-short-controls').classList.contains('hidden'), false);
        assert.match(ui.elements.get('ui-bot-text-long').textContent, /做多/);
        assert.match(ui.elements.get('ui-bot-text-short').textContent, /做空/);
        assert.match(ui.alerts.at(-1), /已更新并应用/);
    });

    test('有现货持仓时切换合约被明确拒绝，不谎报成功也不关闭配置', async () => {
        const engine = createEngine();
        engine.getState().long.totalCoinAmount = 0.01;
        const ui = await createUI(engine);
        await ui.openConfig();
        ui.setTradeMode('futures');
        await ui.saveConfig();
        assert.equal(engine.getConfig().tradeMode, 'spot');
        assert.equal(ui.getConfig().tradeMode, 'spot');
        assert.equal(ui.elements.get('config-modal').classList.contains('hidden'), false);
        assert.match(ui.alerts.at(-1), /持仓期间不能切换/);
        assert.equal(ui.alerts.some(text => text.includes('已更新并应用')), false);
    });

    test('保存后旧轮询响应不能把合约按钮切回现货', async () => {
        const ui = await createUI();
        await ui.openConfig();
        ui.setTradeMode('futures');
        const oldConfig = JSON.parse(JSON.stringify(ui.engine.getConfig()));
        let release;
        let delayNext = true;
        ui.setFetch(async (url, options) => {
            if (url.endsWith('/status') && delayNext) return new Promise(resolve => {
                delayNext = false;
                release = () => resolve(response({ ok: true, config: oldConfig, state: ui.engine.getState() }));
            });
            if (url.endsWith('/status')) return response({ ok: true, config: ui.engine.getConfig(), state: ui.engine.getState() });
            const result = await ui.engine.config(JSON.parse(options.body));
            return response(result.body, result.code);
        });
        const oldPoll = ui.fetchStatus();
        await ui.saveConfig();
        release();
        await oldPoll;
        ui.setFetch(null);
        assert.equal(ui.getConfig().tradeMode, 'futures');
        assert.equal(ui.elements.get('ui-short-controls').classList.contains('hidden'), false);
    });

    test('400错误、非法TP比例不会被当作已应用策略', async () => {
        const ui = await createUI();
        await ui.openConfig();
        ui.setTradeMode('futures');
        ui.elements.get('cfg-tp1').value = 0;
        await ui.saveConfig();
        assert.match(ui.alerts.at(-1), /各大于 0/);
        assert.equal(ui.engine.getConfig().tradeMode, 'spot');
        ui.elements.get('cfg-tp1').value = 50;
        ui.elements.get('cfg-tp1-target').value = 10;
        await ui.saveConfig();
        assert.match(ui.alerts.at(-1), /策略参数无效/);
        assert.equal(ui.engine.getConfig().tradeMode, 'spot');
    });

    test('存档写入失败返回500并保留原交易模式', async () => {
        const ui = await createUI();
        await ui.openConfig();
        ui.setTradeMode('futures');
        ui.engine.failWrites();
        await ui.saveConfig();
        assert.equal(ui.engine.getConfig().tradeMode, 'spot');
        assert.equal(ui.getConfig().tradeMode, 'spot');
        assert.match(ui.alerts.at(-1), /策略存档失败/);
        assert.equal(ui.elements.get('config-modal').classList.contains('hidden'), false);
    });

    test('取消草稿不切换实盘模式，空仓可以正常从合约切回现货', async () => {
        const ui = await createUI();
        await ui.openConfig();
        ui.setTradeMode('futures');
        ui.closeConfig();
        assert.equal(ui.getConfig().tradeMode, 'spot');
        await ui.openConfig();
        ui.setTradeMode('futures');
        await ui.saveConfig();
        await ui.openConfig();
        ui.setTradeMode('spot');
        await ui.saveConfig();
        assert.equal(ui.engine.getConfig().tradeMode, 'spot');
        assert.equal(ui.elements.get('ui-short-controls').classList.contains('hidden'), true);
        assert.match(ui.elements.get('ui-bot-text-long').textContent, /现货/);
    });

    test('已确认本地合约成交在远端快照到达前仍显示托管和止盈', async () => {
        const engine = createEngine();
        await engine.config({ tradeMode: 'futures' });
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, totalUsdtAmount: 200,
            averagePrice: 100000, tp1Fired: true, tp2Fired: true });
        const ui = await createUI(engine);
        ui.renderUI();
        assert.equal(ui.getFuturesPositionViews().length, 1);
        assert.match(ui.elements.get('ui-positions-container').innerHTML, /本地成交已确认/);
        const tp = ui.elements.get('ui-scaled-tp-wrapper').innerHTML;
        assert.equal((tp.match(/已触发/g) || []).length, 2);
        assert.doesNotMatch(tp, /未托管/);
    });

    test('保存合约直接签名核对，不再依赖旧缓存，尾仓数量同步但保留TP和冷却', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.003, totalUsdtAmount: 300,
            averagePrice: 100000, tp1Fired: true, tp2Fired: true, lockedAtr: 200,
            lastDcaTime: 123456, activeDcaCount: 4, customTp3Price: 98000 });
        engine.getState().isShortBotRunning = true;
        engine.setHttp(async (url, options) => {
            assert.match(url, /\/fapi\/v3\/positionRisk\?symbol=BTCUSDT/);
            assert.match(url, /&signature=[a-f0-9]{64}$/);
            assert.equal(options.timeout, 8000);
            return { data: [{ symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-0.001',
                entryPrice: '100000', unRealizedProfit: '0' }] };
        });
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 200);
        const short = engine.getState().short;
        assert.equal(engine.getConfig().tradeMode, 'futures');
        assert.equal(short.totalCoinAmount, 0.001);
        assert.equal(short.totalUsdtAmount, 100);
        assert.equal(short.tp1Fired && short.tp2Fired, true);
        assert.equal(short.lastDcaTime, 123456);
        assert.equal(short.activeDcaCount, 4);
        assert.equal(short.customTp3Price, 98000);
        assert.equal(short.lockedAtr, 200);
        assert.equal(engine.getState().isShortBotRunning, false);
        assert.equal(engine.persisted().config.tradeMode, 'futures');
    });

    test('币安拒绝核对时返回具体错误，即便有新鲜缓存也不放行', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, averagePrice: 100000 });
        engine.getState().futuresPositions = [{ positionSide: 'SHORT', positionAmt: -0.002, entryPrice: 100000 }];
        engine.getState().futuresPositionsUpdatedAt = Date.now();
        engine.setHttp(async () => { throw { response: { data: { code: -2015, msg: 'Invalid API-key, IP, or permissions' } } }; });
        const result = await engine.config({ tradeMode: 'futures' });
        assert.equal(result.code, 502);
        assert.match(result.body.error, /-2015/);
        assert.equal(engine.getConfig().tradeMode, 'spot');
        assert.equal(engine.getState().short.totalCoinAmount, 0.002);
    });

    test('余额接口失败不再阻止独立的合约持仓查询', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        engine.setHttp(async url => {
            if (url.includes('positionRisk')) return { data: [{ symbol: 'BTCUSDT', positionSide: 'SHORT',
                positionAmt: '-0.002', entryPrice: '100000', unRealizedProfit: '0' }] };
            throw new Error('Account endpoint unavailable');
        });
        await engine.pollBalances();
        assert.equal(engine.getState().futuresPositions.length, 1);
        assert.equal(engine.getState().futuresPositions[0].positionAmt, -0.002);
    });

    test('持仓核对期间禁止重复保存，但不持有全局下单锁', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, averagePrice: 100000 });
        let release;
        engine.setHttp(async () => new Promise(resolve => { release = () => resolve({ data: [] }); }));
        const pending = engine.config({ tradeMode: 'futures' });
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 409);
        assert.equal(engine.bot.botSignalState.isExecuting, false);
        engine.getState().short.pendingOrder = { clientOrderId: 'new-order' };
        release();
        assert.equal((await pending).code, 409);
        assert.equal(engine.getConfig().tradeMode, 'spot');
        assert.equal(engine.getState().short.totalCoinAmount, 0.002);
    });

    test('只有实时核对确认空仓才能清理残留空头记录', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, averagePrice: 100000 });
        engine.setHttp(async () => ({ data: [] }));
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 200);
        assert.equal(engine.getState().short.totalCoinAmount, 0);
        assert.equal(engine.persisted().positions.short.totalCoinAmount, 0);
    });

    test('线上故障场景：残留0.001空头已平，立即接管实时0.044多头并切换合约', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.001, averagePrice: 76633.1 });
        Object.assign(engine.getState().long, { tp1Fired: true, customTp1Price: 99999 });
        engine.setHttp(async () => ({ data: [{ symbol: 'BTCUSDT', positionSide: 'LONG',
            positionAmt: '0.044', entryPrice: '76304.85', unRealizedProfit: '1' }] }));
        const ui = await createUI(engine);
        await ui.openConfig();
        ui.setTradeMode('futures');
        await ui.saveConfig();
        assert.equal(engine.getConfig().tradeMode, 'futures');
        assert.equal(engine.getState().short.totalCoinAmount, 0);
        assert.equal(engine.getState().long.totalCoinAmount, 0.044);
        assert.equal(engine.getState().long.averagePrice, 76304.85);
        assert.equal(engine.getState().long.activeDcaCount, 1);
        assert.equal(engine.getState().long.tp1Fired, false);
        assert.equal(engine.getState().long.customTp1Price, null);
        assert.equal(engine.persisted().positions.long.totalCoinAmount, 0.044);
        const tpPanel = ui.elements.get('ui-scaled-tp-wrapper').innerHTML;
        assert.match(tpPanel, /分批止盈系统 \(多头\)/);
        assert.doesNotMatch(tpPanel, /未托管/);
        assert.equal((tpPanel.match(/editTpPrice\(/g) || []).length, 3);
        assert.match(ui.alerts.at(-1), /历史TP进度无法自动推断/);
        assert.equal(ui.elements.get('config-save-button').disabled, false);
        assert.equal(ui.elements.get('ui-short-controls').classList.contains('hidden'), false);
    });

    test('不完整或非法持仓响应不能当作空仓清理残留记录', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.001, averagePrice: 76633.1 });
        for (const data of [null, {}, [{ symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: null, entryPrice: '0' }]]) {
            engine.setHttp(async () => ({ data }));
            assert.equal((await engine.config({ tradeMode: 'futures' })).code, 502);
            assert.equal(engine.getState().short.totalCoinAmount, 0.001);
            assert.equal(engine.getConfig().tradeMode, 'spot');
        }
    });

    test('模式恢复存档失败时仓位和运行开关也全部回滚', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, averagePrice: 100000 });
        engine.getState().isShortBotRunning = true;
        engine.setHttp(async () => ({ data: [] }));
        engine.failWrites();
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 500);
        assert.equal(engine.getConfig().tradeMode, 'spot');
        assert.equal(engine.getState().short.totalCoinAmount, 0.002);
        assert.equal(engine.getState().isShortBotRunning, true);
    });

    test('模式恢复拒绝币种错误、单向持仓、不同均价和不能对应的现货多头', async () => {
        const engine = createEngine({ withKeys: true });
        await new Promise(resolve => setImmediate(resolve));
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, averagePrice: 100000 });
        for (const [row, code] of [
            [{ symbol: 'ETHUSDT', positionSide: 'SHORT', positionAmt: '-0.002', entryPrice: '100000' }, 502],
            [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-0.002', entryPrice: '100000' }, 409],
            [{ symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-0.002', entryPrice: '90000' }, 409]
        ]) {
            engine.setHttp(async () => ({ data: [row] }));
            assert.equal((await engine.config({ tradeMode: 'futures' })).code, code);
            assert.equal(engine.getConfig().tradeMode, 'spot');
        }
        Object.assign(engine.getState().long, { totalCoinAmount: 0.01, averagePrice: 100000 });
        engine.setHttp(async () => ({ data: [] }));
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 409);
        assert.equal(engine.getState().long.totalCoinAmount, 0.01);
    });

    test('订单查询等待不占全局下单锁，并且不会重复并发查询', async () => {
        const engine = createEngine();
        let release;
        let queries = 0;
        engine.setLookup(async () => { queries++; await new Promise(resolve => { release = resolve; }); throw new Error('timeout'); });
        engine.getState().short.pendingOrder = { clientOrderId: 'test-original', kind: 'entry', market: 'futures' };
        const pending = engine.reconcile();
        assert.equal(engine.bot.botSignalState.isExecuting, false);
        await engine.reconcile();
        assert.equal(queries, 1);
        engine.bot.botSignalState.isExecuting = true;
        release();
        await pending;
        assert.equal(engine.bot.botSignalState.isExecuting, true);
        assert.equal(engine.getState().short.pendingOrder.clientOrderId, 'test-original');
    });

    test('生成器ATR选项映射到服务端支持的动态ATR模式', async () => {
        const ui = await createUI();
        await ui.openConfig();
        ui.elements.get('gen-total-capital').value = 10000;
        ui.elements.get('gen-tp-type').value = 'atr';
        ui.applyGeneratedStrategy();
        assert.equal(ui.elements.get('cfg-tp-mode').value, 'atr_dynamic');
    });
}

if (require.main === module) registerTests();
module.exports = { createEngine, createUI };
