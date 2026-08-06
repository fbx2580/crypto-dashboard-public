#!/bin/bash
# Kill old supervisors, start v3
for pid in $(pgrep -f 'supervisor\.js' 2>/dev/null); do
    kill -9 $pid 2>/dev/null
done
sleep 2
cd /root/.openclaw/workspace/crypto-dashboard
nohup node supervisor.js > /tmp/supervisor.log 2>&1 &
echo "supervisor v3 PID=$!"
