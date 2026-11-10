const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WeightedFundingService, collectHyperliquid } = require('../funding/weightedFunding');

const HOUR = 3600000;

function harness(options = {}) {
    let now = 1700000000000;
    let fail = '';
    let bybitRate = '0.0002';
    const calls = [];
    const getJson = async (url, body) => {
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
        if (url.includes('api.hyperliquid.xyz/info')) {
            assert.deepEqual(body, { type: 'metaAndAssetCtxs', dex: '' });
            return [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [
                { funding: '0.9', openInterest: '999', markPx: '999' },
                { funding: '0.000025', openInterest: '400', markPx: '100' }
            ]];
        }
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
    assert.equal(result.current.totalOpenInterestUsd, 100000);
    assert.ok(Math.abs(result.current.rate - 19 / 100000) < 1e-15);
    assert.equal(result.current.sources.find(row => row.exchange === 'Bybit').openInterestUsd, 30000);
    assert.equal(result.current.sources.find(row => row.exchange === 'Bybit').rate8h, 0.0004);
    assert.equal(result.current.sources.reduce((sum, row) => sum + row.weight, 0), 1);
});

test('Bybit缺少单边字段时按官方双边金额除二，不误用双倍权重', async () => {
    const h = harness();
    h.service.get = async (url, body) => {
        const data = await h.getJson(url, body);
        if (url.includes('market/tickers')) delete data.result.list[0].singleOpenInterestValue;
        return data;
    };
    const result = await h.service.poll();
    assert.equal(result.current.sources.find(row => row.exchange === 'Bybit').openInterestUsd, 30000);
});

test('Hyperliquid按BTC索引取上下文，小时费率乘8且单边持仓不除二', async () => {
    const h = harness();
    const data = await collectHyperliquid(h.getJson, 1700000000000);
    assert.equal(data.fundingIntervalHours, 1);
    assert.equal(data.fundingRate, 0.000025);
    assert.equal(data.rate8h, 0.0002);
    assert.equal(data.openInterestUsd, 40000);
    assert.equal(data.timeSource, 'request-observation');
    assert.equal(data.asOf, 1700000000000);
});

test('Hyperliquid缺失BTC、错位上下文或非法字段均暂停采样，零和负费率合法', async () => {
    for (const invalid of [
        [{ universe: [{ name: 'ETH' }] }, [{}]],
        [{ universe: [{ name: 'BTC' }] }, []],
        [{ universe: [{ name: 'BTC' }, { name: 'BTC' }] }, [{}, {}]],
        [{ universe: [{ name: 'BTC', isDelisted: true }] }, [{}]],
        [{ universe: [{ name: 'BTC' }] }, [{ funding: null, openInterest: '1', markPx: '100' }]],
        [{ universe: [{ name: 'BTC' }] }, [{ funding: '0', openInterest: '0', markPx: '100' }]],
        [{ universe: [{ name: 'BTC' }] }, [{ funding: '0', openInterest: '1', markPx: 'NaN' }]]
    ]) {
        await assert.rejects(collectHyperliquid(async () => invalid, 1700000000000));
    }
    for (const rate of ['0', '-0.0000125']) {
        const data = await collectHyperliquid(async () => [
            { universe: [{ name: 'BTC' }] }, [{ funding: rate, openInterest: '1', markPx: '100' }]
        ], 1700000000000);
        assert.equal(data.rate8h, Number(rate) * 8);
    }
});

test('Hyperliquid失效不会退回三家口径，也不修改当前值或历史', async () => {
    const h = harness();
    await h.service.poll();
    const previous = h.service.current;
    h.advance();
    h.fail('hyperliquid.xyz');
    const result = await h.service.poll();
    assert.equal(result.status, 'degraded');
    assert.equal(result.fresh, false);
    assert.equal(result.errors[0].exchange, 'Hyperliquid');
    assert.equal(result.current, previous);
    assert.equal(result.history8h[0].samples, 1);
    assert.deepEqual(result.venues, ['Binance', 'Bybit', 'OKX', 'Hyperliquid']);
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
    h.service.get = async (url, body) => {
        const data = await h.getJson(url, body);
        if (url.includes('market/tickers')) data.time -= 240000;
        return data;
    };
    assert.equal((await h.service.poll()).current, null);
});

test('零费率合法，来源费率相同仍允许真实平台', async () => {
    for (const rate of ['0', '0.0001']) {
        const h = harness();
        h.service.get = async (url, body) => {
            const data = await h.getJson(url, body);
            if (url.includes('premiumIndex')) data.lastFundingRate = rate;
            if (url.includes('market/tickers')) {
                data.result.list[0].fundingRate = rate;
                data.result.list[0].fundingIntervalHour = '8';
            }
            if (url.includes('public/funding-rate?')) data.data[0].fundingRate = rate;
            if (url.includes('api.hyperliquid.xyz/info')) data[1][1].funding = String(Number(rate) / 8);
            return data;
        };
        const result = await h.service.poll();
        assert.equal(result.fresh, true);
        assert.ok(Math.abs(result.current.rate - Number(rate)) < 1e-15);
    }
});

test('即使聚合刚更新，源数据超过时效也立即标记为非实时', async () => {
    const h = harness();
    h.service.get = async (url, body) => {
        const data = await h.getJson(url, body);
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
    assert.equal(saved.version, 2);
    const restarted = harness({ storageFile });
    assert.equal(restarted.service.history8h[0].close, saved.history8h[0].close);
    assert.equal(restarted.service.current, null);
    restarted.advance();
    await restarted.service.poll();
    assert.equal(restarted.service.history8h[0].samples, 2);
});

test('旧三家历史单独迁移保留，失败不写盘，新四家不混入旧OHLC且重启可恢复', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighted-funding-migrate-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storageFile = path.join(dir, 'history.json');
    const sampleTime = 1700000000000;
    const oldRate = 11 / 60000;
    const bar = hours => ({ time: Math.floor(sampleTime / (hours * HOUR)) * hours * HOUR,
        open: oldRate, high: oldRate, low: oldRate, close: oldRate,
        firstSampleAt: sampleTime, lastSampleAt: sampleTime, samples: 1 });
    const oldFile = JSON.stringify({ version: 1, history8h: [bar(8)], history1h: [bar(1)] });
    fs.writeFileSync(storageFile, oldFile);
    const h = harness({ storageFile });
    assert.equal(h.service.history8h.length, 0);
    assert.equal(h.service.legacyHistory.history8h[0].close, oldRate);
    h.fail('hyperliquid.xyz');
    await h.service.poll();
    assert.equal(fs.readFileSync(storageFile, 'utf8'), oldFile);
    h.fail('');
    await h.service.poll();
    const saved = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.venues, ['Binance', 'Bybit', 'OKX', 'Hyperliquid']);
    assert.equal(saved.legacyHistory.history8h[0].close, oldRate);
    assert.equal(saved.history8h[0].open, 19 / 100000);
    assert.equal(saved.history8h[0].samples, 1);
    const restarted = harness({ storageFile });
    assert.equal(restarted.service.legacyHistory.history8h[0].close, oldRate);
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
    h.service.get = async (url, body) => { await gate; return h.getJson(url, body); };
    const first = h.service.poll();
    await h.service.poll();
    release();
    await first;
    assert.equal(h.calls.length, 7);
    assert.equal(h.service.history8h[0].samples, 1);
    h.advance(180001);
    assert.equal(h.service.getState().fresh, false);
    assert.equal(h.service.getState().status, 'stale');
});
