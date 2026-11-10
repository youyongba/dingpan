// Isolated regression tests: no network, credentials, or live state files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const empty = () => ({
    totalCoinAmount: 0, totalUsdtAmount: 0, averagePrice: 0, activeDcaCount: 0,
    lastDcaTime: 0, totalFees: 0, tp1Fired: false, tp2Fired: false, tp3Fired: false
});
const position = qty => ({ ...empty(), totalCoinAmount: qty, totalUsdtAmount: qty * 100,
    averagePrice: 100, activeDcaCount: 1 });

function harness(overrides = {}) {
    let now = 1700000000000;
    let indicators = { rsi: [50, 50, 99], macd: [-1, -1, 2], signal: [0, 0, 0] };
    let failIndicators = false;
    let response;
    let tickerPrice = 0;
    const intervals = [];
    const orders = [];
    const snapshots = [];
    const sockets = [];
    const config = { tradeMode: 'futures', signalWindow: 12, requireMacd: true, triggerMtf: true,
        triggerDelta: false, rsiThreshold: 30, rsiOverboughtThreshold: 70, dcaMaxSteps: 5,
        martingaleMultiplier: 1, leverage: 1, positionSizePct: 3, tpMode: 'percent',
        tp1: 50, tp2: 30, tp3: 20, tp1Target: 1, tp2Target: 3, tp3Target: 5,
        breakevenSl: true, ...overrides.config };
    const state = { long: empty(), short: empty(), logs: [], futuresBalanceUsdt: 10000,
        isLongBotRunning: false, isShortBotRunning: false, ...overrides.state };
    class Socket extends EventEmitter {
        constructor(url) { super(); this.url = url; sockets.push(this); }
    }
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const axios = { get: async () => ({ data: { price: tickerPrice } }), post: async url => {
        if (url.includes('/leverage?')) return { data: {} };
        const params = new URL(url).searchParams;
        orders.push(params);
        if (response) return { data: await response(params) };
        const qty = Number(params.get('quantity')) || Number(params.get('quoteOrderQty')) / 100;
        return { data: { status: 'FILLED', executedQty: String(qty), cumQuote: String(qty * 100) } };
    }};
    const sandbox = {
        module: { exports: {} }, console: { log() {}, error() {} },
        process: { env: { BINANCE_API_KEY: 'test', BINANCE_API_SECRET: 'test' } },
        Date: Clock, setInterval: fn => intervals.push(fn), setTimeout() {},
        require: name => {
            if (name === 'axios') return axios;
            if (name === 'ws') return Socket;
            if (name === './lib/httpAgents') return {};
            if (name === './regimeModule') return { getState: () => {
                if (failIndicators) throw new Error('indicators unavailable');
                return { indicators };
            }};
            if (name === './mtfModule') return { getTimeframe: () => ({ state: '强多 强空' }) };
            return require(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'spotAutoBot.js'), 'utf8'), sandbox);
    const bot = sandbox.module.exports;
    bot.setOnStateChangeCallback(() => snapshots.push(JSON.parse(JSON.stringify(state))));
    bot.startBotLoop(() => config, () => state);
    return {
        bot, state, config, orders, snapshots, sockets,
        advance(ms) { now += ms; },
        setIndicators(rsi, macd) { indicators = { rsi: [50, rsi, 99], macd: [0, macd, 2], signal: [0, 0, 0] }; },
        failIndicators() { failIndicators = true; },
        respond(fn) { response = fn; },
        setTickerPrice(price) { tickerPrice = price; },
        pollPrice: () => intervals[1](),
        tick: () => intervals[0](),
        async price(price) {
            sockets[0].emit('message', JSON.stringify({ data: { p: String(price), q: '1', m: false } }));
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

test('closed switches: TP1, TP2, rebound stop and flags are saved together', async () => {
    const h = harness({ state: { short: position(0.01) } });
    await h.price(99);
    assert.equal(h.state.short.tp1Fired, true);
    assert.equal(h.state.short.slMoved, true);
    assert.equal(h.state.short.totalCoinAmount, 0.005);
    assert.ok(h.snapshots.some(s => s.short.tp1Fired && s.short.totalCoinAmount === 0.005));
    await h.price(97);
    assert.equal(h.state.short.tp2Fired, true);
    assert.equal(h.state.short.totalCoinAmount, 0.002);
    await h.price(100);
    assert.equal(h.state.short.totalCoinAmount, 0);
    assert.equal(h.orders.length, 3);
    assert.equal(h.orders[2].get('side'), 'BUY');
});

test('price gaps through TP1-TP3: all stages execute in the same tick', async () => {
    for (const direction of ['long', 'short']) {
        const h = harness({ state: { [direction]: position(0.01) } });
        await h.price(direction === 'long' ? 106 : 94);
        assert.equal(h.orders.length, 3);
        assert.equal(h.state[direction].totalCoinAmount, 0);
        assert.equal(h.state[direction].tp3Fired, true);
    }
});

test('indicator failures do not disable risk protection', async () => {
    const h = harness({ state: { long: position(0.01) } });
    h.failIndicators();
    await h.price(101);
    assert.equal(h.state.long.tp1Fired, true);
});

test('minimum-size tail closes once and is not re-opened', async () => {
    const h = harness({ state: { short: position(0.001) } });
    await h.price(99);
    await h.tick();
    assert.equal(h.orders.length, 1);
    assert.equal(h.state.short.totalCoinAmount, 0);
});

test('overlapping realtime ticks and polling cannot submit duplicate TP orders', async () => {
    const h = harness({ state: { long: position(0.01) } });
    let release;
    h.respond(params => new Promise(resolve => {
        release = () => resolve({ status: 'FILLED', executedQty: params.get('quantity'),
            cumQuote: String(Number(params.get('quantity')) * 100) });
    }));
    await h.price(101);
    await h.tick();
    await h.price(102);
    assert.equal(h.orders.length, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.long.tp1Fired, true);
});

test('zero, NaN and expired prices must not trigger orders', async () => {
    const h = harness({ state: { short: position(0.01) } });
    await h.price(0);
    await h.price('invalid');
    await h.tick();
    assert.equal(h.orders.length, 0);
    await h.price(100);
    h.advance(15000);
    h.state.short.customTp1Price = 101;
    await h.tick();
    assert.equal(h.orders.length, 0);
});

test('ACK is not a fill: no fake TP flag and no blind retry', async () => {
    const h = harness({ state: { long: position(0.01) } });
    h.respond(() => ({ status: 'NEW', executedQty: '0', cumQuote: '0' }));
    await h.price(101);
    await h.tick();
    assert.equal(h.state.long.tp1Fired, false);
    assert.equal(h.state.long.totalCoinAmount, 0.01);
    assert.ok(h.state.long.pendingOrder);
    assert.equal(h.orders.length, 1);
});

test('ambiguous timeout preserves order intent across restart', async () => {
    const h = harness({ state: { short: position(0.01) } });
    h.respond(() => { throw new Error('ETIMEDOUT'); });
    await h.price(99);
    const persisted = h.snapshots.at(-1);
    const restarted = harness({ state: { short: persisted.short, signalMemory: persisted.signalMemory } });
    await restarted.price(99);
    assert.equal(restarted.orders.length, 0);
    assert.equal(restarted.state.short.totalCoinAmount, 0.01);
});

test('explicit stop rejection must not clear the real tail', async () => {
    const h = harness({ state: { short: { ...position(0.001), tp1Fired: true, tp2Fired: true } } });
    h.respond(() => { throw Object.assign(new Error('rejected'),
        { response: { status: 400, data: { code: -2010 } } }); });
    await h.price(101);
    assert.equal(h.state.short.totalCoinAmount, 0.001);
    assert.equal(h.state.short.tp1Fired, true);
    assert.equal(h.state.short.pendingOrder, undefined);
});

test('RSI must precede MACD; unclosed last array value cannot open', async () => {
    const h = harness({ state: { isLongBotRunning: true } });
    await h.price(100);
    await h.tick();
    assert.equal(h.orders.length, 0);
    h.advance(3600000);
    h.setIndicators(20, -1);
    await h.price(100);
    await h.tick();
    assert.equal(h.orders.length, 0);
    h.advance(3600000);
    h.setIndicators(40, 1);
    await h.price(100);
    await h.tick();
    assert.equal(h.orders.length, 1);
    await h.tick();
    assert.equal(h.orders.length, 1);
    const restarted = harness({ state: { long: h.state.long, signalMemory: h.state.signalMemory,
        isLongBotRunning: true } });
    await restarted.price(100);
    await restarted.tick();
    assert.equal(restarted.orders.length, 0);
});

test('reverse sequence and same observation do not open', async () => {
    const h = harness({ state: { isShortBotRunning: true } });
    h.setIndicators(50, 1);
    await h.price(100);
    h.advance(3600000);
    h.setIndicators(50, -1);
    await h.tick();
    h.advance(3600000);
    h.setIndicators(80, -1);
    await h.tick();
    assert.equal(h.orders.length, 0);
});

test('max entry count cannot prevent TP protection', async () => {
    const h = harness({ state: { long: { ...position(0.01), activeDcaCount: 5 }, isLongBotRunning: true } });
    await h.price(101);
    assert.equal(h.state.long.tp1Fired, true);
});

test('manual entry updates the persisted cooldown', () => {
    const h = harness();
    h.bot.notifyManualTrade(true, h.state.long);
    assert.ok(h.state.long.lastDcaTime > 0);
});

test('REST price fallback protects a tail when WebSocket is silent', async () => {
    const h = harness({ state: { short: position(0.01) } });
    await new Promise(resolve => setImmediate(resolve));
    h.setTickerPrice(99);
    await h.pollPrice();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.short.tp1Fired, true);
});

test('front-end keeps completed TP flags and stop visible with auto switches off', () => {
    const html = fs.readFileSync(path.join(root, 'public/SpotDCA.html'), 'utf8');
    const start = html.indexOf('const renderSingleTpPanel =');
    const end = html.indexOf("if (currentConfig.tradeMode === 'futures' && currentState.futuresPositions", start);
    const sandbox = { module: { exports: {} }, currentConfig: { tpMode: 'percent',
        tp1: 50, tp2: 30, tp3: 20, tp1Target: 1, tp2Target: 3, tp3Target: 5, breakevenSl: true },
        currentRealIndicators: {} };
    vm.runInNewContext(html.slice(start, end) + '\nmodule.exports = renderSingleTpPanel;', sandbox);
    const state = { ...position(0.002), tp1Fired: true, tp2Fired: true };
    const result = sandbox.module.exports('short', state.averagePrice, state.totalCoinAmount > 0, state);
    assert.equal((result.match(/已触发/g) || []).length, 2);
    assert.equal((result.match(/等待中/g) || []).length, 1);
    assert.ok(result.includes('动态保本止损已激活'));
    assert.ok(result.includes('99.95'));
    assert.ok(html.includes('const isTracked = stateObj?.totalCoinAmount > 0;'));
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        new vm.Script(match[1]);
    }
});

test('engine restores positions after initialization and saves atomically', () => {
    const saved = { config: {}, botState: { isShortBotRunning: true },
        positions: { short: { ...position(0.002), tp1Fired: true, tp2Fired: true, lockedAtr: 410 } } };
    const calls = [];
    let savedText;
    const fakeFs = {
        existsSync: () => true, readFileSync: () => JSON.stringify(saved),
        openSync: p => { calls.push(['open', p]); return 1; },
        writeFileSync: (fd, text) => { savedText = text; calls.push(['write']); },
        fsyncSync: () => calls.push(['fsync']), closeSync: () => calls.push(['close']),
        renameSync: () => calls.push(['rename'])
    };
    const intervals = [];
    let save;
    const routes = new Map();
    const router = { get() {}, post(name, ...handlers) { routes.set(name, handlers.at(-1)); } };
    class Server extends EventEmitter { constructor() { super(); this.clients = []; } }
    const bot = {
        startBotLoop() {}, setApiKeys() {}, getCurrentPrice: () => 100,
        botSignalState: { isExecuting: false }, getTradeRevision: () => 0,
        setOnStateChangeCallback: fn => { save = fn; }
    };
    const sandbox = { module: { exports: {} }, __dirname: root, process: { env: {}, cwd: () => root },
        console: { log() {}, error() {} }, setInterval: fn => intervals.push(fn),
        require: name => {
            if (name === 'fs') return fakeFs;
            if (name === 'express') return { Router: () => router, json: () => () => {} };
            if (name === 'dotenv') return { config: () => ({ parsed: {} }) };
            if (name === 'axios') return { get: async () => ({ data: [] }) };
            if (name === './spotAutoBot') return bot;
            if (name === 'ws') return { Server };
            if (name.startsWith('./')) return {};
            return require(name);
        } };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'spotDcaEngine.js'), 'utf8'), sandbox);
    const s = sandbox.module.exports.getState();
    assert.equal(s.short.tp1Fired, true);
    assert.equal(s.short.tp2Fired, true);
    assert.equal(s.short.totalCoinAmount, 0.002);
    assert.equal(s.isShortBotRunning, true);
    save();
    assert.equal(JSON.parse(savedText).positions.short.tp2Fired, true);
    assert.ok(calls.findIndex(c => c[0] === 'fsync') < calls.findIndex(c => c[0] === 'rename'));
    const res = { json() {}, status(code) { this.code = code; return this; } };
    routes.get('/custom-tp')({ body: { level: 3, price: 90, direction: 'short' } }, res);
    assert.equal(JSON.parse(savedText).positions.short.customTp3Price, 90);
    bot.botSignalState.isExecuting = true;
    routes.get('/override')({ body: { action: 'market-buy', amount: 100 } }, res);
    assert.equal(res.code, 409);
});
