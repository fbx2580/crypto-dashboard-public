#!/usr/bin/env node
/**
 * Jin10 HTTP降级 daemon — 独立于Chromium主采集器
 * 5秒抓一次，不管有没有新数据都刷新文件时间戳
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, 'public', 'data', 'news', 'jin10.json');

async function fetch() {
  try {
    const resp = await axios.get('https://www.jin10.com', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
    });

    // 简单解析：先去掉HTML标签，再找 HH:MM:SS 文本对
    const text = resp.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
    
    // 匹配时间戳后跟文本: HH:MM:SS 后面直到下一个 HH:MM:SS 的所有文本
    const re = /(\d{2}:\d{2}:\d{2})\s+([\s\S]*?)(?=\d{2}:\d{2}:\d{2}|$)/g;
    let m;
    const items = [];
    while ((m = re.exec(text)) !== null && items.length < 30) {
      const time = m[1].slice(0, 5);
      const title = m[2].trim();
      if (title.length < 5) continue;
      if (/TradingHero|金十数据·|VIP年会员|高定礼盒|金十数据APP|金十开放平台|PLUS|解锁直达/i.test(title)) continue;
      items.push({ t: time, s: title, src: 'jin10-http' });
    }

    // 读取现有数据，去重合并
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(f, 'utf8')).items || []; } catch (e) {}

    const seen = new Set(existing.map(i => i.s));
    let added = 0;
    for (const item of items) {
      if (!seen.has(item.s)) {
        existing.unshift(item);
        seen.add(item.s);
        added++;
      }
    }

    // 按时间排序
    existing.sort((a, b) => {
      const ta = a.t || '', tb = b.t || '';
      return (parseInt(tb) * 60 + parseInt(tb.split(':')[1] || 0)) - (parseInt(ta) * 60 + parseInt(ta.split(':')[1] || 0));
    });

    fs.writeFileSync(f, JSON.stringify({
      items: existing.slice(0, 500),
      updated: Date.now(),
      source: 'jin10-http',
    }, null, 2));

    console.log(`[jin10-http] ${new Date().toISOString().slice(11, 19)} +${added}新 共${existing.length}条`);

    // 写SQLite
    if (added > 0) {
      try {
        const db = require('better-sqlite3')(path.join(__dirname, 'data', 'dashboard.db'));
        const ins = db.prepare('INSERT OR IGNORE INTO news_archive (source, title, content, url, ts) VALUES (?, ?, ?, ?, ?)');
        const tx = db.transaction((list) => {
          for (const i of list) {
            const title = (i.s || '').slice(0, 200);
            if (!title) continue;
            const ts = Math.floor(Date.now() / 1000);
            ins.run('jin10', title, '', '', ts);
          }
        });
        const newItems = items.filter(item => {
          return !JSON.parse(fs.readFileSync(f, 'utf8')).items.slice(0, -added).some(e => e.s === item.s);
        });
        tx(newItems);
      } catch(e) {}
    }
  } catch (e) {
    console.error(`[jin10-http] ${new Date().toISOString().slice(11, 19)} err:`, e.message.slice(0, 40));
  }
  setTimeout(fetch, 5000);
}

console.log('[jin10-http] 🚀 HTTP降级daemon启动');
fetch();
