import os

def process_engine():
    with open('spotDcaEngine.js', 'r') as f:
        content = f.read()
        
    # Replace initial state
    old_state = """let state = {
  activeDcaCount: 0,
  totalCoinAmount: 0,
  totalUsdtAmount: 0,
  averagePrice: 0,
  entryTime: null, // 持仓起始时间
  totalFees: 0,    // 累计资金费率和手续费
  tp1Fired: false,
  tp2Fired: false,
  tp3Fired: false,
  customTp1Price: null, // 自定义 TP1 价格 (覆盖默认比例)
  customTp2Price: null,
  customTp3Price: null,
  lockedAtr: 0,
  slMoved: false,
  logs: [],
  enabled: true,
  isLongBotRunning: false, // 做多引擎开关 (现货/合约通用)
  isShortBotRunning: false, // 做空引擎开关 (仅合约可用)
  positionSide: null, // 当前持仓方向: 'long' | 'short' | null
  spotBalanceUsdt: 0, // 现货 USDT 余额
  spotBalanceBtc: 0,   // 现货 BTC 余额
  futuresBalanceUsdt: 0 // 永续合约 USDT 余额
};"""
    new_state = """const createPosState = () => ({
  activeDcaCount: 0,
  totalCoinAmount: 0,
  totalUsdtAmount: 0,
  averagePrice: 0,
  entryTime: null,
  totalFees: 0,
  tp1Fired: false,
  tp2Fired: false,
  tp3Fired: false,
  customTp1Price: null,
  customTp2Price: null,
  customTp3Price: null,
  lockedAtr: 0,
  slMoved: false
});

let state = {
  long: createPosState(),
  short: createPosState(),
  logs: [],
  enabled: true,
  isLongBotRunning: false,
  isShortBotRunning: false,
  positionSide: null, // Legacy, kept for fallback
  spotBalanceUsdt: 0,
  spotBalanceBtc: 0,
  futuresBalanceUsdt: 0,
  futuresPositions: []
};"""
    content = content.replace(old_state, new_state)

    # 1. Update fetchBalances sync logic
    old_sync = """            if (activePos) {
                const apiAvgPrice = activePos.entryPrice;
                const localAvgPrice = state.averagePrice || 0;
                // 如果本地均价和 API 均价偏差大于 0.05%，强制同步最新均价
                if (localAvgPrice > 0 && apiAvgPrice > 0 && Math.abs(apiAvgPrice - localAvgPrice) / localAvgPrice > 0.0005) {
                    state.averagePrice = apiAvgPrice;
                    state.totalCoinAmount = Math.abs(activePos.positionAmt);
                    state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 均价漂移修正: 同步至 ${apiAvgPrice.toFixed(2)}`);
                }
            } else if (state.positionSide) {
                // 如果内存里有仓位方向，但交易所返回空仓，说明已经被手动或异常平掉，自动清空状态
                state.activeDcaCount = 0;
                state.totalUsdtAmount = 0;
                state.totalCoinAmount = 0;
                state.averagePrice = 0;
                state.tp1Fired = false;
                state.tp2Fired = false;
                state.tp3Fired = false;
                state.lockedAtr = 0;
                state.positionSide = null;
                state.entryTime = null;
                state.totalFees = 0;
            }"""
    
    new_sync = """            const syncSide = (posSideStr, stateObj) => {
                const active = state.futuresPositions.find(p => p.positionSide === posSideStr);
                if (active) {
                    const apiAvgPrice = active.entryPrice;
                    const localAvgPrice = stateObj.averagePrice || 0;
                    if (localAvgPrice > 0 && apiAvgPrice > 0 && Math.abs(apiAvgPrice - localAvgPrice) / localAvgPrice > 0.0005) {
                        stateObj.averagePrice = apiAvgPrice;
                        stateObj.totalCoinAmount = Math.abs(active.positionAmt);
                        state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 均价漂移修正(${posSideStr}): 同步至 ${apiAvgPrice.toFixed(2)}`);
                    }
                } else if (stateObj.totalCoinAmount > 0.00001) {
                    Object.assign(stateObj, createPosState());
                }
            };
            syncSide('LONG', state.long);
            syncSide('SHORT', state.short);"""
    content = content.replace(old_sync, new_sync)

    # Remove the old fallback logic
    content = content.replace("""            let activePos;
            if (state.positionSide) {
                activePos = state.futuresPositions.find(p => p.positionSide === (state.positionSide === 'short' ? 'SHORT' : 'LONG'));
            } else if (state.futuresPositions.length > 0) {
                activePos = state.futuresPositions[0];
                state.positionSide = activePos.positionSide === 'SHORT' ? 'short' : 'long';
            }""", "")
            
    # Update fees
    old_fees = """// 获取资金费率和手续费
async function fetchPositionFees() {
    if (!state.entryTime || state.totalCoinAmount === 0 || !SPOT_API_KEY || !SPOT_API_SECRET) return;
    
    const timestamp = Date.now();
    const startTime = state.entryTime;"""
    
    new_fees = """// 获取资金费率和手续费
async function fetchPositionFees() {
    if (!SPOT_API_KEY || !SPOT_API_SECRET) return;
    
    const fetchFeeForState = async (stateObj, isShort) => {
        if (!stateObj.entryTime || stateObj.totalCoinAmount === 0) return;
        const timestamp = Date.now();
        const startTime = stateObj.entryTime;"""
        
    old_fees_end = """        state.totalFees = totalFee;
        
        if (state.totalCoinAmount > 0) {
            const isLong = state.positionSide !== 'short';
            const adjUsdt = isLong ? (state.totalUsdtAmount + state.totalFees) : (state.totalUsdtAmount - state.totalFees);
            state.averagePrice = adjUsdt / state.totalCoinAmount;
        }
    } catch (e) {
        console.error('[SpotDCA] Fetch Fees Error:', e.message);
    }
}"""
    
    new_fees_end = """        stateObj.totalFees = totalFee;
        if (stateObj.totalCoinAmount > 0) {
            const adjUsdt = !isShort ? (stateObj.totalUsdtAmount + stateObj.totalFees) : (stateObj.totalUsdtAmount - stateObj.totalFees);
            stateObj.averagePrice = adjUsdt / stateObj.totalCoinAmount;
        }
    } catch (e) {
        console.error('[SpotDCA] Fetch Fees Error:', e.message);
    }
  };
  await fetchFeeForState(state.long, false);
  await fetchFeeForState(state.short, true);
}"""

    content = content.replace(old_fees, new_fees)
    content = content.replace(old_fees_end, new_fees_end)

    # API updates
    content = content.replace("state.tp1Fired = false;\n            state.tp2Fired = false;\n            state.tp3Fired = false;", "state.long.tp1Fired = false; state.long.tp2Fired = false; state.long.tp3Fired = false; state.short.tp1Fired = false; state.short.tp2Fired = false; state.short.tp3Fired = false;")
    content = content.replace("state.customTp1Price = null;\n            state.customTp2Price = null;\n            state.customTp3Price = null;", "state.long.customTp1Price = null; state.long.customTp2Price = null; state.long.customTp3Price = null; state.short.customTp1Price = null; state.short.customTp2Price = null; state.short.customTp3Price = null;")
    content = content.replace("state.lockedAtr = 0;", "state.long.lockedAtr = 0; state.short.lockedAtr = 0;")
    
    # Custom TP update
    old_custom_tp = """        state.customTp1Price = tp1;
        state.customTp2Price = tp2;
        state.customTp3Price = tp3;"""
    new_custom_tp = """        const targetState = req.body.side === 'short' ? state.short : state.long;
        targetState.customTp1Price = tp1;
        targetState.customTp2Price = tp2;
        targetState.customTp3Price = tp3;"""
    content = content.replace(old_custom_tp, new_custom_tp)

    # Override Buy
    old_override_buy = """      // 更新方向标记 (如果之前是空仓)
      if (state.totalCoinAmount < 0.00001) {
          state.positionSide = action === 'market-buy-short' ? 'short' : 'long';
          state.entryTime = Date.now();
          state.totalFees = 0;
      }

      state.activeDcaCount++;
      state.totalUsdtAmount += cumQuote;
      state.totalCoinAmount += executedQty;
      
      const isLong = state.positionSide !== 'short';
      const adjUsdt = isLong ? (state.totalUsdtAmount + (state.totalFees || 0)) : (state.totalUsdtAmount - (state.totalFees || 0));
      state.averagePrice = state.totalCoinAmount > 0 ? (adjUsdt / state.totalCoinAmount) : 0;
      
      try {
          if (regimeModule && typeof regimeModule.getState === 'function') {
              const regimeState = regimeModule.getState();
              if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                  const atrArr = regimeState.indicators.atr;
                  state.lockedAtr = atrArr[atrArr.length - 1];
              }
          }
      } catch(e){}
      
      // 手动加仓后重置止盈状态，按新均价计算
      state.tp1Fired = false;
      state.tp2Fired = false;
      state.tp3Fired = false;
      state.customTp1Price = null;
      state.customTp2Price = null;
      state.customTp3Price = null;"""
      
    new_override_buy = """      const isShort = action === 'market-buy-short';
      const targetState = isShort ? state.short : state.long;

      if (targetState.totalCoinAmount < 0.00001) {
          targetState.entryTime = Date.now();
          targetState.totalFees = 0;
      }

      targetState.activeDcaCount++;
      targetState.totalUsdtAmount += cumQuote;
      targetState.totalCoinAmount += executedQty;
      
      const adjUsdt = !isShort ? (targetState.totalUsdtAmount + (targetState.totalFees || 0)) : (targetState.totalUsdtAmount - (targetState.totalFees || 0));
      targetState.averagePrice = targetState.totalCoinAmount > 0 ? (adjUsdt / targetState.totalCoinAmount) : 0;
      
      try {
          if (regimeModule && typeof regimeModule.getState === 'function') {
              const regimeState = regimeModule.getState();
              if (regimeState && regimeState.indicators && regimeState.indicators.atr) {
                  const atrArr = regimeState.indicators.atr;
                  targetState.lockedAtr = atrArr[atrArr.length - 1];
              }
          }
      } catch(e){}
      
      targetState.tp1Fired = false;
      targetState.tp2Fired = false;
      targetState.tp3Fired = false;
      targetState.customTp1Price = null;
      targetState.customTp2Price = null;
      targetState.customTp3Price = null;"""
    content = content.replace(old_override_buy, new_override_buy)

    # Override Sell
    old_sell = """          // 如果平掉的是当前引擎追踪的方向，则重置引擎状态
          if ((action === 'market-sell-long' && state.positionSide !== 'short') ||
              (action === 'market-sell-short' && state.positionSide === 'short') || action === 'market-sell') {
              state.activeDcaCount = 0;
              state.totalUsdtAmount = 0;
              state.totalCoinAmount = 0;
              state.averagePrice = 0;
              state.tp1Fired = false;
              state.tp2Fired = false;
              state.tp3Fired = false;
              state.lockedAtr = 0;
              state.positionSide = null;
              state.entryTime = null;
              state.totalFees = 0;
          }
      } else {
          // 现货模式
          if (action === 'market-sell-short') throw new Error('现货模式不支持平空');
          if (state.totalCoinAmount > 0.00001) {
              const sellQty = Math.floor(state.totalCoinAmount * 100000) / 100000;
              await executeRealOrder('SELL', sellQty, null);
              state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动现货清仓成功: 卖出 ${sellQty} BTC`);
          }
          state.activeDcaCount = 0;
          state.totalUsdtAmount = 0;
          state.totalCoinAmount = 0;
          state.averagePrice = 0;
          state.tp1Fired = false;
          state.tp2Fired = false;
          state.tp3Fired = false;
          state.lockedAtr = 0;
          state.positionSide = null;
          state.entryTime = null;
          state.totalFees = 0;
      }"""
      
    new_sell = """          if (action === 'market-sell-long' || action === 'market-sell') {
              Object.assign(state.long, createPosState());
          }
          if (action === 'market-sell-short' || action === 'market-sell') {
              Object.assign(state.short, createPosState());
          }
      } else {
          // 现货模式
          if (action === 'market-sell-short') throw new Error('现货模式不支持平空');
          if (state.long.totalCoinAmount > 0.00001) {
              const sellQty = Math.floor(state.long.totalCoinAmount * 100000) / 100000;
              await executeRealOrder('SELL', sellQty, null);
              state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动现货清仓成功: 卖出 ${sellQty} BTC`);
          }
          Object.assign(state.long, createPosState());
      }"""
    content = content.replace(old_sell, new_sell)

    with open('spotDcaEngine.js', 'w') as f:
        f.write(content)

process_engine()
