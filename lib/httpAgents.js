/**
 * ============================================================
 *  lib/httpAgents.js
 *  全局共享的 HTTP / HTTPS keep-alive agent
 *
 *  目的：让所有 axios 调用复用 TCP/TLS 连接，避免每次请求都重新
 *  握手（CPU 密集 + RTT 浪费）。本模块是纯传输层基础设施，不
 *  改动任何业务 payload / URL / 鉴权语义。
 *
 *  用法：
 *    const { httpAgent, httpsAgent } = require('./lib/httpAgents');
 *    axios.get(url, { httpAgent, httpsAgent, timeout: 10000 });
 *
 *  注意：当请求需要走代理 (HttpsProxyAgent / SocksProxyAgent) 时，
 *  axios 的 agent 字段会被代理 agent 覆盖，本模块不参与。
 * ============================================================
 */
'use strict';

const http = require('http');
const https = require('https');

const AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000,
  scheduling: 'lifo',
};

const httpAgent = new http.Agent(AGENT_OPTS);
const httpsAgent = new https.Agent(AGENT_OPTS);

module.exports = { httpAgent, httpsAgent };
