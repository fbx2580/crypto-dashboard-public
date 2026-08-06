#!/bin/bash
# Kill old server on port 3001, start new one
PID=$(lsof -ti:3001 2>/dev/null)
[ -n "$PID" ] && kill -9 $PID 2>/dev/null
sleep 3
cd /root/.openclaw/workspace/crypto-dashboard
nohup node server.js > /tmp/server.log 2>&1 &
echo "started PID=$!"
