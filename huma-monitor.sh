#!/bin/bash
# HUMA 价格监控 — 每分钟执行
# 成本价: $0.019 | 监控: 合约 FAPI

LOG="/tmp/huma-monitor.log"
COST="0.019"

NOW=$(date -u +%s)
DATA=$(curl -s --max-time 8 "https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=HUMAUSDT" 2>/dev/null)

if [ -z "$DATA" ] || echo "$DATA" | grep -q "code"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] ⚠️ API拉取失败" >> "$LOG"
  exit 0
fi

PRICE=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['lastPrice'])")
HIGH=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['highPrice'])")
LOW=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['lowPrice'])")
CHG=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['priceChangePercent'])")
VOL=$(echo "$DATA" | python3 -c "import sys,json; v=float(json.load(sys.stdin)['volume']); print(f'{v/1e6:.1f}M')")

# 计算相对成本的变化
DELTA=$(python3 -c "p=float('$PRICE'); c=float('$COST'); d=(p-c)/c*100; print(f'{d:+.2f}')")

# 判断触发等级
LEVEL=""
if python3 -c "exit(0 if float('$PRICE') >= float('$COST') else 1)" 2>/dev/null; then
  LEVEL="🚨 回本！"
elif python3 -c "p=float('$PRICE'); c=float('$COST'); exit(0 if (c-p)/c >= 0.05 else 1)" 2>/dev/null; then
  LEVEL="⚠️ 亏损>5%"
elif python3 -c "p=float('$PRICE'); c=float('$COST'); exit(0 if (p-c)/c >= 0.05 else 1)" 2>/dev/null; then
  LEVEL="📈 盈利>5%"
fi

LINE="[$(date '+%Y-%m-%d %H:%M:%S UTC')] HUMA \$$PRICE | 24h:${CHG}% | H:\$$HIGH L:\$$LOW | V:$VOL | 成本:\$$COST ($DELTA%) $LEVEL"
echo "$LINE" >> "$LOG"

# 只保留最近 10 条记录在状态文件（供快速查询）
tail -10 "$LOG" > /tmp/huma-status.txt

# 触发了就写标记
if [ -n "$LEVEL" ]; then
  echo "$LINE" >> /tmp/huma-alerts.txt
fi
