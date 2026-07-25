#!/bin/sh
# 全局保活：采集器 + 服务 + 隧道，挂了秒级重启
DIR=$(dirname "$0")
LOG="/tmp/supervisor.log"

log() { echo "[$(date '+%H:%M:%S')] $1" >> "$LOG"; }

# 保活列表
PROCS="whale-monitor.js binance-fetcher.js jin10-scraper.js rss-fetcher.js monitor.js"

# server.js 单独管（需要传 cwd）
check_server() {
  if ! pgrep -f "node server.js" > /dev/null 2>&1; then
    log "🔄 server.js 挂了，重启..."
    cd "$DIR" && nohup node server.js > /tmp/server-v2.log 2>&1 &
    sleep 2
    if pgrep -f "node server.js" > /dev/null 2>&1; then
      log "✅ server.js restarted"
    else
      log "❌ server.js 重启失败"
    fi
  fi
}

# cloudflared 隧道保活
check_tunnel() {
  if ! pgrep cloudflared > /dev/null 2>&1; then
    log "🔄 cloudflared 隧道挂了，重启..."
    nohup cloudflared tunnel --url http://localhost:8080 --no-autoupdate > /tmp/cloudflared.log 2>&1 &
    sleep 3
    local url=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log 2>/dev/null | tail -1)
    log "✅ 隧道重启: ${url:-waiting...}"
  fi
}

while true; do
  # 采集器
  for script in $PROCS; do
    if ! pgrep -f "node $script" > /dev/null 2>&1; then
      log "🔄 $script 挂了，重启..."
      cd "$DIR" && nohup node "$script" > /dev/null 2>&1 &
      sleep 1
    fi
  done

  # server.js
  check_server

  # cloudflared 隧道
  check_tunnel

  sleep 10
done
