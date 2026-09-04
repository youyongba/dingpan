import re

with open('public/SpotDCA.html', 'r', encoding='utf-8') as f:
    content = f.read()

old_block = """            const avgPrice = currentState.averagePrice || 0;
            
            // 为了在有双向持仓时能正常显示止盈列表，判断逻辑不再简单粗暴要求 hasPosition
            const hasPosition = avgPrice > 0 && ((currentState.totalCoinAmount > 0) || (currentConfig.tradeMode === 'futures' && currentState.futuresPositions && currentState.futuresPositions.length > 0 && renderedPosition));
            
            if (hasPosition && currentPrice > 0) {
                const tpMode = currentConfig.tpMode || 'percent';
                const currentAtr = currentRealIndicators?.currentAtr || 0;
                const activeAtr = (tpMode === 'atr_static' && currentState.lockedAtr > 0) ? currentState.lockedAtr : currentAtr;
                
                const tp1Target = import re

with open('public/SpotDCA.html', '2T