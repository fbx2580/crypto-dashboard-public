// =====================================================================
// 消息面：可靠 RSS 数据源 · 专注加密/宏观
// 数据来源真实可查，无任何硬编码伪造内容
// =====================================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Parser } = require('xml2js');

const DATA_DIR = path.join(__dirname, 'public', 'data', 'news');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 兜底缓存文件 —— 所有源都挂了时用最后成功的数据
const db = require('./db');
const FALLBACK_FILE = path.join(DATA_DIR, 'fallback.json');

// 可信数据源 — 只包含真实可访问的 RSS feed
const SOURCES = [
  // 加密垂直媒体
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',           name: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss',                             name: 'CoinTelegraph' },
  { url: 'https://decrypt.co/feed',                                   name: 'Decrypt' },
  { url: 'https://u.today/rss',                                       name: 'U.Today' },
  // 宏观经济（影响币市）
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',            name: 'BBC Business' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147', name: 'CNBC' },
];

async function fetchWithRetry(url, opts, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, opts);
    } catch (e) {
      if (i < retries - 1) {
        console.log(`[rss] retry ${i+1} ${url.split('/')[2]}...`);
        await new Promise(r => setTimeout(r, 1000));
      } else throw e;
    }
  }
}

async function fetchNews() {
  const parser = new Parser({ explicitArray: false });
  let items = [];
  let successCount = 0;

  for (const src of SOURCES) {
    try {
      const res = await fetchWithRetry(src.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000,
      });
      successCount++;
      const result = await parser.parseStringPromise(res.data);
      const rawItems = result.rss?.channel?.item;
      const list = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
      if (!list.length) continue;

      for (const item of list.slice(0, 10)) {
        // 标题 —— 原始字段，不加工不改写
        const title = (item.title && typeof item.title === 'object' ? item.title._ : item.title || '').trim();
        if (!title || title.length < 5) continue;

        // 时间 —— 只取 RSS pubDate，无 pubDate 直接丢弃，绝不 fallback
        let pubDate = null;
        if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!isNaN(d.getTime())) pubDate = d;
        }
        if (!pubDate) continue;

        // 原文链接
        const link = item.link && typeof item.link === 'object' ? item.link._ || '' : (item.link || '');

        const ts = Math.floor(pubDate.getTime() / 1000);

        // 去重：相同标题只保留最早出现的
        if (items.some(ex => ex.s === title)) continue;

        items.push({
          s: title,          // 标题（原始英文）
          t: pubDate.toISOString(),  // ISO 时间
          ts: ts,            // unix 时间戳（用于排序）
          src: src.name,     // 来源
          link: link,        // 原文链接
        });
      }
    } catch (e) {
      console.error(`[rss] ${src.name}: ${e.message}`);
    }
  }

  // 按时间排序，最新的排最前
  items.sort((a, b) => b.ts - a.ts);
  // 保留最近 100 条
  items = items.slice(0, 100);

  // —— 翻译：英文→中文 ——
  // 并发控制，最多同时 5 个请求
  const toCn = async (text) => {
    if (!text || text.length < 3) return text;
    try {
      const res = await axios.get(
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(text.slice(0, 500)),
        { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = res.data;
      if (Array.isArray(data) && data[0] && Array.isArray(data[0]) && data[0][0] && Array.isArray(data[0][0]) && data[0][0][0]) {
        const translated = data[0][0][0].trim();
        if (translated && translated !== text) return translated;
      }
    } catch (e) { /* 翻译失败，保持原文 */ }
    return text;
  };

  const BATCH = 5;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(item => toCn(item.s)));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value && r.value !== batch[j].s) {
        batch[j].s_cn = r.value;  // 存中文翻译
      }
    });
  }
  const cnCount = items.filter(i => i.s_cn).length;
  console.log(`[rss] 🌐 ${cnCount}/${items.length} translated to Chinese`);

  const finalCount = SOURCES.length - (SOURCES.length - successCount);

  // ★ 合并新旧数据，不覆盖
  let existingItems = [];
  try { existingItems = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'latest.json'), 'utf8')).items || []; } catch(e) {}
  const seen = new Set(existingItems.map(i => i.s));
  for (const item of items) {
    if (!seen.has(item.s)) {
      item._ts = Date.now();
      existingItems.unshift(item);
      seen.add(item.s);
    }
  }
  const merged = { items: existingItems.slice(0, 500), updated: Date.now(), sources: successCount };
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(FALLBACK_FILE, JSON.stringify(merged, null, 2));
  // P0: 写SQLite
  try { require('./data-store').save('news', items, 's'); } catch(e) {}
  // P2: 按日归档 — 用本次新抓的 items
  try { const { archive } = require('./archive-manager'); archive('news', items, 's'); } catch(e) {}
  try { const ins = db.prepare('INSERT OR IGNORE INTO news_archive (source, title, content, url, ts) VALUES (?, ?, ?, ?, ?)'); const tx = db.transaction((list) => { for (const i of list) { try { ins.run('rss', i.s||'', i.c||i.desc||'', i.u||i.link||'', Math.floor(i.t||Date.now()/1000)); }catch(e){} } }); tx(items); } catch(e2) {}

  console.log(`[rss] ✅ ${items.length} articles from ${finalCount}/${SOURCES.length} sources`);
  return merged;
}

// 加载兜底缓存
function loadFallback() {
  try {
    if (fs.existsSync(FALLBACK_FILE)) {
      const data = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
      data.fromFallback = true;
      return data;
    }
  } catch(e) {}
  return null;
}

// 独立运行
if (require.main === module) {
  fetchNews().then(r => console.log('Done:', r?.items?.length, 'articles'));
}

module.exports = { fetchNews, loadFallback };
