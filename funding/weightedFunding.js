'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { httpAgent, httpsAgent } = require('../lib/httpAgents');

const HOUR = 3600000;
const SAMPLE_INTERVAL = 90000;
const MAX_AGE = 180000;
const LEGACY_VENUES = ['Binance', 'Bybit', 'OKX'];
const VENUES = [...LEGACY_VENUES, 'Hyperliquid'];

function number(value, label, positive = false) {
    if (value == null || value === '' || typeof value === 'boolean') throw new Error(`${label}缺失`);
    const result = Number(value);
    if (!Number.isFinite(result) || (positive && result <= 0)) throw new Error(`${label}无效`);
    return result;
}

function row(exchange, fundingRate, interestUsd, intervalHours, asOf, now) {
    const rate = number(fundingRate, '费率');
    const openInterestUsd = number(interestUsd, '美元持仓金额', true);
    const fundingIntervalHours = number(intervalHours, '结算周期', true);
    const timestamp = number(asOf, '数据时间', true);
    if (timestamp > now + 60000 || now - timestamp > MAX_AGE) throw new Error('交易所数据已过期或时间异常');
    if (fundingIntervalHours > 24) throw new Error('不支持的结算周期');
    return { exchange, fundingRate: rate, fundingIntervalHours, openInterestUsd,
        rate8h: rate * 8 / fundingIntervalHours, asOf: timestamp };
}

async function getJson(url, body) {
    // Honor only the operator's environment; no proxy address is embedded in source or .env.
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    let agent = httpsAgent;
    if (proxy) {
        if (/^socks/i.test(proxy)) {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            agent = new SocksProxyAgent(proxy);
        } else {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            agent = new HttpsProxyAgent(proxy);
        }
    }
    const options = { timeout: 12000, httpAgent, httpsAgent: agent, proxy: false };
    const response = body === undefined
        ? await axios.get(url, options)
        : await axios.post(url, body, options);
    return response.data;
}

async function collectBinance(get, now) {
    const [mark, oi, info] = await Promise.all([
        get('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
        get('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
        get('https://fapi.binance.com/fapi/v1/fundingInfo')
    ]);
    if (mark.symbol !== 'BTCUSDT' || oi.symbol !== 'BTCUSDT' || !Array.isArray(info)) {
        throw new Error('币安响应结构异常');
    }
    const adjusted = info.find(item => item.symbol === 'BTCUSDT');
    const hours = adjusted ? adjusted.fundingIntervalHours : 8;
    const usd = number(oi.openInterest, '币安持仓数量', true) * number(mark.markPrice, '标记价', true);
    return row('Binance', mark.lastFundingRate, usd, hours,
        Math.min(number(mark.time, '费率时间', true), number(oi.time, '持仓时间', true)), now);
}

async function collectBybit(get, now) {
    const response = await get('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
    const ticker = response.result?.list?.find(item => item.symbol === 'BTCUSDT');
    if (response.retCode !== 0 || !ticker) throw new Error('Bybit 响应结构异常');
    let hours = ticker.fundingIntervalHour;
    if (hours == null || hours === '') {
        const info = await get('https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=BTCUSDT');
        const instrument = info.result?.list?.find(item => item.symbol === 'BTCUSDT');
        if (info.retCode !== 0 || !instrument) throw new Error('Bybit 结算周期缺失');
        hours = number(instrument.fundingInterval, '结算周期分钟', true) / 60;
    }
    // Bybit documents openInterestValue as BOTH sides; use the single-side field for comparable weights.
    const usd = ticker.singleOpenInterestValue != null && ticker.singleOpenInterestValue !== ''
        ? ticker.singleOpenInterestValue : number(ticker.openInterestValue, '双边持仓金额', true) / 2;
    return row('Bybit', ticker.fundingRate, usd, hours, response.time, now);
}

async function collectOkx(get, now) {
    const [funding, interest] = await Promise.all([
        get('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP'),
        get('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP')
    ]);
    const rate = funding.data?.find(item => item.instId === 'BTC-USDT-SWAP');
    const oi = interest.data?.find(item => item.instId === 'BTC-USDT-SWAP');
    if (funding.code !== '0' || interest.code !== '0' || !rate || !oi) throw new Error('OKX 响应结构异常');
    const hours = (number(rate.nextFundingTime, '下一结算时间', true) -
        number(rate.fundingTime, '本期结算时间', true)) / HOUR;
    return row('OKX', rate.fundingRate, oi.oiUsd, hours,
        Math.min(number(rate.ts, '费率时间', true), number(oi.ts, '持仓时间', true)), now);
}

function weightedAverage(sources) {
    if (sources.length !== VENUES.length || new Set(sources.map(item => item.exchange)).size !== VENUES.length ||
        !VENUES.every(venue => sources.some(item => item.exchange === venue))) {
        throw new Error('必须取得固定四家交易所数据');
    }
    // Hyperliquid provides no snapshot timestamp; do not compare a request clock to exchange clocks.
    const exchangeTimes = sources.filter(item => item.timeSource !== 'request-observation').map(item => item.asOf);
    // Public endpoints refresh independently; use the same bounded freshness window as row().
    const spread = Math.max(...exchangeTimes) - Math.min(...exchangeTimes);
    if (spread > MAX_AGE) {
        throw new Error(`跨交易所数据时间差过大（${Math.ceil(spread / 1000)}秒，最多${MAX_AGE / 1000}秒）`);
    }
    const totalOpenInterestUsd = sources.reduce((sum, item) => sum + item.openInterestUsd, 0);
    const rate = sources.reduce((sum, item) => sum + item.rate8h * item.openInterestUsd, 0) / totalOpenInterestUsd;
    if (!Number.isFinite(rate) || !Number.isFinite(totalOpenInterestUsd) || totalOpenInterestUsd <= 0) {
        throw new Error('加权结果无效');
    }
    return { rate, totalOpenInterestUsd,
        sources: sources.map(item => ({ ...item, weight: item.openInterestUsd / totalOpenInterestUsd })) };
}

async function collectHyperliquid(get, now) {
    const data = await get('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs', dex: '' });
    const universe = data?.[0]?.universe;
    const contexts = data?.[1];
    if (!Array.isArray(data) || data.length !== 2 || !Array.isArray(universe) ||
        !Array.isArray(contexts) || universe.length !== contexts.length ||
        universe.filter(asset => asset?.name === 'BTC').length !== 1) {
        throw new Error('Hyperliquid 资产上下文结构异常或缺少BTC');
    }
    const index = universe.findIndex(asset => asset.name === 'BTC');
    if (universe[index].isDelisted || !contexts[index]) throw new Error('Hyperliquid BTC市场不可用');
    const context = contexts[index];
    const usd = number(context.openInterest, 'Hyperliquid单边BTC持仓量', true) *
        number(context.markPx, 'Hyperliquid标记价', true);
    return { ...row('Hyperliquid', context.funding, usd, 1, now, now), timeSource: 'request-observation' };
}

function recordBar(history, sample, hours, limit) {
    const time = Math.floor(sample.observedAt / (hours * HOUR)) * hours * HOUR;
    const last = history[history.length - 1];
    if (last && time < last.time) throw new Error('采样时间倒退');
    if (last && time === last.time) {
        if (sample.observedAt <= last.lastSampleAt) return;
        last.high = Math.max(last.high, sample.rate);
        last.low = Math.min(last.low, sample.rate);
        last.close = sample.rate;
        last.lastSampleAt = sample.observedAt;
        last.samples++;
    } else {
        history.push({ time, open: sample.rate, high: sample.rate, low: sample.rate, close: sample.rate,
            firstSampleAt: sample.observedAt, lastSampleAt: sample.observedAt, samples: 1 });
    }
    if (history.length > limit) history.splice(0, history.length - limit);
}

function validBars(history, hours) {
    return Array.isArray(history) && history.every((bar, i) =>
        Number.isFinite(bar.time) && bar.time > 0 && bar.time % (hours * HOUR) === 0 &&
        ['open', 'high', 'low', 'close', 'firstSampleAt', 'lastSampleAt'].every(key => Number.isFinite(bar[key])) &&
        bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close) &&
        bar.high >= bar.low && Number.isInteger(bar.samples) && bar.samples > 0 &&
        bar.firstSampleAt >= bar.time && bar.lastSampleAt >= bar.firstSampleAt &&
        bar.lastSampleAt < bar.time + hours * HOUR && (!i || bar.time > history[i - 1].time));
}

class WeightedFundingService {
    constructor(options = {}) {
        this.get = options.getJson || getJson;
        this.now = options.now || Date.now;
        this.fs = options.fs || fs;
        this.storageFile = options.storageFile === undefined
            ? path.join(__dirname, '..', 'data', 'weighted_funding.json') : options.storageFile;
        this.current = null;
        this.history8h = [];
        this.history1h = [];
        this.legacyHistory = null;
        this.errors = [];
        this.storageError = null;
        this.busy = false;
        this.timer = null;
        this.load();
    }

    load() {
        if (!this.storageFile) return;
        try {
            if (!this.fs.existsSync(this.storageFile)) return;
            const saved = JSON.parse(this.fs.readFileSync(this.storageFile, 'utf8'));
            if (![1, 2].includes(saved.version) || !validBars(saved.history8h, 8) || !validBars(saved.history1h, 1)) {
                throw new Error('加权费率历史存档结构无效');
            }
            if (saved.version === 1) {
                // Retain the old three-venue series without relabeling it as four-venue history.
                this.legacyHistory = { venues: LEGACY_VENUES,
                    history8h: saved.history8h.slice(-180), history1h: saved.history1h.slice(-240) };
                return;
            }
            if (JSON.stringify(saved.venues) !== JSON.stringify(VENUES) ||
                (saved.legacyHistory && (JSON.stringify(saved.legacyHistory.venues) !== JSON.stringify(LEGACY_VENUES) ||
                !validBars(saved.legacyHistory.history8h, 8) || !validBars(saved.legacyHistory.history1h, 1)))) {
                throw new Error('加权费率存档交易所覆盖范围异常');
            }
            this.legacyHistory = saved.legacyHistory || null;
            this.history8h = saved.history8h.slice(-180);
            this.history1h = saved.history1h.slice(-240);
        } catch (e) {
            // Do not overwrite a corrupt archive with empty history.
            this.storageError = `历史存档读取失败，已停止写入: ${e.message}`;
            console.error('[WeightedFunding]', this.storageError);
        }
    }

    save() {
        if (!this.storageFile || this.storageError) return;
        let fd;
        try {
            this.fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
            const temp = `${this.storageFile}.tmp`;
            fd = this.fs.openSync(temp, 'w', 0o600);
            this.fs.writeFileSync(fd, JSON.stringify({ version: 2, venues: VENUES,
                history8h: this.history8h, history1h: this.history1h, legacyHistory: this.legacyHistory }));
            this.fs.fsyncSync(fd);
            this.fs.closeSync(fd);
            fd = undefined;
            this.fs.renameSync(temp, this.storageFile);
        } catch (e) {
            this.storageError = `历史存档保存失败，已停止写入: ${e.message}`;
            console.error('[WeightedFunding]', this.storageError);
        } finally {
            if (fd !== undefined) this.fs.closeSync(fd);
        }
    }

    async poll() {
        if (this.busy) return this.getState();
        this.busy = true;
        try {
            const now = this.now();
            const results = await Promise.allSettled([
                collectBinance(this.get, now), collectBybit(this.get, now), collectOkx(this.get, now),
                collectHyperliquid(this.get, now)
            ]);
            this.errors = results.flatMap((result, i) => result.status === 'rejected'
                ? [{ exchange: VENUES[i], message: result.reason.message }] : []);
            if (this.errors.length) return this.getState();
            const average = weightedAverage(results.map(result => result.value));
            const sample = { ...average, observedAt: this.now() };
            if (sample.sources.some(source => sample.observedAt - source.asOf > MAX_AGE)) {
                throw new Error('请求完成时源数据已过期');
            }
            if (this.current && sample.observedAt <= this.current.observedAt) throw new Error('采样时间倒退或重复');
            // Validate both bucket timelines before mutating either history.
            if ([this.history1h, this.history8h].some(history =>
                history.length && sample.observedAt <= history[history.length - 1].lastSampleAt)) {
                throw new Error('采样时间早于存档时间');
            }
            recordBar(this.history8h, sample, 8, 180);
            recordBar(this.history1h, sample, 1, 240);
            this.current = sample;
            this.save();
        } catch (e) {
            this.errors = [{ exchange: 'aggregate', message: e.message }];
        } finally {
            this.busy = false;
        }
        return this.getState();
    }

    getState() {
        const fresh = !!this.current && this.errors.length === 0 &&
            this.now() - this.current.observedAt < MAX_AGE && this.now() >= this.current.observedAt &&
            this.current.sources.every(source => this.now() - source.asOf < MAX_AGE);
        return {
            source: 'self-calculated', symbol: 'BTCUSDT', unit: 'decimal', normalizedHours: 8,
            venues: VENUES, fresh, status: this.errors.length ? 'degraded' : fresh ? 'ready' : this.current ? 'stale' : 'loading',
            current: this.current, history8h: this.history8h, history1h: this.history1h,
            legacyHistory: this.legacyHistory,
            errors: this.errors, storageError: this.storageError, sampleIntervalMs: SAMPLE_INTERVAL
        };
    }

    start() {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), SAMPLE_INTERVAL);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = { WeightedFundingService, weightedAverage, recordBar, collectBinance, collectBybit, collectOkx, collectHyperliquid };
