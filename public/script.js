const chart8h = echarts.init(document.getElementById('chart8h'), 'dark', { background: 'transparent' });
const chart1h = echarts.init(document.getElementById('chart1h'), 'dark', { background: 'transparent' });
const chart1hAvg = echarts.init(document.getElementById('chart1hAvg'), 'dark', { background: 'transparent' });
const chartPremium = echarts.init(document.getElementById('chartPremium'), 'dark', { background: 'transparent' });
const chartPremium1hAvg = echarts.init(document.getElementById('chartPremium1hAvg'), 'dark', { background: 'transparent' });
const chartWeightedFunding = echarts.init(document.getElementById('chartWeightedFunding'), 'dark', { background: 'transparent' });
let weightedInterval = '8h';
let weightedFingerprint = '';
let lastWeightedFunding = null;

window.addEventListener('resize', () => {
    chart8h.resize();
    chart1h.resize();
    chart1hAvg.resize();
    chartPremium.resize();
    chartPremium1hAvg.resize();
    chartWeightedFunding.resize();
});

const AUTH_TOKEN_KEY = 'dp_auth_token_v1';

function getSavedToken() {
    try { return localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch (_) { return ''; }
}
function saveToken(t) {
    try { localStorage.setItem(AUTH_TOKEN_KEY, t || ''); } catch (_) { /* ignore */ }
}

function fmtPct(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '--';
    return (v * 100).toFixed(6) + '%';
}

function fmtRateNumber(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '--';
    return v.toLocaleString('en-US', {
        useGrouping: false, minimumFractionDigits: 8, maximumFractionDigits: 12
    });
}

function renderRateValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<span class="rate-primary">${fmtRateNumber(value)}</span><span class="rate-secondary">${fmtPct(value)}</span>`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function toTimeSeries(history) {
    // Keep exchange precision in chart data; formatting must not flatten nearby values.
    return history.map(d => [d.time, Number.isFinite(d.rate) ? d.rate : null]);
}

function updateSettledHistoryHint(history) {
    const el = document.getElementById('settledRateHint');
    if (!el) return;
    const valid = (history || []).filter(d => Number.isFinite(d.rate));
    const last = valid[valid.length - 1];
    let repeated = 0;
    for (let i = valid.length - 1; i >= 0 && valid[i].rate === last.rate; i--) repeated++;
    el.textContent = repeated >= 2
        ? `最近 ${repeated} 次结算原始值均为 ${fmtRateNumber(last.rate)}（${fmtPct(last.rate)}）。这是真实平台，不是图表封顶；切换单位不会产生新波动。`
        : '结算历史保留币安原始数值，不设置 0.0100% 上限；悬停可同时查看高精度数值和百分比。';
}

function weightedNumber(rate) {
    return typeof rate === 'number' && Number.isFinite(rate) ? (rate * 100).toFixed(8) : '--';
}

function setWeightedInterval(interval) {
    if (!['8h', '1h'].includes(interval)) return;
    weightedInterval = interval;
    weightedFingerprint = '';
    renderWeightedFunding(lastWeightedFunding);
}

function getWeightedChartOption(history) {
    const points = history.map(bar => [bar.time, bar.close * 100]);
    const option = getChartOption(points, '持仓加权费率 close', 'mmdd');
    // CoinGlass-style numbers are percentage points, NOT the raw decimal used by other charts.
    option.yAxis.name = '费率数值（百分比口径）';
    option.yAxis.axisLabel.formatter = value => Number(value).toFixed(6);
    option.series = [option.series[0]];
    option.series[0].large = false;
    option.animation = false;
    option.tooltip.formatter = params => {
        const point = params[0]?.value;
        const bar = history.find(item => item.time === point?.[0]);
        if (!bar) return '';
        const start = new Date(bar.time).toISOString().slice(0, 16).replace('T', ' ');
        const last = new Date(bar.lastSampleAt).toISOString().slice(0, 19).replace('T', ' ');
        return `${start} UTC<br/>加权 close: <b>${weightedNumber(bar.close)}</b>` +
            `<br/>百分比: ${fmtPct(bar.close)}<br/>原始小数: ${fmtRateNumber(bar.close)}` +
            `<br/>O / H / L: ${weightedNumber(bar.open)} / ${weightedNumber(bar.high)} / ${weightedNumber(bar.low)}` +
            `<br/>实际采样: ${bar.samples} 次<br/>最后采样: ${last} UTC`;
    };
    return option;
}

function renderWeightedFunding(data) {
    lastWeightedFunding = data;
    const valueEl = document.getElementById('weightedFundingRate');
    const statusEl = document.getElementById('weightedFundingStatus');
    const sourcesEl = document.getElementById('weightedFundingSources');
    const hintEl = document.getElementById('weightedFundingHistoryHint');
    if (!valueEl || !statusEl || !sourcesEl || !hintEl) return;
    const current = data?.current;
    const venueCount = data?.venues?.length || current?.sources?.length || 4;
    const validCurrent = current && Number.isFinite(current.rate);
    valueEl.innerHTML = validCurrent
        ? `<span class="rate-primary">${weightedNumber(current.rate)}</span><span class="rate-secondary">${fmtPct(current.rate)} · 原始小数 ${fmtRateNumber(current.rate)}</span>`
        : '--';
    valueEl.className = 'data-value' + (validCurrent && !data.fresh ? ' warning' : '');
    if (!data) {
        statusEl.textContent = '加权数据尚未就绪，请确认后端已更新。';
    } else if (!data.fresh) {
        const failed = (data.errors || []).map(item => item.exchange).join(' / ');
        const reasons = (data.errors || []).map(item =>
            `${item.exchange === 'aggregate' ? '聚合校验' : item.exchange}：${item.message || '未知错误'}`).join('；');
        statusEl.textContent = (failed ? `${failed} 数据异常，已暂停新增历史点。` : `等待 ${venueCount} 家交易所的同步采样。`) +
            (reasons ? `原因：${reasons}。` : '') +
            (validCurrent ? '当前显示为上次有效值，非实时。' : '');
    } else {
        statusEl.textContent = `固定覆盖 ${venueCount} 家 · 单边持仓合计 ${(current.totalOpenInterestUsd / 1e9).toFixed(3)}B USD · 更新 ${new Date(current.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    }
    if (data?.storageError) statusEl.textContent += ` ${data.storageError}`;
    statusEl.className = 'rate-note weighted-status' + (data?.fresh && !data.storageError ? '' : ' warning');
    sourcesEl.innerHTML = validCurrent ? current.sources.map(source =>
        `<tr><td>${escapeAiHtml(source.exchange)}</td><td>${weightedNumber(source.rate8h)}</td>` +
        `<td>${(source.openInterestUsd / 1e9).toFixed(3)}B</td><td>${(source.weight * 100).toFixed(2)}%</td></tr>`
    ).join('') : `<tr><td colspan="4">等待 ${venueCount} 家交易所真实数据，不使用零值替代缺失数据。</td></tr>`;
    const history = (weightedInterval === '8h' ? data?.history8h : data?.history1h) || [];
    hintEl.textContent = `已积累 ${history.length} 根 ${weightedInterval === '8h' ? '8 小时' : '1 小时'}柱。` +
        '历史从首次成功采样开始，每根为 UTC 时间窗口内最后一次有效加权值（close），缺失窗口留空；非结算费率，不按当前持仓反推过去历史。';
    if (data?.legacyHistory) hintEl.textContent += ' 旧三家历史已单独保留，新增四家历史从升级后完整采样开始，两种口径不混用。';
    const fp = `${weightedInterval}|${JSON.stringify(history)}`;
    if (weightedFingerprint !== fp) {
        weightedFingerprint = fp;
        if (!history.length) chartWeightedFunding.clear();
        else chartWeightedFunding.setOption(getWeightedChartOption(history), true);
    }
}

function getChartOption(timeSeries, seriesName, xAxisFormat /* 'mmdd' | 'hhmm' */) {
    const fmtAxis = xAxisFormat === 'mmdd'
        ? ts => {
            const dt = new Date(ts);
            return `${dt.getMonth() + 1}-${dt.getDate()} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
        }
        : ts => {
            const dt = new Date(ts);
            return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
        };

    return {
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(21, 26, 35, 0.9)',
            borderColor: '#2a313f',
            textStyle: { color: '#e2e8f0' },
            formatter: params => {
                const p = params[0];
                if (!p) return '';
                const ts = Array.isArray(p.value) ? p.value[0] : null;
                const v = Array.isArray(p.value) ? p.value[1] : p.value;
                const c = v > 0 ? '#10b981' : (v < 0 ? '#ef4444' : '#94a3b8');
                const label = ts ? fmtAxis(ts) : p.axisValue;
                return `${label}<br/><span style="color:${c}">●</span> ${seriesName}: <b style="color:${c}">${fmtRateNumber(v)}</b><br/><span style="color:#94a3b8">百分比参考: ${fmtPct(v)}</span>`;
            }
        },
        grid: { left: '2%', right: '2%', bottom: '5%', top: '10%', containLabel: true },
        xAxis: {
            type: 'time',
            axisLine: { lineStyle: { color: '#2a313f' } },
            axisLabel: { formatter: fmtAxis }
        },
        yAxis: { type: 'value', name: '原始数值', splitLine: { lineStyle: { color: '#1e2430', type: 'dashed' } }, axisLabel: { formatter: fmtRateNumber } },
        series: [
            {
                name: seriesName,
                data: timeSeries,
                type: 'bar',
                barMaxWidth: 20,
                large: true,
                itemStyle: {
                    color: p => {
                        const v = Array.isArray(p.value) ? p.value[1] : p.value;
                        return v > 0 ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.6)';
                    },
                    borderRadius: [2, 2, 0, 0]
                }
            },
            {
                name: seriesName + ' · 趋势',
                data: timeSeries,
                type: 'line',
                smooth: true,
                symbolSize: 6,
                itemStyle: {
                    color: p => {
                        const v = Array.isArray(p.value) ? p.value[1] : p.value;
                        return v > 0 ? '#10b981' : '#ef4444';
                    }
                },
                lineStyle: { width: 3, color: '#3b82f6' },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(59, 130, 246, 0.2)' },
                        { offset: 1, color: 'rgba(59, 130, 246, 0)' }
                    ])
                },
                markLine: { data: [{ yAxis: 0 }], lineStyle: { color: '#94a3b8', type: 'dashed' }, symbol: 'none' }
            }
        ]
    };
}

async function fetchStatus() {
    let data;
    try {
        const res = await fetch('/api/status');
        data = await res.json();
    } catch (e) {
        document.getElementById('statusHint').textContent = '⚠️ 状态接口不可达';
        renderWeightedFunding(lastWeightedFunding && {
            ...lastWeightedFunding, fresh: false, errors: [{ exchange: '后端接口', message: '连接失败' }]
        });
        return;
    }

    document.getElementById('currentPrice').textContent = data.currentPrice ? data.currentPrice : '--';
    renderWeightedFunding(data.weightedFunding);
    renderRateValue('currentRate', data.predictedFundingRate);
    renderRateValue('lastSettledRate', data.lastSettledFundingRate);
    renderRateValue('rate1h', data.rate1hAvg);
    renderRateValue('rateDailySettled', data.rateDailySettledSum);
    renderRateValue('currentPremium', data.premium);
    renderRateValue('premium1hAvg', data.premium1hAvg);
    updateSettledHistoryHint(data.historyData);
    
    const rateDailyWithPredictEl = document.getElementById('rateDailyWithPredict');
    if (rateDailyWithPredictEl) {
        renderRateValue('rateDailyWithPredict', data.rateDailyWithPredict);
    }

    // 近 1H 瞬时费率情绪面板
    const rate1hEl = document.getElementById('rate1hDirection');
    const rate1hDetailEl = document.getElementById('rate1hDetail');
    if (rate1hEl && rate1hDetailEl) {
        let label = '中性 (无明显拥挤)';
        let cls = 'warning';
        if (data.rate1hDirection === 'long_crowded') {
            const prefix = data.isStrongSignal ? '🔥 ' : data.isReversalWarning ? '⚠️ ' : '';
            label = prefix + '多头拥挤 → 可做空';
            cls = 'alert';
        } else if (data.rate1hDirection === 'short_crowded') {
            const prefix = data.isStrongSignal ? '🔥 ' : data.isReversalWarning ? '⚠️ ' : '';
            label = prefix + '空头拥挤 → 可做多';
            cls = 'success';
        } else if (data.rate1hDirection === 'warming_up') {
            label = '暖机中 (采样不足)';
            cls = 'warning';
        }
        rate1hEl.textContent = label;
        rate1hEl.className = 'data-value ' + cls;

        const avg = `${fmtRateNumber(data.rate1hAvg)}（${fmtPct(data.rate1hAvg)}）`;
        const now = `${fmtRateNumber(data.predictedFundingRate)}（${fmtPct(data.predictedFundingRate)}）`;
        rate1hDetailEl.textContent =
            `近1H均值: ${avg} (采样 ${data.rate1hSamples || 0} 点) | 当下瞬时: ${now}`;
    }

    // 获取并渲染 MACD 和 RSI
    try {
        const resRegime = await fetch('/api/regime/snapshot?tail=1');
        if (resRegime.ok) {
            const regimeData = await resRegime.json();
            if (regimeData.latest) {
                const l = regimeData.latest;
                const macdStr = l.macd != null ? l.macd.toFixed(3) : '--';
                const signalStr = l.signal != null ? l.signal.toFixed(3) : '--';
                const histStr = l.hist != null ? l.hist.toFixed(3) : '--';
                const rsiStr = l.rsi != null ? l.rsi.toFixed(2) : '--';

                let histColor = '#94a3b8';
                if (l.hist > 0) histColor = '#10b981';
                else if (l.hist < 0) histColor = '#ef4444';

                let rsiColor = '#94a3b8';
                if (l.rsi >= 70) rsiColor = '#ef4444';
                else if (l.rsi <= 30) rsiColor = '#10b981';

                const macdEl = document.getElementById('macdValue');
                if (macdEl) {
                    macdEl.innerHTML = `${macdStr} <br><span style="font-size:12px;color:#94a3b8;">DEA ${signalStr} | <span style="color:${histColor}">HIST ${histStr}</span></span>`;
                }
                const rsiEl = document.getElementById('rsiValue');
                if (rsiEl) {
                    rsiEl.innerHTML = `<span style="color:${rsiColor}">${rsiStr}</span>`;
                }
            }
        }
    } catch (e) {
        console.warn('获取 regime 数据失败:', e);
    }

    renderChartIfChanged('chart8h', data.historyData, '8H资金费率', 'mmdd');
    renderChartIfChanged('chart1h', data.realTimeHistory, '瞬时预测费率', 'hhmm');
    renderChartIfChanged('chart1hAvg', data.rate1hHistory, '近1H均值', 'hhmm');
    renderChartIfChanged('chartPremium', data.premiumHistory, 'premium基差', 'hhmm');
    renderChartIfChanged('chartPremium1hAvg', data.premium1hHistory, 'premium近1H均值', 'hhmm');
}

// 缓存每个图表上一次渲染的数据指纹, 相同则跳过 setOption
const chartFingerprints = { chart8h: '', chart1h: '', chart1hAvg: '', chartPremium: '', chartPremium1hAvg: '' };
const chartInstances = { chart8h, chart1h, chart1hAvg, chartPremium, chartPremium1hAvg };

function renderChartIfChanged(chartKey, history, seriesName, xFormat) {
    const hasData = history && history.length > 0;
    if (!hasData) {
        if (chartFingerprints[chartKey] !== 'empty') {
            chartFingerprints[chartKey] = 'empty';
            chartInstances[chartKey].clear();
        }
        return;
    }
    const fp = JSON.stringify(history);
    if (chartFingerprints[chartKey] === fp) return;
    chartFingerprints[chartKey] = fp;

    const timeSeries = toTimeSeries(history);
    chartInstances[chartKey].setOption(getChartOption(timeSeries, seriesName, xFormat));
}

async function resetHistory() {
    if (!confirm('确定要清空所有历史数据吗? 图表将从零重新开始采样, 暖机需 ~15 分钟。')) return;

    const token = document.getElementById('authToken').value.trim() || getSavedToken();
    if (!token) {
        alert('请先填写 X-Auth-Token');
        return;
    }
    saveToken(token);

    try {
        const res = await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({})
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '清空失败');
        document.getElementById('statusHint').textContent = '✅ 历史数据已清空, 图表将从零开始';
    } catch (e) {
        alert('⚠️ 清空失败: ' + e.message);
    }
    fetchStatus();
}

// 页面加载时回填保存过的 token
document.getElementById('authToken').value = getSavedToken();

setInterval(fetchStatus, 5000);
fetchStatus();

// 一键复制当前计算数据
async function copyCurrentData() {
    const btn = document.getElementById('copyDataBtn');
    if (!btn) return;

    try {
        const getVal = (id) => {
            const el = document.getElementById(id);
            if (!el) return '--';
            return el.innerText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() || '--';
        };

        const lines = [
            `📊 当前计算数据:`,
            `最新实时价格: ${getVal('currentPrice')}`,
            `持仓加权平均资金费率（自算8h口径）: ${getVal('weightedFundingRate')} (${getVal('weightedFundingStatus')})`,
            `🎯 近 1H 瞬时费率情绪: ${getVal('rate1hDirection')} (${getVal('rate1hDetail')})`,
            `瞬时预测费率: ${getVal('currentRate')}`,
            `上期已结算费率: ${getVal('lastSettledRate')}`,
            `1小时预测均值: ${getVal('rate1h')}`,
            `今日已结算累计: ${getVal('rateDailySettled')}`,
            `今日累计含预测(funding_today_cumulative): ${getVal('rateDailyWithPredict')}`,
            `1H 级别 MACD: ${getVal('macdValue')}`,
            `1H 级别 RSI(14): ${getVal('rsiValue')}`
        ];

        const text = lines.join('\n');
        
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            // fallback for non-https environment if needed
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand("copy");
            textArea.remove();
        }

        const oldBg = btn.style.background;
        btn.innerHTML = '✅ <span>已复制</span>';
        btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
        setTimeout(() => {
            btn.innerHTML = '📋 <span>一键复制</span>';
            btn.style.background = oldBg;
        }, 2000);
    } catch (e) {
        alert('复制失败: ' + e.message);
    }
}

// ============ 🧠 喂给 AI 分析 (调用 /api/regime/ai-analysis/build-from-regime) ============
//   与 Regime 面板共用同一条通道: 把当前 Regime + 资金费率快照提交到 aitrade.24os.cn,
//   后端 DeepSeek 自动生成结构化交易计划. 本页轻量展示最近一条结果.
const AI_LAST_SIGNAL_KEY = 'dp_ai_last_signal_id_v1';

function getLastAiSignalId() {
    try { return localStorage.getItem(AI_LAST_SIGNAL_KEY) || ''; } catch (_) { return ''; }
}
function setLastAiSignalId(id) {
    try { localStorage.setItem(AI_LAST_SIGNAL_KEY, id != null ? String(id) : ''); } catch (_) { /* ignore */ }
}

function setAiStatus(text, level) {
    const el = document.getElementById('aiResultStatus');
    if (!el) return;
    el.textContent = text;
    const bg = level === 'ok' ? 'rgba(16,185,129,0.2)'
        : level === 'err' ? 'rgba(239,68,68,0.2)'
        : level === 'warn' ? 'rgba(245,158,11,0.2)'
        : 'rgba(100,116,139,0.2)';
    const color = level === 'ok' ? '#10b981'
        : level === 'err' ? '#ef4444'
        : level === 'warn' ? '#f59e0b'
        : '#94a3b8';
    el.style.background = bg;
    el.style.color = color;
}

function escapeAiHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function extractAiJson(reportText) {
    if (typeof reportText !== 'string') return null;
    const m = reportText.match(/```json\s*([\s\S]*?)```/i);
    const raw = m ? m[1] : reportText;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

function renderAiResult(detail) {
    const box = document.getElementById('aiResultBox');
    const grid = document.getElementById('aiResultGrid');
    const raw = document.getElementById('aiResultRaw');
    const idEl = document.getElementById('aiResultId');
    if (!box || !grid || !raw) return;

    box.style.display = 'block';
    idEl.textContent = detail && detail.id != null ? `#${detail.id} · ${detail.symbol || ''}` : '';

    const reports = Array.isArray(detail?.reports) ? detail.reports : [];
    const firstReport = reports[0] || null;
    const parsed = firstReport ? extractAiJson(firstReport.content) : null;

    const cells = [
        ['建议动作', parsed?.action || (detail?.direction || '--'), action => {
            const a = String(action || '').toLowerCase();
            if (a.includes('long')) return '#10b981';
            if (a.includes('short')) return '#ef4444';
            return '#94a3b8';
        }],
        ['交易对', parsed?.symbol || detail?.symbol || '--'],
        ['建议仓位', parsed?.position_size || (detail?.position_size != null ? (Number(detail.position_size) * 100).toFixed(1) + '%' : '--')],
        ['入场价', parsed?.entry != null ? parsed.entry : (detail?.entry_price != null ? detail.entry_price : '--')],
        ['止损', parsed?.stop_loss != null ? parsed.stop_loss : (detail?.stop_loss != null ? detail.stop_loss : '--'), () => '#ef4444'],
        ['TP1', parsed?.tp1 != null ? parsed.tp1 : '--', () => '#10b981'],
        ['TP2', parsed?.tp2 != null ? parsed.tp2 : '--', () => '#10b981'],
        ['TP3', parsed?.tp3 != null ? parsed.tp3 : '--', () => '#10b981'],
    ];
    grid.innerHTML = cells.map(([label, val, colorFn]) => {
        const color = typeof colorFn === 'function' ? colorFn(val) : '#e2e8f0';
        return `
            <div style="background: rgba(15,23,42,0.5); border: 1px solid rgba(71,85,105,0.3); border-radius: 6px; padding: 8px 10px;">
                <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.3px;">${escapeAiHtml(label)}</div>
                <div style="font-size: 15px; font-weight: 600; margin-top: 2px; font-family: 'SF Mono', Menlo, monospace; color: ${color};">${escapeAiHtml(val)}</div>
            </div>
        `;
    }).join('');

    if (firstReport && firstReport.content) {
        raw.textContent = firstReport.content;
    } else {
        raw.textContent = 'AI 报告生成中, 请稍后点击刷新...';
    }
}

async function sendToAI() {
    const btn = document.getElementById('aiFeedBtn');
    if (!btn) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.innerHTML = '⏳ <span>提交中...</span>';
    setAiStatus('提交中...', '');

    try {
        const r = await fetch('/api/regime/ai-analysis/build-from-regime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) {
            throw new Error(j.error || j.message || ('HTTP ' + r.status));
        }
        const newId = j?.upstream?.id != null ? j.upstream.id : j?.upstream?.signal?.id;
        if (newId != null) setLastAiSignalId(newId);

        btn.innerHTML = '✅ <span>已提交</span>';
        setAiStatus(newId != null ? `已提交 #${newId}` : '已提交', 'ok');

        // 首屏先显示"分析中"占位, 然后延迟 1.2s 再去拉详情 (AI 生成需要时间)
        renderAiResult({ id: newId, symbol: j?.submittedPayload?.symbol, direction: j?.submittedPayload?.direction, reports: [] });
        setTimeout(() => refreshAIResult().catch(() => {}), 1200);
    } catch (e) {
        btn.innerHTML = '❌ <span>提交失败</span>';
        setAiStatus('提交失败', 'err');
        alert('提交失败: ' + e.message);
    } finally {
        setTimeout(() => {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.innerHTML = originalHtml;
        }, 2000);
    }
}

async function refreshAIResult() {
    const id = getLastAiSignalId();
    if (!id) {
        setAiStatus('尚未提交', 'warn');
        return;
    }
    setAiStatus('加载详情...', '');
    try {
        const r = await fetch('/api/regime/ai-analysis/signals/' + encodeURIComponent(id));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || j.message || ('HTTP ' + r.status));
        renderAiResult(j);
        const hasReport = Array.isArray(j.reports) && j.reports.length > 0 && j.reports[0].content;
        setAiStatus(hasReport ? '已加载' : '分析进行中', hasReport ? 'ok' : 'warn');
    } catch (e) {
        setAiStatus('加载失败', 'err');
        console.warn('[AI] refresh failed:', e.message);
    }
}

// 页面加载时: 若 localStorage 有最近一次 AI 信号 id, 自动拉一次详情展示
(function initAiResult() {
    const id = getLastAiSignalId();
    if (!id) return;
    refreshAIResult().catch(() => { /* 静默 */ });
})();
