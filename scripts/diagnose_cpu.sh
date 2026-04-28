#!/usr/bin/env bash
# ============================================================
#  scripts/diagnose_cpu.sh
#  一键 CPU 高占用诊断 (针对本项目)
#
#  使用：
#    bash scripts/diagnose_cpu.sh                 # 输出到屏幕
#    bash scripts/diagnose_cpu.sh > /tmp/cpu.txt  # 落盘
#
#  覆盖排查项：
#    1) 当前所有 node / nodemon 进程 — 排查多实例并行
#    2) 同端口监听 (3001) — 多进程竞争
#    3) 进程内线程 CPU (top -H) — 定位是 V8 主线程 / GC 还是 libuv 线程池
#    4) 网络连接数 (binance/feishu/telegram/ngrok)
#    5) 句柄数 / socket 数 — 检测 fd 泄漏
#    6) pm2 instances 数量
#    7) 应用日志关键字 — 重连风暴 / regime 堆积
#    8) 系统层 OOM / kernel 警告
#    9) 当前 priceFeed 状态 + pending 仓位状态
# ============================================================
set -uo pipefail

PORT="${PORT:-3001}"
APP_PATTERN="${APP_PATTERN:-server.js}"
LOG_FILE="${LOG_FILE:-}"   # 可选: export LOG_FILE=/var/log/regime/app.log

echo "============================================================"
echo "  CPU 高占用诊断  -  $(date '+%F %T')"
echo "============================================================"

# ---------- 1) 所有 node / nodemon 进程 ----------
echo ""
echo "── [1/9] 当前 node / nodemon 进程 (按 CPU 降序) ──"
ps -eo pid,ppid,pcpu,pmem,etime,rss,comm,args --sort=-pcpu \
  | grep -E 'node|nodemon' | grep -v grep || echo "  (没有匹配进程)"

NODE_COUNT=$(pgrep -f "node .*${APP_PATTERN}" | wc -l | tr -d ' ')
NODEMON_COUNT=$(pgrep -f "nodemon" | wc -l | tr -d ' ')
echo ""
echo "  → 匹配 'node ${APP_PATTERN}' 的进程数: ${NODE_COUNT}"
echo "  → 匹配 'nodemon' 的进程数:           ${NODEMON_COUNT}"
if [ "${NODE_COUNT}" -gt 1 ]; then
  echo "  ⚠️  存在多个 ${APP_PATTERN} 进程! 这就是 CPU 160% 的最可能原因."
  echo "      用 'pm2 list' / 'systemctl status <svc>' 找老进程并 kill 它."
fi

# ---------- 2) 端口监听 ----------
echo ""
echo "── [2/9] 端口 ${PORT} 监听情况 ──"
if command -v ss >/dev/null 2>&1; then
  ss -tnlp 2>/dev/null | grep ":${PORT} " || echo "  (端口 ${PORT} 没有 LISTEN)"
elif command -v lsof >/dev/null 2>&1; then
  lsof -i :${PORT} -P -n -sTCP:LISTEN 2>/dev/null || echo "  (lsof 无结果)"
else
  netstat -tnlp 2>/dev/null | grep ":${PORT} " || echo "  (没有结果)"
fi

# ---------- 3) 进程内线程 ----------
PID=$(pgrep -f "node .*${APP_PATTERN}" | head -1)
echo ""
if [ -z "${PID}" ]; then
  echo "── [3/9] 找不到目标进程, 跳过线程 / fd / 网络检查 ──"
else
  echo "── [3/9] PID=${PID} 各线程 CPU ──"
  if command -v top >/dev/null 2>&1; then
    top -H -b -n 1 -p "${PID}" 2>/dev/null | tail -n +6 | head -30
  fi

  echo ""
  echo "── [4/9] PID=${PID} 网络连接 ──"
  if command -v ss >/dev/null 2>&1; then
    EST=$(ss -tnp 2>/dev/null | grep "pid=${PID}," | wc -l | tr -d ' ')
    echo "  established 总数: ${EST}"
    ss -tnp 2>/dev/null | grep "pid=${PID}," | awk '{print $5}' | awk -F: '{print $1}' \
      | sort | uniq -c | sort -rn | head -10
  fi

  echo ""
  echo "── [5/9] PID=${PID} 文件句柄统计 ──"
  if [ -d "/proc/${PID}/fd" ]; then
    FD_COUNT=$(ls /proc/${PID}/fd 2>/dev/null | wc -l | tr -d ' ')
    echo "  fd 总数: ${FD_COUNT}"
    ls -l /proc/${PID}/fd 2>/dev/null | awk '{print $11}' \
      | sed -E 's/\[[^]]+\]//g; s/[0-9]+$//; s/socket:.*/socket/' \
      | sort | uniq -c | sort -rn | head -10
  else
    # macOS fallback
    if command -v lsof >/dev/null 2>&1; then
      FD_COUNT=$(lsof -p "${PID}" 2>/dev/null | wc -l | tr -d ' ')
      echo "  lsof 句柄数: ${FD_COUNT}"
    fi
  fi
fi

# ---------- 6) PM2 ----------
echo ""
echo "── [6/9] pm2 状态 ──"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | grep -oE '"name":"[^"]+"' | sort | uniq -c
  pm2 list --no-color 2>/dev/null || true
else
  echo "  (未安装 pm2)"
fi

# ---------- 7) 应用日志关键字 ----------
echo ""
echo "── [7/9] 应用日志关键字 (最近 1000 行) ──"
SOURCE=""
if [ -n "${LOG_FILE}" ] && [ -f "${LOG_FILE}" ]; then
  SOURCE="${LOG_FILE}"
  RAW=$(tail -n 1000 "${LOG_FILE}" 2>/dev/null || true)
elif command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name"'; then
  SOURCE="pm2 logs"
  RAW=$(pm2 logs --lines 1000 --nostream --raw 2>/dev/null || true)
elif command -v journalctl >/dev/null 2>&1; then
  SVC=$(systemctl list-units --type=service --state=running --no-pager 2>/dev/null \
        | grep -Ei 'regime|btc|trade|node' | awk '{print $1}' | head -1)
  if [ -n "${SVC}" ]; then
    SOURCE="journalctl -u ${SVC}"
    RAW=$(journalctl -u "${SVC}" -n 1000 --no-pager 2>/dev/null || true)
  fi
fi
if [ -z "${SOURCE}" ]; then
  echo "  (没找到日志源, 可设 LOG_FILE=/path/to/app.log 重跑)"
else
  echo "  日志源: ${SOURCE}"
  echo "  · 重连风暴 (priceFeed):"
  echo "${RAW}" | grep -E '\[trade\.priceFeed\] (连接|⚠️|错误|连接关闭|强制重连)' \
    | awk '{print $1, $2}' | sort | uniq -c | sort -rn | head -5
  echo "  · regime 堆积告警:"
  echo "${RAW}" | grep -E '上一轮 refresh 还在跑|refresh failed' | tail -5
  echo "  · event-loop lag:"
  echo "${RAW}" | grep -E '\[perf\] ⚠️ event-loop' | tail -5
  echo "  · webhook 异常:"
  echo "${RAW}" | grep -Ei 'webhook.*失败|webhook biz' | tail -5
fi

# ---------- 8) 系统层 ----------
echo ""
echo "── [8/9] dmesg / kernel 警告 ──"
if command -v dmesg >/dev/null 2>&1; then
  sudo -n dmesg -T 2>/dev/null | grep -Ei 'oom|killed|throttl|tcp.*drop' | tail -10 \
    || dmesg 2>/dev/null | grep -Ei 'oom|killed|throttl' | tail -10 \
    || echo "  (无权限或无内核警告)"
fi

# ---------- 9) auto-trade 状态 ----------
echo ""
echo "── [9/9] 当前 auto-trade 状态 ──"
if command -v curl >/dev/null 2>&1; then
  curl -sf "http://127.0.0.1:${PORT}/api/auto-trade/status" 2>/dev/null \
    | (command -v jq >/dev/null && jq '{enabled, pendingMode, pendingTtlMin, priceFeed, "long": .positions.long | {active, pending, locked, entryPrice, pendingPlan}, "short": .positions.short | {active, pending, locked, entryPrice, pendingPlan}}' \
       || cat) \
    || echo "  (服务无响应或 jq 缺失)"
fi

echo ""
echo "============================================================"
echo "  诊断结束. 如果第 [1] 项显示多个 node 进程, 这就是元凶."
echo "  解决: kill 老进程 (留 1 个), 然后用 pm2 接管:"
echo "    pkill -f 'node .*server.js'   # 强 kill 老进程 (谨慎: 会触发 WS 断开 → 重连)"
echo "    pm2 start server.js --name regime --max-memory-restart 800M -i 1"
echo "    pm2 save"
echo "============================================================"
