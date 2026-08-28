const WebSocket = require('ws');
const fs = require('fs');
const ws = new WebSocket('wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms');
ws.on('open', () => console.log('Connected!'));
ws.on('message', data => {
  fs.appendFileSync('ws_dump.txt', data + '\n');
});
setTimeout(() => process.exit(0), 3000);
