const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'news');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CACHE_FILE = path.join(DATA_DIR, 'jin10.json');
const FALLBACK_FILE = path.join(DATA_DIR, 'jin10_fallback.json');

async function scrapeJin10() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto('https://www.jin10.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(6000);

    const items = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
      const results = [];

      for (let i = 0; i < lines.length - 1; i++) {
        const m = lines[i].match(/^(\d{2}:\d{2}):\d{2}$/);
        if (!m) continue;
        const time = m[1];

        let bodyLines = [];
        let tags = [];
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const line = lines[j];
          if (/^\d{2}:\d{2}:\d{2}$/.test(line)) break;
          if (/^[火热沸爆]/.test(line)) { tags.push(line); continue; }
          if (line.length < 5 || /^\d+(\.\d+)?%?$/.test(line)) continue;
          if (['重要事件','查看更多','市场快讯','VIP快讯','分类','PLUS'].some(s => line.includes(s))) continue;
          bodyLines.push(line);
        }
        if (bodyLines.length === 0) continue;

        const title = bodyLines[0];
        if (results.some(r => r.s === title)) continue;

        // 检测颜色：遍历所有叶子元素找到匹配标题的红色文字
        let isRed = false;
        const allEls = document.querySelectorAll('b, strong, span, div');
        for (const el of allEls) {
          if (el.children.length > 0) continue;
          const txt = (el.textContent || '').trim();
          // 标题可能被截断，用前20字匹配
          if (txt.length > 5 && title.startsWith(txt.slice(0, 20))) {
            const color = getComputedStyle(el).color;
            if (color === 'rgb(225, 68, 84)') { isRed = true; break; }
          }
        }

        const item = { t: time, s: title, src: '金十数据' };
        if (isRed) item.imp = true;
        if (tags.length > 0) item.tags = tags;
        if (bodyLines.length > 1) item.body = bodyLines.slice(1).join(' ');
        results.push(item);
      }
      return results;
    });

    if (items.length > 0) {
      // ★ 合并新旧数据，不覆盖
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).items || []; } catch(e) {}
      const seen = new Set(existing.map(i => i.s));
      for (const item of items) {
        if (!seen.has(item.s)) {
          item._ts = Date.now();
          existing.unshift(item);
          seen.add(item.s);
        }
      }
      const merged = { items: existing.slice(0, 500), updated: Date.now(), source: 'jin10' };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2));
      fs.writeFileSync(FALLBACK_FILE, JSON.stringify(merged, null, 2));
  try { const ins = db.prepare('INSERT OR IGNORE INTO news_archive (source, title, content, url, ts) VALUES (?, ?, ?, ?, ?)'); const tx = db.transaction((list) => { for (const i of list) { try { ins.run('jin10', i.s||'', i.body||'', '', Math.floor((i._ts||Date.now())/1000)); }catch(e){} } }); tx(items); } catch(e2) {}
      console.log(`[jin10] ✅ ${items.length} new, ${existing.length} total`);
    }

    const imp = items.filter(i => i.imp).length;
    console.log(`[jin10] ✅ ${items.length} items (${imp} 红色重要)`);
    return { items };

  } catch (err) {
    console.error(`[jin10] ✗ ${err.message}`);
    if (fs.existsSync(FALLBACK_FILE)) {
      try { return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); } catch(e2) {}
    }
    return { items: [] };
  } finally {
    if (browser) await browser.close();
  }
}

if (require.main === module) {
  console.log('[jin10] 持续爬虫启动 (间隔 5s)');
  async function loop() {
    await scrapeJin10();
    setTimeout(loop, 5000);
  }
  loop();
}

module.exports = { scrapeJin10 };
