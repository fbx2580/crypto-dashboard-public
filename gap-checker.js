#!/usr/bin/env node
/**
 * P0: 金十新闻断层检测 + 自动回补
 * 每 10 分钟检查一次，发现断层立刻重爬
 */
const fs = require('fs');
const path = require('path');
const { scrapeJin10 } = require('/root/.openclaw/workspace/crypto-dashboard/jin10-scraper');

const JIN10_FILE = '/root/.openclaw/workspace/crypto-dashboard/public/data/news/jin10.json';

async function checkGap() {
  if (!fs.existsSync(JIN10_FILE)) {
    console.log('[gap] jin10.json 不存在，触发采集');
    await scrapeJin10();
    return;
  }

  const d = JSON.parse(fs.readFileSync(JIN10_FILE, 'utf8'));
  const items = d.items || [];
  if (items.length === 0) {
    console.log('[gap] 数据为空，触发采集');
    await scrapeJin10();
    return;
  }

  // 检查每条新闻的时间分布
  const hours = {};
  for (let h = 0; h < 24; h++) hours[h] = 0;
  items.forEach(i => {
    const h = parseInt((i.t || '00').split(':')[0]);
    if (h >= 0 && h < 24) hours[h]++;
  });

  // 找断层：连续 N 小时为 0
  const now = new Date();
  const currentHour = now.getUTCHours();
  let gapStart = -1;
  const gaps = [];

  for (let h = 0; h < 24; h++) {
    if (hours[h] === 0) {
      if (gapStart === -1) gapStart = h;
    } else {
      if (gapStart !== -1 && h - gapStart >= 2) {
        gaps.push({ start: gapStart, end: h - 1, hours: h - gapStart });
      }
      gapStart = -1;
    }
  }
  if (gapStart !== -1 && 24 - gapStart >= 2) {
    gaps.push({ start: gapStart, end: 23, hours: 24 - gapStart });
  }

  if (gaps.length > 0) {
    console.log(`[gap] ⚠️ 发现断层:`);
    gaps.forEach(g => console.log(`  ${String(g.start).padStart(2,'0')}:00 → ${String(g.end).padStart(2,'0')}:00 (${g.hours}小时)`));

    // 尝试回补：连续爬取 3 轮
    console.log('[gap] 触发回补...');
    for (let i = 0; i < 3; i++) {
      try { await scrapeJin10(); } catch(e) {}
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }
    console.log('[gap] 回补完成');
  } else {
    console.log('[gap] ✅ 24小时全覆盖，无断层');
  }
}

checkGap().catch(e => console.error('[gap] 失败:', e.message));
