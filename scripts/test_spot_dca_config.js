const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/SpotDCA.html'), 'utf8');

// The real engine routes run in isolation: no keys, network, orders, or live archive writes.
function createEngine() {
    let persisted;
    let failWrites = false;
    const routes = new Map();
    const intervals = [];
    let lookup = async () => { throw new Error('No lookup configured'); };
    const router = { get() {}, post(name, ...handlers) { routes.set(name, handlers.at(-1)); } };
    class Server extends EventEmitter { constructor() { super(); this.clients = []; } }
    const bot = {
        botSignalState: { isExecuting: false }, startBotLoop() {}, setApiKeys() {},
        getTradeRevision: () => 0, setOnStateChangeCallback() {}, getCurrentPrice: () => 0,
        notifyManualTrade() {}, queryOrder: (...args) => lookup(...args)
    };
    const sandbox = {
        module: { exports: {} }, __dirname: root, process: { env: {}, cwd: () => root },
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
            if (name === 'axios') return { get: async () => { throw new Error('Network disabled'); } };
            if (name === './spotAutoBot') return bot;
            if (name === './lib/spotOrderRecovery') return require('../lib/spotOrderRecovery');
            if (name === 'ws') return { Server };
            if (name.startsWith('./')) return {};
            return require(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'spotDcaEngine.js'), 'utf8'), sandbox);
    const engine = sandbox.module.exports;
    return { ...engine, bot,
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
    return { ok: status >= 200 && status < 300, status, json: async () => body };
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

    test('原现货配置误存空头时，只在新鲜交易所核对一致后允许恢复合约', async () => {
        const engine = createEngine();
        Object.assign(engine.getState().short, { totalCoinAmount: 0.002, averagePrice: 100000 });
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 409);
        engine.getState().futuresPositions = [{ positionSide: 'SHORT', positionAmt: -0.002, entryPrice: 100000 }];
        engine.getState().futuresPositionsUpdatedAt = Date.now() - 100000;
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 409);
        engine.getState().futuresPositionsUpdatedAt = Date.now();
        assert.equal((await engine.config({ tradeMode: 'futures' })).code, 200);
        assert.equal(engine.getState().short.totalCoinAmount, 0.002);
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
