
exports.getLatestPlan = () => ({
  tradePlan: {
    ok: true,
    direction: 'short',
    entry: 77895.42,
    stopLoss: 78588.77,
    riskPct: '0.89',
    suggestedPositionPct: 10,
    confidenceLabel: '低',
    takeProfits: [
      { level: 'TP1', price: 77202.06, rr: '1R', gainPct: '0.89', closePct: 50, note: '' },
      { level: 'TP2', price: 76508.71, rr: '2R', gainPct: '1.78', closePct: 30, note: '' },
      { level: 'TP3', price: 75815.36, rr: '3R', gainPct: '2.67', closePct: 20, note: '' },
    ],
  },
  regime: { regime: 'trend' },
  latest: { close: 77664 },
  updatedAt: Date.now(),  // 新鲜
});
