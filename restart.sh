#!/bin/sh
# 自动检测 server.js + modules/*.js 变化后重启
WATCH_DIR=$(dirname "$0")
PID_FILE="$WATCH_DIR/.server.pid"
CURRENT_PID=""

while true; do
  NEW_PID=$(pgrep -f "node server.js" 2>/dev/null | head -1)
  if [ "$NEW_PID" != "$CURRENT_PID" ]; then
    echo "[watch] server pid: $NEW_PID"
    CURRENT_PID=$NEW_PID
  fi
  # 检查文件变化
  for f in server.js modules/*.js; do
    if [ "$f" -nt "$WATCH_DIR/.server_pid_checked" ]; then
      echo "[watch] 🔄 $f changed, restarting server..."
      pkill -f "node server.js" 2>/dev/null
      sleep 1
      nohup node "$WATCH_DIR/server.js" > /tmp/server-v2.log 2>&1 &
      echo $! > "$PID_FILE"
      touch "$WATCH_DIR/.server_pid_checked"
      break
    fi
  done
  sleep 3
done
