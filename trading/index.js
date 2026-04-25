/**
 * ============================================================
 *  trading/index.js
 *  自动平仓引擎装配入口
 *
 *  在 server.js 里只需要：
 *    const autoTrade = require('./trading');
 *    autoTrade.attach(app);
 *  即可启动 WS 价格订阅 + 风控引擎 + 路由
 * ============================================================
 */
'use strict';

const router = require('./router');
const priceFeed = require('./priceFeed');
const riskEngine = require('./riskEngine');
const config = require('./config');

let started = false;

function attach(app, opts = {}) {
  const mountPath = opts.mountPath || '/api/auto-trade';
  app.use(mountPath, router);
  if (!started) {
    started = true;
    riskEngine.start();
    priceFeed.start();
    console.log(`[auto-trade] 已挂载于 ${mountPath}, WS+风控已启动`);
  }
  return router;
}

module.exports = {
  attach,
  router,
  priceFeed,
  riskEngine,
  config,
};
