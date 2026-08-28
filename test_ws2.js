const WebSocket = require('ws');
const ws = new WebSocket('wss://fstream.binance.com/stream?streams=btcusdt@aggtrade/btcusdt@depth20@100ms');

ws.on('open', () => {
    console.log('Connected');
});

let aggCount = 0;
let depthCount = 0;

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.stream && msg.stream.toLowerCase().endsWith('@aggtrade')) {
        aggCount++;
    } else if (msg.stream && msg.stream.includes('depth')) {
        depthCount++;
    }
});

setTimeout(() => {
    console.log(`AggTrade count: ${aggCount}, Depth count: ${depthCount}`);
    ws.close();
    process.exit(0);
}, 5000);
