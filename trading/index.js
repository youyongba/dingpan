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

  // 便捷别名: /api/close-all-positions (用户硬性要求路径)
  // 复用 router 内已抽出的 requireAdmin + manualCloseAllImpl, 行为完全一致
  if (opts.aliases !== false) {
    app.post('/api/close-all-positions', router.requireAdmin, async (req, res) => {
      const r = await router.manualCloseAllImpl({
        source: req.body?.source || 'manual_ui_alias',
      });
      res.json(r);
    });
  }

  if (!started) {
    started = true;
    riskEngine.start();
    priceFeed.start();
    console.log(`[auto-trade] 已挂载于 ${mountPath} (alias: /api/close-all-positions), WS+风控已启动`);
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
