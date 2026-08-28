import asyncio
import websockets
import json
import ssl

async def test():
    uri = "wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms"
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    # We can't easily use socks5 with websockets in python without extra libs.
    # Let's try Node.js with https-proxy-agent but ignoring SSL errors.
