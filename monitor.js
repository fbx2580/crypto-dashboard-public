// =====================================================================
// 新闻源监听器：持续监控 RSS 数据源，发现新文章即时推送
// 每 3 分钟拉一次，检测增量新闻
// =====================================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ALERTS_DIR = path.join(__dirname, 'public', 'data', 'alerts');
if (!fs.existsSync(ALERTS_DIR)) fs.mkdirSync(ALERTS_DIR, { recursive: true });

const ALERTS_FILE = path.join(ALERTS_DIR, 'news.json');
const SEEN_FILE = path.join(ALERTS_DIR, 'seen_titles.json');

// 加载已见过的标题（用于增量检测）
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
  } catch (e) {}
  return new Set();
}

function saveSeen(set) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
}

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { updated: Date.now(), alerts: [] };
}

function saveAlerts(alerts) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

// 拉 RSS 并检测新文章
async function scanNews() {
  try {
    // 调用现有的 rss-fetcher
    const { fetchNews } = require('./rss-fetcher.js');
    const result = await fetchNews();
    if (!result || !result.items || !result.items.length) return;

    const items = result.items;
    const seen = loadSeen();
    const existingAlerts = loadAlerts();
    const newAlerts = [];

    for (const item of items) {
      const title = item.s;
      // 从已见过的集合里判断是否为新文章
      if (!seen.has(title)) {
        seen.add(title);
        // 过去 30 分钟内的新文章才算有效推送
        const now = Date.now() / 1000;
        if (item.ts && (now - item.ts) < 7200) {  // 2小时内的才算"新"
          newAlerts.push({
            ts: item.ts,
            detected: Date.now(),
            src: item.src,
            title: item.s_cn || item.s,
            orig: item.s,
            link: item.link || '',
          });
        }
      }
    }

    // 保存已见过标题（只保留最近 500 条去重）
    saveSeen([...seen].slice(-500));

    // 如果有新文章，合并到推送队列
    if (newAlerts.length > 0) {
      const merged = [
        ...newAlerts.reverse(),  // 最早的在前
        ...existingAlerts.alerts,
      ].slice(0, 50);  // 保留最近 50 条

      saveAlerts({ updated: Date.now(), alerts: merged });

      console.log(`[news-monitor] 📰 ${newAlerts.length} new articles detected`);
      for (const a of newAlerts.slice(-3)) {
        console.log(`  [${a.src}] ${a.title.slice(0, 60)}`);
      }
    }

  } catch (err) {
    console.error(`[news-monitor] ✗ scan error: ${err.message}`);
  }
}

// 启动
console.log('[news-monitor] 🟢 RSS news monitor started (interval: 180s)');
scanNews();  // 立即跑一次
setInterval(scanNews, 180000);  // 每 3 分钟
