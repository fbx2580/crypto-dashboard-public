#!/bin/sh
# 实时数据守护进程
# RSS(1s) + 鲸鱼(1s) + ETH(1s) + 金十(5s Chromium极限)
DIR="/root/.openclaw/workspace/crypto-dashboard"
LOG="/tmp/realtime-supervisor.log"

log() { echo "[$(date '+%H:%M:%S')] $1" >> "$LOG"; }

# 保活函数
keep() { while true; do pgrep -f "$1" >/dev/null || { log "启动 $1"; nohup $2 > /tmp/$1.log 2>&1 & }; sleep 5; done; }

# RSS + 鲸鱼 + ETH 合一个1秒进程
keep "rt-daemon" "node /tmp/rt-daemon.js" &
# 金十独立（Chromium）
keep "jin10-scraper" "node $DIR/jin10-scraper.js" &
# 价格异动
keep "price-alert" "node $DIR/price-alert.js" &

wait
