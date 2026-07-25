#!/bin/sh
# 采集器保活：挂了自动重启
DIR=$(dirname "$0")
COLLECTORS="whale-monitor.js binance-fetcher.js jin10-scraper.js rss-fetcher.js monitor.js"

while true; do
  for script in $COLLECTORS; do
    if ! pgrep -f "node $script" > /dev/null 2>&1; then
      echo "[supervisor] 🔄 $script 挂了，重启中..."
      cd "$DIR"
      nohup node "$script" > /dev/null 2>&1 &
      echo "[supervisor] ✅ $script restarted"
    fi
  done
  sleep 30
done
