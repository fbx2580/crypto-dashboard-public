#!/bin/sh
# ─── 自动 Git 提交+推送 ───
# 每小时检查一次，有改动才提交
# 只推 dev 分支，不碰 master

cd /root/.openclaw/workspace/crypto-dashboard

# 检查是否有改动
CHANGES=$(git status --porcelain | grep -v "data/" | grep -v "\.log" | grep -v "public/data" | wc -l)

if [ "$CHANGES" -eq 0 ]; then
  echo "[auto-git] $(date '+%H:%M') 无变化，跳过"
  exit 0
fi

# 有改动，提交
git add -A
git commit -m "📦 自动归档 $(date '+%Y-%m-%d %H:%M')"

# 推送到私有仓库 dev 分支
git push origin dev 2>&1 | tail -1

echo "[auto-git] ✅ $(date '+%H:%M') 已推送 $CHANGES 个文件变更"
