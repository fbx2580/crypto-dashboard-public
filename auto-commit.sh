#!/bin/sh
# 自动提交脚本 — 每次代码修改后运行
DIR=$(dirname "$0")
cd "$DIR"

# 只提交源码，不提交运行时数据
STAGE_FILES="*.js modules/ public/app.js public/index.html public/style.css package.json .gitignore"

echo "[auto-commit] $(date '+%H:%M:%S')"

# 检测变更
CHANGED=$(git status --porcelain -- $STAGE_FILES 2>/dev/null | wc -l)
if [ "$CHANGED" -eq 0 ]; then
  echo "  ✅ 无变更"
  exit 0
fi

# 智能 commit message
git add $STAGE_FILES 2>/dev/null

# 提取变更摘要
SUMMARY=$(git diff --cached --stat 2>/dev/null | tail -1)
echo "  📦 $SUMMARY"

# 自动分类 commit 类型
if echo "$SUMMARY" | grep -q "新增\|new file\|create"; then
  TYPE="feat"
elif echo "$SUMMARY" | grep -q "修复\|fix\|bug"; then
  TYPE="fix"
else
  TYPE="refactor"
fi

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
git commit -m "${TYPE}: ${TIMESTAMP} — $(echo $SUMMARY | head -c 50)" 2>/dev/null
echo "  ✅ committed [$TYPE]"

# Push
git push origin dev 2>/dev/null && echo "  ✅ pushed → origin/dev" || echo "  ⚠ push failed"
