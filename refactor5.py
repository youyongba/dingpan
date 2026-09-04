import re

def fix_sell():
    with open('spotDcaEngine.js', 'r') as f:
        content = f.read()

    # The manual sell logic has some outdated references to positionInfo that used getFuturesPosition (which doesn't exist anymore or wasn't exported).
    # We should use state.long.totalCoinAmount and state.short.totalCoinAmount which are directly available and accurately maintained by the bot!
    
    old_sell = """          const { getFuturesPosition } = require('./spotAutoBot');
          const positionInfo = await getFuturesPosition();
          
          if (action === 'market-sell-long' || (action === 'market-sell' && state.positionSide !== 'short')) {
              if (positionInfo.longAmt > 0.00001) {
                  const closeLongQty = Math.floor(positionInfo.longAmt * 1000) / 1000;
                  await executeFuturesOrder('SELL', closeLongQty, 'LONG');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多成功: 平仓 ${closeLongQty} BTC`);
              } else {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多: 没有找到可平的多头仓位`);
              }
          }
          
          if (action === 'market-sell-short' || (action === 'market-sell' && state.positionSide === 'short')) {
              if (positionInfo.shortAmt > 0.00001) {
                  const closeShortQty = Math.floor(positionInfo.shortAmt * 1000) / 1000;
                  await executeFuturesOrder('BUY', closeShortQty, 'SHORT');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空成功: 平仓 ${closeShortQty} BTC`);
              } else {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空: 没有找到可平的空头仓位`);
              }
          }

          // 如果平掉的是当前引擎追踪的方向，则重置引擎状态
          if ((action === 'market-sell-long' && state.positionSide !== 'short') ||
              (action === 'market-sell-short' && state.positionSide === 'short') || action === 'market-sell') {
              state.activeDcaCount = 0;
              state.totalUsdtAmount = 0;
              state.totalCoinAmount = 0;
              state.averagePrice = 0;
              state.tp1Fired = false;
              state.tp2Fired = false;
              state.tp3Fired = false;
              state.long.lockedAtr = 0; state.short.lockedAtr = 0;
              state.positionSide = null;
              state.entryTime = null;
              state.totalFees = 0;
          }"""
          
    new_sell = """          // 使用内存中同步的精准仓位数据
          if (action === 'market-sell-long' || action === 'market-sell') {
              if (state.long.totalCoinAmount > 0.00001) {
                  const closeLongQty = Math.floor(state.long.totalCoinAmount * 1000) / 1000;
                  await executeFuturesOrder('SELL', closeLongQty, 'LONG');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多成功: 平仓 ${closeLongQty} BTC`);
              } else if (action === 'market-sell-long') {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平多: 没有找到可平的多头仓位`);
              }
              Object.assign(state.long, createPosState());
          }
          
          if (action === 'market-sell-short' || action === 'market-sell') {
              if (state.short.totalCoinAmount > 0.00001) {
                  const closeShortQty = Math.floor(state.short.totalCoinAmount * 1000) / 1000;
                  await executeFuturesOrder('BUY', closeShortQty, 'SHORT');
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空成功: 平仓 ${closeShortQty} BTC`);
              } else if (action === 'market-sell-short') {
                  state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动平空: 没有找到可平的空头仓位`);
              }
              Object.assign(state.short, createPosState());
          }"""
          
    content = content.replace(old_sell, new_sell)

    # 现货模式的也顺带检查一下
    old_spot_sell = """      } else {
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
          state.long.lockedAtr = 0; state.short.lockedAtr = 0;
          state.positionSide = null;
          state.entryTime = null;
          state.totalFees = 0;
      }"""
      
    new_spot_sell = """      } else {
          // 现货模式
          if (action === 'market-sell-short') throw new Error('现货模式不支持平空');
          if (state.long.totalCoinAmount > 0.00001) {
              const sellQty = Math.floor(state.long.totalCoinAmount * 100000) / 100000;
              await executeRealOrder('SELL', sellQty, null);
              state.logs.unshift(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] 手动现货清仓成功: 卖出 ${sellQty} BTC`);
          }
          Object.assign(state.long, createPosState());
      }"""
    content = content.replace(old_spot_sell, new_spot_sell)

    with open('spotDcaEngine.js', 'w') as f:
        f.write(content)

fix_sell()
