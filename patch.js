const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'spotDcaData.json');
let data = JSON.parse(fs.readFileSync(file, 'utf8'));

// 强行把用户当前的空头状态修正为：已经触发了TP1和TP2
data.positions.short.tp1Fired = true;
data.positions.short.tp2Fired = true;
data.positions.short.activeDcaCount = 1; // 为了让界面对齐
data.positions.short.totalCoinAmount = 0.001;
data.positions.short.averagePrice = 76633.10;
data.positions.short.totalUsdtAmount = 0.001 * 76633.10;
// 我们不改lockedAtr，因为服务重启后syncSide会用API的数据，只要有totalCoinAmount它就不会触发“自动接管”了。
// 实际上，如果我们将 totalCoinAmount 设为 0.001，那么重启后，syncSide 发现 localAmt (0.001) == apiAmt (0.001)，就不会执行自动接管！
// 它就不会重置 lockedAtr 了！

fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log('Patch applied!');
