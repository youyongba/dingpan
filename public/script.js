const chart8h = echarts.init(document.getElementById('chart8h'), 'dark', { background: 'transparent' });
const chart1h = echarts.init(document.getElementById('chart1h'), 'dark', { background: 'transparent' });
const chart1hAvg = echarts.init(document.getElementById('chart1hAvg'), 'dark', { background: 'transparent' });

window.addEventListener('resize', () => {
    chart8h.resize();
    chart1h.resize();
    chart1hAvg.resize();
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
    return (v * 100).toFixed(4) + '%';
}

function pad2(n) { return String(n).padStart(2, '0'); }

// 极小值剪辑: 避免 (-1e-13).toFixed(4) === "-0.0000"
function clipEps(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return Math.abs(v) < 1e-10 ? 0 : v;
}

function toTimeSeries(history, rateToPct = true) {
    return history.map(d => {
        const rate = clipEps(d.rate) * (rateToPct ? 100 : 1);
        return [d.time, parseFloat(rate.toFixed(6))];
    });
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
                return `${label}<br/><span style="color:${c}">●</span> ${seriesName}: <b style="color:${c}">${v.toFixed(4)}%</b>`;
            }
        },
        grid: { left: '2%', right: '2%', bottom: '5%', top: '10%', containLabel: true },
        xAxis: {
            type: 'time',
            axisLine: { lineStyle: { color: '#2a313f' } },
            axisLabel: { formatter: fmtAxis }
        },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1e2430', type: 'dashed' } }, axisLabel: { formatter: '{value}%' } },
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
        return;
    }

    document.getElementById('currentPrice').textContent = data.currentPrice ? data.currentPrice : '--';
    document.getElementById('currentRate').textContent = fmtPct(data.predictedFundingRate);
    document.getElementById('lastSettledRate').textContent = fmtPct(data.lastSettledFundingRate);
    document.getElementById('rate1h').textContent = fmtPct(data.rate1hAvg);
    document.getElementById('rateDailySettled').textContent = fmtPct(data.rateDailySettledSum);
    
    const rateDailyWithPredictEl = document.getElementById('rateDailyWithPredict');
    if (rateDailyWithPredictEl) {
        rateDailyWithPredictEl.textContent = fmtPct(data.rateDailyWithPredict);
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

        const avg = typeof data.rate1hAvg === 'number' && isFinite(data.rate1hAvg)
            ? (data.rate1hAvg * 100).toFixed(4) + '%'
            : '--';
        const now = typeof data.predictedFundingRate === 'number' && isFinite(data.predictedFundingRate)
            ? (data.predictedFundingRate * 100).toFixed(4) + '%'
            : '--';
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
}

// 缓存每个图表上一次渲染的数据指纹, 相同则跳过 setOption
const chartFingerprints = { chart8h: '', chart1h: '', chart1hAvg: '' };
const chartInstances = { chart8h, chart1h, chart1hAvg };

function renderChartIfChanged(chartKey, history, seriesName, xFormat) {
    const hasData = history && history.length > 0;
    if (!hasData) {
        if (chartFingerprints[chartKey] !== 'empty') {
            chartFingerprints[chartKey] = 'empty';
            chartInstances[chartKey].clear();
        }
        return;
    }
    const last = history[history.length - 1];
    const first = history[0];
    const fp = `${history.length}|${first.time}|${last.time}|${last.rate}`;
    if (chartFingerprints[chartKey] === fp) return;
    chartFingerprints[chartKey] = fp;

    const timeSeries = toTimeSeries(history, true);
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
