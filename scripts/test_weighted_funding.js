const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WeightedFundingService } = require('../funding/weightedFunding');

const HOUR = 3600000;

function harness(options = {}) {
    let now = 1700000000000;
    let fail = '';
    let bybitRate = '0.0002';
    const calls = [];
    const getJson = async url => {
        calls.push(url);
        if (fail && url.includes(fail)) throw new Error('network unavailable');
        if (url.includes('premiumIndex')) return { symbol: 'BTCUSDT', markPrice: '100', lastFundingRate: '0.0001', time: now };
        if (url.includes('fapi/v1/openInterest')) return { symbol: 'BTCUSDT', openInterest: '100', time: now };
        if (url.includes('fundingInfo')) return [{ symbol: 'BTCUSDT', fundingIntervalHours: 8 }];
        if (url.includes('market/tickers')) return { retCode: 0, time: now, result: { list: [{
            symbol: 'BTCUSDT', fundingRate: bybitRate, fundingIntervalHour: '4',
            singleOpenInterestValue: '30000', openInterestValue: '60000'
        }] } };
        if (url.includes('public/funding-rate?')) return { code: '0', data: [{
            instId: 'BTC-USDT-SWAP', fundingRate: '-0.0001', fundingTime: now + HOUR,
            nextFundingTime: now + 9 * HOUR, ts: now
        }] };
        if (url.includes('public/open-interest')) return { code: '0', data: [{
            instId: 'BTC-USDT-SWAP', oiUsd: '20000', ts: now
        }] };
        throw new Error(`Unexpected URL: ${url}`);
    };
    const service = new WeightedFundingService({
        storageFile: null, getJson, now: () => now, ...options
    });
    return { service, getJson, calls,
        advance(ms = 90000) { now += ms; },
        fail(value) { fail = value; },
        bybitRate(value) { bybitRate = value; }
    };
}

test('按单边美元持仓加权，并把4小时费率统一到8小时', async () => {
    const h = harness();
    const result = await h.service.poll();
    assert.equal(result.fresh, true);
    assert.equal(result.current.totalOpenInterestUsd, 60000);
    assert.ok(Math.abs(result.current.rate - 11 / 60000) < 1e-15);
    assert.equal(result.current.sources.find(row => row.exchange === 'Bybit').openInterestUsd, 30000);
    assert.equal(result.current.sources.find(row => row.exchange === 'Bybit').rate8h, 0.0004);
    assert.equal(result.current.sources.reduce((sum, row) => sum + row.weight, 0), 1);
});

test('Bybit缺少单边字段时按官方双边金额除二，不误用双倍权重', async () => {
    const h = harness();
    h.service.get = async url => {
        const data = await h.getJson(url);
        if (url.includes('market/tickers')) delete data.result.list[0].singleOpenInterestValue;
        return data;
    };
    const result = await h.service.poll();
    assert.equal(result.current.sources.find(row => row.exchange === 'Bybit').openInterestUsd, 30000);
});

test('同窗口更新OHLC和close，跨窗口新增，不插值缺失时间', async () => {
    const h = harness();
    await h.service.poll();
    const first = h.service.current.rate;
    h.advance();
    h.bybitRate('0.0004');
    await h.service.poll();
    assert.equal(h.service.history8h.length, 1);
    assert.equal(h.service.history8h[0].samples, 2);
    assert.equal(h.service.history8h[0].open, first);
    assert.equal(h.service.history8h[0].low, first);
    assert.equal(h.service.history8h[0].high, h.service.current.rate);
    assert.equal(h.service.history8h[0].close, h.service.current.rate);
    h.advance(24 * HOUR);
    await h.service.poll();
    assert.equal(h.service.history8h.length, 2);
    assert.ok(h.service.history8h[1].time - h.service.history8h[0].time >= 24 * HOUR);
});

test('任一家失效都暂停新增历史，不悄悄更换权重或填零', async () => {
    const h = harness();
    await h.service.poll();
    const last = h.service.current;
    h.advance();
    h.fail('api.bybit.com');
    const result = await h.service.poll();
    assert.equal(result.fresh, false);
    assert.equal(result.status, 'degraded');
    assert.equal(result.current, last);
    assert.equal(result.history8h[0].samples, 1);
    assert.equal(result.errors[0].exchange, 'Bybit');
    h.fail('');
    h.advance();
    assert.equal((await h.service.poll()).fresh, true);
    assert.equal(h.service.history8h[0].samples, 2);
});

test('缺失费率和过期交易所时间不会成为有效样本', async () => {
    for (const invalid of [null, '', 'not-a-rate']) {
        const h = harness();
        h.bybitRate(invalid);
        const result = await h.service.poll();
        assert.equal(result.current, null);
        assert.equal(result.history8h.length, 0);
        assert.equal(result.fresh, false);
    }
    const h = harness();
    h.service.get = async url => {
        const data = await h.getJson(url);
        if (url.includes('market/tickers')) data.time -= 240000;
        return data;
    };
    assert.equal((await h.service.poll()).current, null);
});

test('零费率合法，来源费率相同仍允许真实平台', async () => {
    for (const rate of ['0', '0.0001']) {
        const h = harness();
        h.service.get = async url => {
            const data = await h.getJson(url);
            if (url.includes('premiumIndex')) data.lastFundingRate = rate;
            if (url.includes('market/tickers')) {
                data.result.list[0].fundingRate = rate;
                data.result.list[0].fundingIntervalHour = '8';
            }
            if (url.includes('public/funding-rate?')) data.data[0].fundingRate = rate;
            return data;
        };
        const result = await h.service.poll();
        assert.equal(result.fresh, true);
        assert.ok(Math.abs(result.current.rate - Number(rate)) < 1e-15);
    }
});

test('即使聚合刚更新，源数据超过时效也立即标记为非实时', async () => {
    const h = harness();
    h.service.get = async url => {
        const data = await h.getJson(url);
        if (url.includes('premiumIndex') || url.includes('fapi/v1/openInterest') || url.includes('market/tickers')) {
            data.time -= 179000;
        }
        if (url.includes('public/funding-rate?') || url.includes('public/open-interest')) data.data[0].ts -= 179000;
        return data;
    };
    assert.equal((await h.service.poll()).fresh, true);
    h.advance(2000);
    assert.equal(h.service.getState().fresh, false);
    assert.equal(h.service.getState().status, 'stale');
});

test('存档原子写入且重启保留历史，不伪造新的当前样本', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighted-funding-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storageFile = path.join(dir, 'history.json');
    const h = harness({ storageFile });
    await h.service.poll();
    assert.equal(fs.existsSync(`${storageFile}.tmp`), false);
    const saved = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
    assert.equal(saved.version, 1);
    const restarted = harness({ storageFile });
    assert.equal(restarted.service.history8h[0].close, saved.history8h[0].close);
    assert.equal(restarted.service.current, null);
    restarted.advance();
    await restarted.service.poll();
    assert.equal(restarted.service.history8h[0].samples, 2);
});

test('损坏存档不会被覆盖，仍可提供真实当前数据并提示存储异常', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighted-funding-corrupt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storageFile = path.join(dir, 'history.json');
    fs.writeFileSync(storageFile, '{"broken":true}');
    const h = harness({ storageFile });
    await h.service.poll();
    assert.equal(h.service.getState().fresh, true);
    assert.match(h.service.getState().storageError, /读取失败/);
    assert.equal(fs.readFileSync(storageFile, 'utf8'), '{"broken":true}');
});

test('并发轮询只采样一次，不重复请求或累积柱子', async () => {
    const h = harness();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    h.service.get = async url => { await gate; return h.getJson(url); };
    const first = h.service.poll();
    await h.service.poll();
    release();
    await first;
    assert.equal(h.calls.length, 6);
    assert.equal(h.service.history8h[0].samples, 1);
    h.advance(180001);
    assert.equal(h.service.getState().fresh, false);
    assert.equal(h.service.getState().status, 'stale');
});
