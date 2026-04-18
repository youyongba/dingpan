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

// 极小值剪辑: 避免 (-1e-13).toFixed(4) === "-0.0000" 这种伪零显示
function clipEps(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return Math.abs(v) < 1e-10 ? 0 : v;
}

// 用 [timestamp, value] 形式返回 ECharts 可识别的 time 类型数据点
function toTimeSeries(history, rateToPct = true) {
    return history.map(d => {
        const rate = clipEps(d.rate) * (rateToPct ? 100 : 1);
        return [d.time, parseFloat(rate.toFixed(6))]; // 数字类型, 非字符串
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
            type: 'time', // 按真实时间戳张缩, 稀疏时间段不会被视觉压缩
            axisLine: { lineStyle: { color: '#2a313f' } },
            axisLabel: { formatter: fmtAxis }
        },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1e2430', type: 'dashed' } }, axisLabel: { formatter: '{value}%' } },
        series: [
            {
                name: seriesName,
                data: timeSeries,
                type: 'bar',
                // time 轴下 ECharts 不再把柱子按 category 等宽分配, 用 barMaxWidth 限制单柱上限
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

function setStatusLabel(container, cls, text) {
    container.textContent = '';
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    container.appendChild(span);
}

async function fetchStatus() {
    const strategyStatus = document.getElementById('strategyStatus');
    let data;
    try {
        const res = await fetch('/api/status');
        data = await res.json();
    } catch (e) {
        setStatusLabel(strategyStatus, 'alert', '状态接口不可达');
        return;
    }

    if (!data.isLocked) {
        setStatusLabel(strategyStatus, 'warning', '配置未锁定 (暂停监控)');
    } else if (data.isHoldingPosition) {
        if (data.orderStatus === 'pending') setStatusLabel(strategyStatus, 'warning', '开仓请求发送中...');
        else if (data.orderStatus === 'failed') setStatusLabel(strategyStatus, 'alert', '开仓异常 (已锁定持仓)');
        else setStatusLabel(strategyStatus, 'alert', '已持仓 (屏蔽新开仓信号)');
    } else if (data.hasBrokenResistance) {
        const hi = data.breakHighPrice ?? '--';
        const cnt = data.reversalConfirmShort || 0;
        setStatusLabel(strategyStatus, 'warning', `已突破阻力 (极端高点 ${hi}), 监控回落确认 ${cnt} 次...`);
    } else if (data.hasBrokenSupport) {
        const lo = data.breakLowPrice ?? '--';
        const cnt = data.reversalConfirmLong || 0;
        setStatusLabel(strategyStatus, 'warning', `已跌破支撑 (极端低点 ${lo}), 监控反弹确认 ${cnt} 次...`);
    } else {
        setStatusLabel(strategyStatus, 'success', '观望中 (等待信号触发)');
    }

    document.getElementById('currentPrice').textContent = data.currentPrice ? data.currentPrice : '--';
    document.getElementById('currentRate').textContent = fmtPct(data.predictedFundingRate);
    const lastSettledEl = document.getElementById('lastSettledRate');
    if (lastSettledEl) lastSettledEl.textContent = fmtPct(data.lastSettledFundingRate);
    document.getElementById('rate1h').textContent = fmtPct(data.rate1hAvg);
    document.getElementById('rateDailySettled').textContent = fmtPct(data.rateDailySettledSum);

    // 近 1H 瞬时费率情绪面板
    const rate1hEl = document.getElementById('rate1hDirection');
    const rate1hDetailEl = document.getElementById('rate1hDetail');
    if (rate1hEl && rate1hDetailEl) {
        let label = '中性 (不开仓)';
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

    const orderInfo = document.getElementById('orderInfo');
    if (data.lastOrderError) {
        orderInfo.textContent = '';
        const span = document.createElement('span');
        span.className = 'alert';
        span.textContent = '最近一次 Webhook 异常: ' + String(data.lastOrderError);
        orderInfo.appendChild(span);
    } else if (data.orderStatus === 'confirmed') {
        orderInfo.textContent = '';
        const span = document.createElement('span');
        span.className = 'success';
        span.textContent = '最近一次 Webhook 已确认成功';
        orderInfo.appendChild(span);
    } else {
        orderInfo.textContent = '';
    }

    const locked = !!data.isLocked;

    document.getElementById('resistancePrice').disabled = locked;
    document.getElementById('supportPrice').disabled = locked;
    document.getElementById('webhookUrl').disabled = locked;
    document.getElementById('shortPayload').disabled = locked;
    document.getElementById('longPayload').disabled = locked;
    document.getElementById('confirmRisk').disabled = locked;

    // 已锁定 → 用后端数据覆盖输入框; webhookUrl / payload 因脱敏/安全只展示占位
    const webhookInput = document.getElementById('webhookUrl');
    const rpInput = document.getElementById('resistancePrice');
    const spInput = document.getElementById('supportPrice');
    if (locked) {
        rpInput.value = data.resistancePrice ?? '';
        spInput.value = data.supportPrice ?? '';
        webhookInput.value = data.webhookUrl ?? '';
        webhookInput.dataset.lockedDisplay = '1';
        document.getElementById('shortPayload').value = data.shortPayloadConfigured ? '[已配置, 出于安全原因不回显]' : '';
        document.getElementById('longPayload').value = data.longPayloadConfigured ? '[已配置, 出于安全原因不回显]' : '';
        // 锁定态下输入框由后端主导, 重置 "用户已编辑" 标记
        delete rpInput.dataset.userEdited;
        delete spInput.dataset.userEdited;
    } else {
        // 解锁后只在"从未填过值且用户也没编辑过"时回填, 避免覆盖用户的清空/修改意图
        if (!rpInput.value && !rpInput.dataset.userEdited && data.resistancePrice) {
            rpInput.value = data.resistancePrice;
        }
        if (!spInput.value && !spInput.dataset.userEdited && data.supportPrice) {
            spInput.value = data.supportPrice;
        }
        // 解锁后: 如果当前 input 里还残留锁定期的脱敏 URL (含 '***'), 清空并提示重填
        if (webhookInput.dataset.lockedDisplay === '1') {
            if (typeof webhookInput.value === 'string' && webhookInput.value.includes('***')) {
                webhookInput.value = '';
                webhookInput.placeholder = '已解锁, 请重新输入完整 Webhook URL';
            }
            delete webhookInput.dataset.lockedDisplay;
        }
        // payload textarea 里如果还是锁定占位符, 也清空让用户重填
        ['shortPayload', 'longPayload'].forEach(id => {
            const el = document.getElementById(id);
            if (el.value && el.value.startsWith('[已配置,')) el.value = '';
        });
    }

    if (locked) {
        document.getElementById('saveBtn').disabled = true;
        document.getElementById('configStatus').innerText = '配置已锁定, 策略监控中。';
        document.getElementById('configStatus').className = 'success';
    } else {
        document.getElementById('saveBtn').disabled = false;
        document.getElementById('configStatus').innerText = '等待修改配置并锁定...';
        document.getElementById('configStatus').className = 'warning';
    }

    renderChartIfChanged('chart8h', data.historyData, '8H资金费率', 'mmdd');
    renderChartIfChanged('chart1h', data.realTimeHistory, '瞬时预测费率', 'hhmm');
    renderChartIfChanged('chart1hAvg', data.rate1hHistory, '近1H均值', 'hhmm');
}

// 缓存每个图表上一次渲染的数据指纹, 相同则跳过 setOption, 避免每 5 秒无意义重绘
const chartFingerprints = { chart8h: '', chart1h: '', chart1hAvg: '' };
const chartInstances = { chart8h, chart1h, chart1hAvg };

function renderChartIfChanged(chartKey, history, seriesName, xFormat) {
    const hasData = history && history.length > 0;
    // 空数据 → 清空图表 (修复 reset+clearHistory 后旧数据残留问题)
    if (!hasData) {
        if (chartFingerprints[chartKey] !== 'empty') {
            chartFingerprints[chartKey] = 'empty';
            chartInstances[chartKey].clear();
        }
        return;
    }
    // 指纹 = 长度 + 首尾时间戳 + 最后一条 rate (高效且能感知 push/shift/值变化)
    const last = history[history.length - 1];
    const first = history[0];
    const fp = `${history.length}|${first.time}|${last.time}|${last.rate}`;
    if (chartFingerprints[chartKey] === fp) return;
    chartFingerprints[chartKey] = fp;

    const timeSeries = toTimeSeries(history, true);
    chartInstances[chartKey].setOption(getChartOption(timeSeries, seriesName, xFormat));
}

async function setConfig() {
    const token = document.getElementById('authToken').value.trim();
    if (!token) return alert('请先填写接口鉴权 Token (X-Auth-Token)');
    saveToken(token);

    const resistancePrice = parseFloat(document.getElementById('resistancePrice').value);
    const supportPrice = parseFloat(document.getElementById('supportPrice').value);
    const webhookUrl = document.getElementById('webhookUrl').value.trim();
    const shortPayloadStr = document.getElementById('shortPayload').value;
    const longPayloadStr = document.getElementById('longPayload').value;
    const confirmRisk = document.getElementById('confirmRisk').checked;

    if (!Number.isFinite(resistancePrice) || !Number.isFinite(supportPrice) || !webhookUrl || !shortPayloadStr || !longPayloadStr) {
        return alert('请输入完整的触发价格、Webhook 地址和报文内容!');
    }
    if (resistancePrice <= supportPrice) {
        return alert('阻力价格必须大于支撑价格!');
    }
    if (webhookUrl.includes('***')) {
        return alert('Webhook 地址还是脱敏值, 请重新输入完整 URL!');
    }
    if (shortPayloadStr.startsWith('[已配置,') || longPayloadStr.startsWith('[已配置,')) {
        return alert('JSON 报文是锁定态占位符, 请重新粘贴完整 JSON!');
    }

    let shortPayload, longPayload;
    try {
        shortPayload = JSON.parse(shortPayloadStr);
        longPayload = JSON.parse(longPayloadStr);
    } catch (e) {
        return alert('JSON 报文格式错误: ' + e.message);
    }

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({ resistancePrice, supportPrice, webhookUrl, shortPayload, longPayload, confirmRisk })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '配置提交失败');
    } catch (e) {
        return alert('⚠️ 提交失败: ' + e.message);
    }

    fetchStatus();
}

async function resetConfig() {
    if (!confirm('🚨 确定要解锁吗? 这会暂停监控并允许修改配置!')) return;

    const token = document.getElementById('authToken').value.trim() || getSavedToken();
    if (!token) return alert('请先填写接口鉴权 Token (X-Auth-Token)');
    saveToken(token);

    const clearHistory = document.getElementById('clearHistory').checked;

    try {
        const res = await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
            body: JSON.stringify({ clearHistory })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '解锁失败');
    } catch (e) {
        return alert('⚠️ 解锁失败: ' + e.message);
    }
    fetchStatus();
}

// 页面加载时回填保存过的 token
document.getElementById('authToken').value = getSavedToken();

// 监听阻力价/支撑价输入框: 用户主动编辑过后, fetchStatus 不再定时回填
['resistancePrice', 'supportPrice'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
        if (!el.disabled) el.dataset.userEdited = '1';
    });
});

setInterval(fetchStatus, 5000);
fetchStatus();
