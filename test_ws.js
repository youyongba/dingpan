const WebSocket = require('ws');
const { SocksProxyAgent } = require('socks-proxy-agent');
const agent = new SocksProxyAgent('socks5://127.0.0.1:7890');
const ws = new WebSocket('wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms', { agent });
ws.on('open', () => console.log('Connected'));
ws.on('message', data => {
  const msg = JSON.parse(data);
  console.log("STREAM:", msg.stream);
  if (msg.stream.endsWith('@aggTrade')) {
      console.log('AggTrade Price:', msg.data.p);
  }
});
setTimeout(() => {
    ws.close();
    process.exit(0);
}, 3000);
