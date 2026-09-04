import re

def rewrite_html():
    with open('public/SpotDCA.html', 'r') as f:
        content = f.read()

    # In updateUI:
    # 1. Update positions mapping
    old_pos_render = """                    // 如果这个仓位正好是机器人当前追踪的方向，我们记录下来，用于后续渲染止盈
                    if ((isLong && currentState.positionSide === 'long') || (!isLong && currentState.positionSide === 'short')) {
                        renderedPosition = true;
                    }

                    return `
                    <div class="p-4 bg-gray-800 rounded border border-gray-700">
                        <div class="flex justify-between items-center mb-2">
                            <div class="text-sm text-gray-400">当前${modeText}持仓 (${sideText}) - 杠杆 ${pos.leverage}x</div>
                            <div class="text-xs font-bold bg-yellow-500/20 text-yellow-500 px-2 py-1 rounded">DCA 加仓: ${currentState.activeDcaCount || 0} 次</div>
                        </div>"""
                        
    new_pos_render = """                    const stateObj = isLong ? currentState.long : currentState.short;
                    
                    return `
                    <div class="p-4 bg-gray-800 rounded border border-gray-700">
                        <div class="flex justify-between items-center mb-2">
                            <div class="text-sm text-gray-400">当前${modeText}持仓 (${sideText}) - 杠杆 ${pos.leverage}x</div>
                            <div class="text-xs font-bold bg-yellow-500/20 text-yellow-500 px-2 py-1 rounded">DCA 加仓: ${stateObj?.activeDcaCount || 0} 次</div>
                        </div>"""
    content = content.replace(old_pos_render, new_pos_render)

    # Spot mode position
    old_spot_pos = """            } else if (currentConfig.tradeMode === 'spot' && currentState.spotBalanceBtc > 0) {
                const btcBal = currentState.spotBalanceBtc;
                const notionalUsdt = btcBal * currentPrice;
                // For spot, we might not have a reliable entry price from Binance API easily in this scope, we fallback to internal state avgPrice if available, else 0
                const avgPrice = currentState.averagePrice || 0;
                let pnlHtml = '<span class="text-gray-500">0.00%</span>';
                if (avgPrice > 0) {
                    const pnlUsdt = (currentPrice - avgPrice) * btcBal;
                    const pnlPct = ((currentPrice - avgPrice) / avgPrice) * 100;
                    const pnlDisplay = !isDataVisible ? '******' : `${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
                    pnlHtml = `<span class="${pnlUsdt >= 0 ? 'text-green' : 'text-red'} font-bold">${pnlDisplay}</span>`;
                }
                
                let holdingTimeStr = '--';
                if (currentState.entryTime) {
                    const diffMs = Date.now() - currentState.entryTime;
                    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                    if (diffHours >= 24) {
                        holdingTimeStr = `${Math.floor(diffHours/24)}天 ${diffHours%24}时 ${diffMins}分`;
                    } else {
                        holdingTimeStr = `${diffHours}时 ${diffMins}分`;
                    }
                }
                const fees = currentState.totalFees || 0;
                
                posContainer.innerHTML = `
                <div class="p-4 bg-gray-800 rounded border border-gray-700">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-sm text-gray-400">当前${modeText}持仓价值</div>
                        <div class="text-xs font-bold bg-yellow-500/20 text-yellow-500 px-2 py-1 rounded">DCA 加仓: ${currentState.activeDcaCount || 0} 次</div>"""
                        
    new_spot_pos = """            } else if (currentConfig.tradeMode === 'spot' && currentState.spotBalanceBtc > 0) {
                const btcBal = currentState.spotBalanceBtc;
                const notionalUsdt = btcBal * currentPrice;
                const stateObj = currentState.long || {};
                const avgPrice = stateObj.averagePrice || 0;
                let pnlHtml = '<span class="text-gray-500">0.00%</span>';
                if (avgPrice > 0) {
                    const pnlUsdt = (currentPrice - avgPrice) * btcBal;
                    const pnlPct = ((currentPrice - avgPrice) / avgPrice) * 100;
                    const pnlDisplay = !isDataVisible ? '******' : `${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
                    pnlHtml = `<span class="${pnlUsdt >= 0 ? 'text-green' : 'text-red'} font-bold">${pnlDisplay}</span>`;
                }
                
                let holdingTimeStr = '--';
                if (stateObj.entryTime) {
                    const diffMs = Date.now() - stateObj.entryTime;
                    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                    if (diffHours >= 24) {
                        holdingTimeStr = `${Math.floor(diffHours/24)}天 ${diffHours%24}时 ${diffMins}分`;
                    } else {
                        holdingTimeStr = `${diffHours}时 ${diffMins}分`;
                    }
                }
                const fees = stateObj.totalFees || 0;
                
                posContainer.innerHTML = `
                <div class="p-4 bg-gray-800 rounded border border-gray-700">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-sm text-gray-400">当前${modeText}持仓价值</div>
                        <div class="text-xs font-bold bg-yellow-500/20 text-yellow-500 px-2 py-1 rounded">DCA 加仓: ${stateObj.activeDcaCount || 0} 次</div>"""
    content = content.replace(old_spot_pos, new_spot_pos)

    # 2. Update renderSingleTpPanel
    old_tp_func = """            const renderSingleTpPanel = (posSide, entryPrice, isTracked) => {
                const tpMode = currentConfig.tpMode || 'percent';
                const currentAtr = currentRealIndicators?.currentAtr || 0;
                const activeAtr = (tpMode === 'atr_static' && isTracked && currentState.lockedAtr > 0) ? currentState.lockedAtr : currentAtr;
                
                const tp1Target = currentConfig.tp1Target || 1.0;
                const tp2Target = currentConfig.tp2Target || 3.0;
                const tp3Target = currentConfig.tp3Target || 5.0;
                
                let tp1PriceAuto, tp2PriceAuto, tp3PriceAuto;
                let tp1LabelTxt, tp2LabelTxt, tp3LabelTxt;
                
                const isLong = (posSide === 'long' || posSide === 'LONG');
                const sign = isLong ? 1 : -1;
                
                if (tpMode.startsWith('atr') && activeAtr > 0) {
                    tp1PriceAuto = entryPrice + sign * (activeAtr * tp1Target);
                    tp2PriceAuto = entryPrice + sign * (activeAtr * tp2Target);
                    tp3PriceAuto = entryPrice + sign * (activeAtr * tp3Target);
                    
                    const modeTxt = tpMode === 'atr_static' ? `静态ATR:${activeAtr.toFixed(1)}` : `动态ATR:${activeAtr.toFixed(1)}`;
                    tp1LabelTxt = `目标 +${tp1Target}x (${modeTxt})`;
                    tp2LabelTxt = `目标 +${tp2Target}x (${modeTxt})`;
                    tp3LabelTxt = `目标 +${tp3Target}x (${modeTxt})`;
                } else {
                    if (sign === -1) {
                        tp1PriceAuto = entryPrice * (1 - (tp1Target / 100));
                        tp2PriceAuto = entryPrice * (1 - (tp2Target / 100));
                        tp3PriceAuto = entryPrice * (1 - (tp3Target / 100));
                    } else {
                        tp1PriceAuto = entryPrice * (1 + (tp1Target / 100));
                        tp2PriceAuto = entryPrice * (1 + (tp2Target / 100));
                        tp3PriceAuto = entryPrice * (1 + (tp3Target / 100));
                    }
                    
                    tp1LabelTxt = `目标 +${tp1Target}%`;
                    tp2LabelTxt = `目标 +${tp2Target}%`;
                    tp3LabelTxt = `目标 +${tp3Target}%`;
                }
                
                const tp1Price = (isTracked && currentState.customTp1Price) ? currentState.customTp1Price : tp1PriceAuto;
                const tp2Price = (isTracked && currentState.customTp2Price) ? currentState.customTp2Price : tp2PriceAuto;
                const tp3Price = (isTracked && currentState.customTp3Price) ? currentState.customTp3Price : tp3PriceAuto;
                
                const label1 = (isTracked && currentState.customTp1Price) ? `TP1 (${currentConfig.tp1 || 50}%) | 手动自定义` : `TP1 (${currentConfig.tp1 || 50}%) | ${tp1LabelTxt}`;
                const label2 = (isTracked && currentState.customTp2Price) ? `TP2 (${currentConfig.tp2 || 30}%) | 手动自定义` : `TP2 (${currentConfig.tp2 || 30}%) | ${tp2LabelTxt}`;
                const label3 = (isTracked && currentState.customTp3Price) ? `TP3 (${currentConfig.tp3 || 20}%) | 手动自定义` : `TP3 (${currentConfig.tp3 || 20}%) | ${tp3LabelTxt}`;
                
                const getTpRowHtml = (level, label, price, fired) => {"""
                
    new_tp_func = """            const renderSingleTpPanel = (posSide, entryPrice, isTracked, stateObj) => {
                const tpMode = currentConfig.tpMode || 'percent';
                const currentAtr = currentRealIndicators?.currentAtr || 0;
                const activeAtr = (tpMode === 'atr_static' && isTracked && stateObj?.lockedAtr > 0) ? stateObj.lockedAtr : currentAtr;
                
                const tp1Target = currentConfig.tp1Target || 1.0;
                const tp2Target = currentConfig.tp2Target || 3.0;
                const tp3Target = currentConfig.tp3Target || 5.0;
                
                let tp1PriceAuto, tp2PriceAuto, tp3PriceAuto;
                let tp1LabelTxt, tp2LabelTxt, tp3LabelTxt;
                
                const isLong = (posSide === 'long' || posSide === 'LONG');
                const sign = isLong ? 1 : -1;
                
                if (tpMode.startsWith('atr') && activeAtr > 0) {
                    tp1PriceAuto = entryPrice + sign * (activeAtr * tp1Target);
                    tp2PriceAuto = entryPrice + sign * (activeAtr * tp2Target);
                    tp3PriceAuto = entryPrice + sign * (activeAtr * tp3Target);
                    
                    const modeTxt = tpMode === 'atr_static' ? `静态ATR:${activeAtr.toFixed(1)}` : `动态ATR:${activeAtr.toFixed(1)}`;
                    tp1LabelTxt = `目标 +${tp1Target}x (${modeTxt})`;
                    tp2LabelTxt = `目标 +${tp2Target}x (${modeTxt})`;
                    tp3LabelTxt = `目标 +${tp3Target}x (${modeTxt})`;
                } else {
                    if (sign === -1) {
                        tp1PriceAuto = entryPrice * (1 - (tp1Target / 100));
                        tp2PriceAuto = entryPrice * (1 - (tp2Target / 100));
                        tp3PriceAuto = entryPrice * (1 - (tp3Target / 100));
                    } else {
                        tp1PriceAuto = entryPrice * (1 + (tp1Target / 100));
                        tp2PriceAuto = entryPrice * (1 + (tp2Target / 100));
                        tp3PriceAuto = entryPrice * (1 + (tp3Target / 100));
                    }
                    
                    tp1LabelTxt = `目标 +${tp1Target}%`;
                    tp2LabelTxt = `目标 +${tp2Target}%`;
                    tp3LabelTxt = `目标 +${tp3Target}%`;
                }
                
                const tp1Price = (isTracked && stateObj?.customTp1Price) ? stateObj.customTp1Price : tp1PriceAuto;
                const tp2Price = (isTracked && stateObj?.customTp2Price) ? stateObj.customTp2Price : tp2PriceAuto;
                const tp3Price = (isTracked && stateObj?.customTp3Price) ? stateObj.customTp3Price : tp3PriceAuto;
                
                const label1 = (isTracked && stateObj?.customTp1Price) ? `TP1 (${currentConfig.tp1 || 50}%) | 手动自定义` : `TP1 (${currentConfig.tp1 || 50}%) | ${tp1LabelTxt}`;
                const label2 = (isTracked && stateObj?.customTp2Price) ? `TP2 (${currentConfig.tp2 || 30}%) | 手动自定义` : `TP2 (${currentConfig.tp2 || 30}%) | ${tp2LabelTxt}`;
                const label3 = (isTracked && stateObj?.customTp3Price) ? `TP3 (${currentConfig.tp3 || 20}%) | 手动自定义` : `TP3 (${currentConfig.tp3 || 20}%) | ${tp3LabelTxt}`;
                
                const getTpRowHtml = (level, label, price, fired) => {"""
    content = content.replace(old_tp_func, new_tp_func)

    # 3. TpPanel Callers
    old_callers = """                let slHtml = '';
                if (isTracked) {
                    if (currentState.tp1Fired && currentConfig.breakevenSl) {
                        slHtml = `<div class="mt-4 p-3 bg-green-dim border border-green-500 rounded text-sm">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-green font-bold"><i class="fa-solid fa-shield mr-1"></i>动态保本止损已激活</span>
                            </div>
                            <div class="text-xs text-green-400">TP1 已成交，剩余仓位止损线已上移至均价 ${entryPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                        </div>`;
                    } else if (currentConfig.breakevenSl) {
                        slHtml = `<div class="mt-4 p-3 bg-gray-800 border border-gray-700 rounded text-sm">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-gray-400 font-bold"><i class="fa-solid fa-shield mr-1"></i>动态保本止损等待激活</span>
                            </div>
                            <div class="text-xs text-gray-500">当 TP1 成交后，剩余仓位止损线将上移至均价</div>
                        </div>`;
                    }
                }

                return `
                <div class="mb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-sm text-gray-400">分批止盈系统 (${isLong ? '多头' : '空头'})${!isTracked ? ' <span class="text-xs text-yellow-500 font-bold ml-1 px-1 bg-yellow-500/20 rounded">未托管 (不会自动卖出)</span>' : ''}</div>
                        ${refreshBtnHtml}
                    </div>
                    <div class="space-y-2">
                        ${getTpRowHtml(1, label1, tp1Price, isTracked && currentState.tp1Fired)}
                        ${getTpRowHtml(2, label2, tp2Price, isTracked && currentState.tp2Fired)}
                        ${getTpRowHtml(3, label3, tp3Price, isTracked && currentState.tp3Fired)}
                    </div>
                    ${slHtml}
                </div>`;
            };

            if (currentConfig.tradeMode === 'futures' && currentState.futuresPositions && currentState.futuresPositions.length > 0) {
                currentState.futuresPositions.forEach(pos => {
                    const isLong = pos.positionAmt > 0 || pos.positionSide === 'LONG';
                    const posSide = isLong ? 'long' : 'short';
                    const isTracked = (posSide === currentState.positionSide);
                    tpPanelsHtml += renderSingleTpPanel(posSide, pos.entryPrice, isTracked);
                });
            } else if (currentConfig.tradeMode === 'spot' && currentState.spotBalanceBtc > 0) {
                tpPanelsHtml += renderSingleTpPanel('long', currentState.averagePrice || currentPrice, true);
            }"""
            
    new_callers = """                let slHtml = '';
                if (isTracked) {
                    if (stateObj?.tp1Fired && currentConfig.breakevenSl) {
                        slHtml = `<div class="mt-4 p-3 bg-green-dim border border-green-500 rounded text-sm">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-green font-bold"><i class="fa-solid fa-shield mr-1"></i>动态保本止损已激活</span>
                            </div>
                            <div class="text-xs text-green-400">TP1 已成交，剩余仓位止损线已上移至均价 ${entryPrice.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                        </div>`;
                    } else if (currentConfig.breakevenSl) {
                        slHtml = `<div class="mt-4 p-3 bg-gray-800 border border-gray-700 rounded text-sm">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-gray-400 font-bold"><i class="fa-solid fa-shield mr-1"></i>动态保本止损等待激活</span>
                            </div>
                            <div class="text-xs text-gray-500">当 TP1 成交后，剩余仓位止损线将上移至均价</div>
                        </div>`;
                    }
                }

                return `
                <div class="mb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-sm text-gray-400">分批止盈系统 (${isLong ? '多头' : '空头'})${!isTracked ? ' <span class="text-xs text-yellow-500 font-bold ml-1 px-1 bg-yellow-500/20 rounded">未托管 (不会自动卖出)</span>' : ''}</div>
                        ${refreshBtnHtml}
                    </div>
                    <div class="space-y-2">
                        ${getTpRowHtml(1, label1, tp1Price, isTracked && stateObj?.tp1Fired)}
                        ${getTpRowHtml(2, label2, tp2Price, isTracked && stateObj?.tp2Fired)}
                        ${getTpRowHtml(3, label3, tp3Price, isTracked && stateObj?.tp3Fired)}
                    </div>
                    ${slHtml}
                </div>`;
            };

            if (currentConfig.tradeMode === 'futures' && currentState.futuresPositions && currentState.futuresPositions.length > 0) {
                currentState.futuresPositions.forEach(pos => {
                    const isLong = pos.positionAmt > 0 || pos.positionSide === 'LONG';
                    const posSide = isLong ? 'long' : 'short';
                    const stateObj = isLong ? currentState.long : currentState.short;
                    // 如果引擎开启，则托管该方向
                    const isTracked = isLong ? currentState.isLongBotRunning : currentState.isShortBotRunning;
                    tpPanelsHtml += renderSingleTpPanel(posSide, pos.entryPrice, isTracked, stateObj);
                });
            } else if (currentConfig.tradeMode === 'spot' && currentState.spotBalanceBtc > 0) {
                tpPanelsHtml += renderSingleTpPanel('long', currentState.long?.averagePrice || currentPrice, currentState.isLongBotRunning, currentState.long);
            }"""
    content = content.replace(old_callers, new_callers)

    # editTpPrice 
    old_edit = """        function editTpPrice(level, currentPrice) {
            const newP = prompt(`请输入新的 TP${level} 目标价格 (USDT)：`, currentPrice.toFixed(2));
            if (newP !== null && !isNaN(parseFloat(newP))) {
                const payload = {};
                payload[`tp${level}`] = parseFloat(newP);
                authFetch('/api/spot-dca/config', {"""
    new_edit = """        function editTpPrice(level, currentPrice, side) {
            const newP = prompt(`请输入新的 ${side==='short'?'空头':'多头'} TP${level} 目标价格 (USDT)：`, currentPrice.toFixed(2));
            if (newP !== null && !isNaN(parseFloat(newP))) {
                const payload = { side: side };
                payload[`tp${level}`] = parseFloat(newP);
                authFetch('/api/spot-dca/config', {"""
    content = content.replace(old_edit, new_edit)
    
    # Update onclick to pass side
    content = content.replace("onclick=\"editTpPrice(${level}, ${price})\">", "onclick=\"editTpPrice(${level}, ${price}, '${posSide}')\">")

    # In Override sell:
    old_override_amount = """            const coinAmount = (currentState.totalCoinAmount || 0).toFixed(4);
            warningText = `将以市价清空您现货账户中所有的 ${coinAmount} BTC！`;"""
    new_override_amount = """            const coinAmount = (currentState.long?.totalCoinAmount || 0).toFixed(4);
            warningText = `将以市价清空您现货账户中所有的 ${coinAmount} BTC！`;"""
    content = content.replace(old_override_amount, new_override_amount)
    
    with open('public/SpotDCA.html', 'w') as f:
        f.write(content)

rewrite_html()
