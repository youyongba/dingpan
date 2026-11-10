// Isolated display tests; no exchange requests or trading processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

function harness() {
    const elements = new Map();
    const instances = {};
    const sandbox = {
        module: { exports: {} }, console: { warn() {} },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '' });
            return elements.get(id);
        }},
        window: { addEventListener() {} }, localStorage: { getItem: () => '' },
        echarts: {
            init(el) {
                const chart = { options: [], setOption(option) { this.options.push(option); }, clear() {}, resize() {} };
                const id = [...elements].find(([, value]) => value === el)[0];
                instances[id] = chart;
                return chart;
            },
            graphic: { LinearGradient: function () {} }
        },
        setInterval() {}, setTimeout() {},
        fetch: async () => { throw new Error('Network disabled in display tests'); }
    };
    const source = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
    vm.runInNewContext(source + '\nmodule.exports = { fmtRateNumber, fmtPct, toTimeSeries, getChartOption, renderRateValue, updateSettledHistoryHint, renderChartIfChanged };', sandbox);
    return { ...sandbox.module.exports, elements, instances };
}

test('费率主值采用原始小数，百分比仅作为辅助', () => {
    const h = harness();
    h.renderRateValue('currentRate', 0.0001);
    const html = h.elements.get('currentRate').innerHTML;
    assert.match(html, /rate-primary">0\.00010000/);
    assert.match(html, /rate-secondary">0\.010000%/);
    assert.ok(html.indexOf('0.00010000') < html.indexOf('0.010000%'));
});

test('四位百分比显示相同时，图表仍保留不同的原始值', () => {
    const h = harness();
    const values = [0.0001000001, 0.0001000002, 0.0001000003];
    assert.equal(new Set(values.map(v => (v * 100).toFixed(4))).size, 1);
    const history = values.map((rate, i) => ({ time: i + 1, rate }));
    const series = h.toTimeSeries(history);
    series.forEach((point, i) => assert.equal(point[1], values[i]));
    assert.notEqual(series[0][1], series[1][1]);
    assert.notEqual(h.fmtRateNumber(values[0]), h.fmtRateNumber(values[1]));
});

test('真实相同的结算值仍保持平台，并说明不是图表封顶', () => {
    const h = harness();
    const history = [1, 2, 3].map(time => ({ time, rate: 0.0001 }));
    h.updateSettledHistoryHint(history);
    const hint = h.elements.get('settledRateHint').textContent;
    assert.match(hint, /最近 3 次/);
    assert.match(hint, /真实平台/);
    assert.equal(new Set(h.toTimeSeries(history).map(point => point[1])).size, 1);
});

test('超过 0.0100% 的真实费率不会被截断，图表没有固定上限', () => {
    const h = harness();
    const series = h.toTimeSeries([{ time: 1, rate: 0.0002 }, { time: 2, rate: -0.0003 }]);
    const option = h.getChartOption(series, '结算费率', 'mmdd');
    assert.equal(option.series[0].data[0][1], 0.0002);
    assert.equal(option.series[0].data[1][1], -0.0003);
    assert.equal(option.yAxis.max, undefined);
    assert.equal(option.yAxis.min, undefined);
    assert.equal(option.yAxis.name, '原始数值');
    const tooltip = option.tooltip.formatter([{ value: series[0] }]);
    assert.match(tooltip, /0\.00020000/);
    assert.match(tooltip, /百分比参考: 0\.020000%/);
});

test('非尾部历史值变化也会重新绘图，不遗漏高精度修订', () => {
    const h = harness();
    const history = [1, 2, 3].map(time => ({ time, rate: 0.0001 }));
    h.renderChartIfChanged('chart8h', history, '结算费率', 'mmdd');
    h.renderChartIfChanged('chart8h', history, '结算费率', 'mmdd');
    assert.equal(h.instances.chart8h.options.length, 1);
    history[1].rate = 0.0001000001;
    h.renderChartIfChanged('chart8h', history, '结算费率', 'mmdd');
    assert.equal(h.instances.chart8h.options.length, 2);
    assert.equal(h.instances.chart8h.options[1].series[0].data[1][1], 0.0001000001);
});

test('缺失与无效数据不显示为零，也不误报真实平台', () => {
    const h = harness();
    assert.equal(h.fmtRateNumber(null), '--');
    assert.equal(h.fmtRateNumber(NaN), '--');
    const series = h.toTimeSeries([{ time: 1, rate: null }]);
    assert.equal(series[0][1], null);
    h.updateSettledHistoryHint([]);
    assert.doesNotMatch(h.elements.get('settledRateHint').textContent, /最近/);
    h.updateSettledHistoryHint([{ time: 1, rate: 0.0001 }, { time: 2, rate: 0.0001000001 }]);
    assert.doesNotMatch(h.elements.get('settledRateHint').textContent, /真实平台/);
});
