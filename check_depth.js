const axios = require('axios');
const { httpAgent, httpsAgent } = require('./lib/httpAgents');

async function test() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000', {
            httpAgent, httpsAgent
        });
        const data = res.data;
        
        let maxBid = 0, maxBidP = 0;
        data.bids.forEach(b => {
            const p = parseFloat(b[0]); const v = parseFloat(b[1]);
            if (v > maxBid) { maxBid = v; maxBidP = p; }
        });
        
        let maxAsk = 0, maxAskP = 0;
        data.asks.forEach(a => {
            const p = parseFloat(a[0]); const v = parseFloat(a[1]);
            if (v > maxAsk) { maxAsk = v; maxAskP = p; }
        });
        
        console.log(`Max Bid: ${maxBidP} (Vol: ${maxBid})`);
        console.log(`Max Ask: ${maxAskP} (Vol: ${maxAsk})`);
        console.log(`Top Bid: ${data.bids[0][0]}, Top Ask: ${data.asks[0][0]}`);
    } catch(e) {
        console.error(e.message);
    }
}
test();