/**
 * lib/timeFmt.js
 *
 * 全局统一的"东八区时间字符串"格式化, 给 TG / 飞书 / 控制台 / 通知里的时间显示用.
 *
 * 为什么必须这层抽象:
 *   1. Node 默认 toLocaleString() 取**服务器本地时区**, Linux 上常常是 UTC,
 *      这会让 TG 推送里的"⏰ 18:30:00" 实际上对应北京时间 02:30:00, 严重误导操作判断.
 *   2. 想做到"无论容器/服务器在哪, 用户看到的永远是北京时间", 必须显式锁 timeZone.
 *   3. 多处 (notifier/telegram, trading/executor, trading/router, trading/riskEngine)
 *      都要打时间, 共享同一个工具函数避免散弹式维护漏改.
 *
 * 用法:
 *   const { cnTime } = require('../lib/timeFmt');
 *   `⏰ ${cnTime()}`                 // 当前北京时间
 *   `⏳ 过期: ${cnTime(expireAt)}`   // 把毫秒时间戳/ISO字符串/Date 都转成北京时间
 */
'use strict';

const TIMEZONE = 'Asia/Shanghai';

/**
 * 把时间点格式化为"YYYY/MM/DD HH:mm:ss"风格的北京时间字符串 (zh-CN locale, 24h).
 *
 * @param {Date|number|string} [d=new Date()]  无参=当前时刻
 * @returns {string}  e.g. '2026/05/01 18:30:45'
 */
function cnTime(d) {
  if (d == null) return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: TIMEZONE });
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '--';
  return dt.toLocaleString('zh-CN', { hour12: false, timeZone: TIMEZONE });
}

module.exports = { cnTime, TIMEZONE };
