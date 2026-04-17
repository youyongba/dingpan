const chart8h = echarts.init(document.getElementById('chart8h'), 'dark', { background: 'transparent' });
const chart1h = echarts.init(document.getElementById('chart1h'), 'dark', { background: 'transparent' });

window.addEventListener('resize', () => {
    chart8h.resize();
    chart1h.resize();
});

// 通用的图表配置生成函数
function getChartOption(times, rates, seriesName) {
    return {
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(21, 26, 35, 0.9)',
            borderColor: '#2a313f',
            textStyle: { color: '#e2e8f0' },
            formatter: p => {
                const v = p[0].value; 
                const c = v > 0 ? '#10b981' : '#ef4444';
                return `${p[0].axisValue}<br/><span style="color:${c}">●</span> ${seriesName}: <b style="color:${c}">${v}%</b>`;
            }
        },
        grid: { left: '2%', right: '2%', bottom: '5%', top: '10%', containLabel: true },
        xAxis: { type: 'category', data: times, axisLine: { lineStyle: { color: '#2a313f' } } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#1e2430', type: 'dashed' } }, axisLabel: { formatter: '{value}%' } },
        series: [
            // 1. 柱状图 (显示资金费率力度)
            {
                name: seriesName + ' (Bar)',
                data: rates, 
                type: 'bar',
                barWidth: '40%',
                itemStyle: {
                    color: p => p.value > 0 ? 'rgba(16, 185, 129, 0.6)' : 'rgba(239, 68, 68, 0.6)',
                    borderRadius: [2, 2, 0, 0]
                }
            },
            // 2. K线影线效果 (使用自定义的极细柱子叠加，表现最高/最低延伸)
            {
                name: 'Shadow Line',
                data: rates,
                type: 'bar',
                barWidth: '2%',
                barGap: '-50%', // 与前一个柱子重叠
                itemStyle: {
                    color: p => p.value > 0 ? '#10b981' : '#ef4444'
                }
            },
            // 3. 渐变折线图 (平滑趋势)
            {
                name: seriesName + ' (Line)',
                data: rates, 
                type: 'line', 
                smooth: true, 
                symbolSize: 6,
                itemStyle: { color: p => p.value > 0 ? '#10b981' : '#ef4444' },
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
    const res = await fetch('/api/status');
    const data = await res.json();
    
    // 1. 更新状态面板
    let statusHtml = '<span class="success">观望中 (等待信号触发)</span>';
    if (!data.isLocked) {
        statusHtml = '<span class="warning">配置未锁定 (暂停监控)</span>';
    } else if (data.isHoldingPosition) {
        statusHtml = '<span class="alert">已持仓 (屏蔽新开仓信号)</span>';
    } else if (data.hasBrokenResistance) {
        statusHtml = '<span class="warning">已突破阻力位，监控回落中...</span>';
    } else if (data.hasBrokenSupport) {
        statusHtml = '<span class="warning">已跌破支撑位，监控反弹中...</span>';
    }
    document.getElementById('strategyStatus').innerHTML = statusHtml;
    
    document.getElementById('currentPrice').innerText = data.currentPrice;
    document.getElementById('currentRate').innerText = (data.realTimeRate * 100).toFixed(4) + '%';
    document.getElementById('rate1h').innerText = (data.rate1h * 100).toFixed(4) + '%';
    document.getElementById('rateDaily').innerText = (data.rateDaily * 100).toFixed(4) + '%';

    // 2. 更新输入框锁定状态 (支持修改配置模式)
    const locked = !!data.isLocked;

    document.getElementById('resistancePrice').disabled = locked;
    document.getElementById('supportPrice').disabled = locked;
    document.getElementById('webhookUrl').disabled = locked;
    document.getElementById('shortPayload').disabled = locked;
    document.getElementById('longPayload').disabled = locked;

    // 如果是锁定状态，强制用后端数据覆盖输入框；如果未锁定，只在输入框为空时填充，避免打断用户输入
    if (locked) {
        document.getElementById('resistancePrice').value = data.resistancePrice || '';
        document.getElementById('supportPrice').value = data.supportPrice || '';
        document.getElementById('webhookUrl').value = data.webhookUrl || '';
        document.getElementById('shortPayload').value = data.shortPayload ? JSON.stringify(data.shortPayload, null, 2) : '';
        document.getElementById('longPayload').value = data.longPayload ? JSON.stringify(data.longPayload, null, 2) : '';
    } else {
        if (!document.getElementById('resistancePrice').value && data.resistancePrice) document.getElementById('resistancePrice').value = data.resistancePrice;
        if (!document.getElementById('supportPrice').value && data.supportPrice) document.getElementById('supportPrice').value = data.supportPrice;
        if (!document.getElementById('webhookUrl').value && data.webhookUrl) document.getElementById('webhookUrl').value = data.webhookUrl;
        if (!document.getElementById('shortPayload').value && data.shortPayload) document.getElementById('shortPayload').value = JSON.stringify(data.shortPayload, null, 2);
        if (!document.getElementById('longPayload').value && data.longPayload) document.getElementById('longPayload').value = JSON.stringify(data.longPayload, null, 2);
    }
    
    if (locked) {
        document.getElementById('saveBtn').disabled = true;
        document.getElementById('configStatus').innerText = "配置已锁定，策略监控中。";
        document.getElementById('configStatus').className = "success";
    } else {
        document.getElementById('saveBtn').disabled = false;
        document.getElementById('configStatus').innerText = "等待修改配置并锁定...";
        document.getElementById('configStatus').className = "warning";
    }

    // 3. 更新 8小时历史图表数据 (币安官方历史结算)
    if (data.historyData && data.historyData.length > 0) {
        const times8h = data.historyData.map(d => {
            const dt = new Date(d.time);
            return `${dt.getMonth()+1}-${dt.getDate()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
        });
        const rates8h = data.historyData.map(d => (d.rate * 100).toFixed(4));
        chart8h.setOption(getChartOption(times8h, rates8h, '8H资金费率'));
    }

    // 4. 更新 纯1小时实时历史图表数据 (1.5分钟采集一次，保留60次即90分钟)
    if (data.realTimeHistory && data.realTimeHistory.length > 0) {
        const times1h = data.realTimeHistory.map(d => {
            const dt = new Date(d.time);
            return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
        });
        const rates1h = data.realTimeHistory.map(d => (d.rate * 100).toFixed(4));
        chart1h.setOption(getChartOption(times1h, rates1h, '实时资金费率'));
    }
}

async function setConfig() {
    const resistancePrice = document.getElementById('resistancePrice').value;
    const supportPrice = document.getElementById('supportPrice').value;
    const webhookUrl = document.getElementById('webhookUrl').value;
    const shortPayloadStr = document.getElementById('shortPayload').value;
    const longPayloadStr = document.getElementById('longPayload').value;

    if (!resistancePrice || !supportPrice || !webhookUrl || !shortPayloadStr || !longPayloadStr) {
        return alert('请输入完整的触发价格、Webhook 地址和报文内容！');
    }

    let shortPayload, longPayload;
    try {
        shortPayload = JSON.parse(shortPayloadStr);
        longPayload = JSON.parse(longPayloadStr);
    } catch (e) {
        return alert('JSON 报文格式错误，请检查！\n' + e.message);
    }

    let res;
    try {
        res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resistancePrice, supportPrice, webhookUrl, shortPayload, longPayload })
        });
        const result = await res.json();
        
        if (!res.ok) {
            throw new Error(result.error || '配置提交失败');
        }
    } catch (e) {
        return alert('⚠️ 提交失败：' + e.message);
    }
    
    fetchStatus();
}

async function resetConfig() {
    if (!confirm('🚨 确定要修改配置吗？这将暂停监控、解除持仓锁定，并允许你自由编辑各项参数！')) return;
    
    await fetch('/api/reset', { method: 'POST' });
    fetchStatus();
}

// 每5秒拉取一次最新状态
setInterval(fetchStatus, 5000);
fetchStatus();