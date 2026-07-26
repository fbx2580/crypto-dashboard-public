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
        // 过滤金十自身推广内容
        if (['金十数据·电脑版','金十数据APP','TradingHero','金十开放平台','金十数据VIP','金十数据PLUS','金十数据Pro','金十数据·'].some(k => title.includes(k))) continue;
        if (title.startsWith('金十数据') && title.length < 15) continue;
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
  console.log('[jin10] P0: 间隔1s, 复用浏览器 — 不可修改');
  let browser, page, tick = 0;
  async function init() {
    try { if (browser) await browser.close(); } catch(e) {}
    browser = null; page = null;
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    console.log('[jin10] 浏览器已启动');
  }
  async function loop() {
    tick++;
    try {
      if (!page || tick % 100 === 0) await init(); // 每100轮重建避免泄漏
      await scrapeJin10WithPage(page);
    } catch(e) {
      console.error('[jin10] 崩溃,3秒后重建:', e.message?.slice(0,40));
      browser = null; page = null;
      await new Promise(r => setTimeout(r, 3000));
    }
    setTimeout(loop, 1000);
  }
  loop();
}

// P0: 复用浏览器版本的爬取（1秒间隔）
async function scrapeJin10WithPage(page) {
  try {
    await page.goto('https://www.jin10.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);

    const items = await page.evaluate(() => {
      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
      const results = [];
      for (let i = 0; i < lines.length - 1; i++) {
        const m = lines[i].match(/^(\d{2}:\d{2}):\d{2}$/);
        if (!m) continue;
        const time = m[1];
        let bodyLines = [];
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const line = lines[j];
          if (/^\d{2}:\d{2}:\d{2}$/.test(line)) break;
          if (/^[火热沸爆]/.test(line)) continue;
          if (line.length < 5 || /^\d+(\.\d+)?%?$/.test(line)) continue;
          if (['重要事件','查看更多','市场快讯','VIP快讯','分类','PLUS'].some(s => line.includes(s))) continue;
          bodyLines.push(line);
        }
        if (bodyLines.length === 0) continue;
        const title = bodyLines[0];
        if (results.some(r => r.s === title)) continue;
        let isRed = false;
        const allEls = document.querySelectorAll('b, strong, span, div');
        for (const el of allEls) {
          if (el.children.length > 0) continue;
          const txt = (el.textContent || '').trim();
          if (txt.length > 5 && title.startsWith(txt.slice(0, 20))) {
            const color = getComputedStyle(el).color;
            if (color === 'rgb(225, 68, 84)') { isRed = true; break; }
          }
        }
        const item = { t: time, s: title, src: '金十数据' };
        if (['TradingHero','金十数据·','金十数据APP','金十开放平台','VIP年会员','高定礼盒'].some(k => title.includes(k))) continue;
        if (title.startsWith('金十数据') && title.length < 15) continue;
        if (isRed) item.imp = true;
        if (bodyLines.length > 1) item.body = bodyLines.slice(1).join(' ');
        results.push(item);
      }
      return results;
    });

    if (items.length > 0) {
      const fs = require('fs');const path = require('path');
      const DATA_DIR = path.join(__dirname, 'public', 'data', 'news');
      const CACHE_FILE = path.join(DATA_DIR, 'jin10.json');
      const FALLBACK_FILE = path.join(DATA_DIR, 'jin10_fallback.json');
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).items || []; } catch(e) {}
      const seen = new Set(existing.map(i => i.s));
      for (const item of items) {
        if (!seen.has(item.s)) {
          existing.unshift(item);
          seen.add(item.s);
        }
      }
      // P0: 保持时间排序
      existing.sort((a,b)=>{const ta=a.t||'',tb=b.t||'';return(parseInt(tb)*60+parseInt(tb.split(':')[1]||0))-(parseInt(ta)*60+parseInt(ta.split(':')[1]||0))});
      const merged = { items: existing.slice(0, 500), updated: Date.now(), source: 'jin10' };
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2));
      fs.writeFileSync(FALLBACK_FILE, JSON.stringify(merged, null, 2));
      const imp = items.filter(i => i.imp).length;
      console.log(`[jin10] ✅ ${items.length} new (${imp} 🔴) | total ${existing.length}`);
    }
  } catch(e) {
    console.error(`[jin10] ✗ ${e.message}`);
  }
}

module.exports = { scrapeJin10 };
