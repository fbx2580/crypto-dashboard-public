#!/usr/bin/env node
/**
 * P0: 统一数据持久层 — 不可删除
 * 所有采集器的数据统一入口：写 SQLite + 写 JSON + 写归档
 * 
 * 用法：
 *   const store = require('./data-store');
 *   store.save('news', records);        // 追加
 *   store.overwrite('whale', records);  // 覆盖
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'public', 'data');

// ─── SQLite 写入器 ───
const inserters = {
  // 金十快讯
  jin10: db.prepare('INSERT OR IGNORE INTO news_archive (source, title, content, url, ts, news_time, imp) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  // RSS 新闻
  news: db.prepare('INSERT OR IGNORE INTO news_archive (source, title, content, url, ts, news_time, imp) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  // 鲸鱼转账
  whale: db.prepare('INSERT OR IGNORE INTO whale_transfers (chain, value, hash, ts, from_addr, to_addr, ex_from, ex_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  // 异动告警 (实际schema: type, message, data, ts)
  alerts: db.prepare('INSERT OR IGNORE INTO alerts (type, message, data, ts) VALUES (?, ?, ?, ?)'),
  // ETH 大户 (实际schema: address, chain, tags, balance, last_seen)
  eth: db.prepare('INSERT OR IGNORE INTO addresses (address, chain, tags, balance, last_seen) VALUES (?, ?, ?, ?, ?)'),
};

// ─── JSON 文件映射 ───
const jsonFiles = {
  jin10: 'news/jin10.json',
  news:  'news/latest.json',
  whale: 'whale/transfers.json',
  alerts:'alerts/price_alerts.json',
  eth:   'analysis/eth_whales.json',
};

/**
 * 追加模式：新数据追加到已有数据末尾
 * @param {string} type - jin10|news|whale|alerts|eth
 * @param {Array} records - 新记录
 * @param {string} idField - 去重字段
 * @param {boolean} sortNewest - 是否最新在前
 */
function save(type, records, idField, sortNewest) {
  if (!records || !records.length) return 0;

  let sqlCount = 0;
  const inserter = inserters[type];
  
  // ── 写 SQLite ──
  if (inserter) {
    for (const r of records) {
      try {
        if (type === 'jin10' || type === 'news') {
          const ts = r.ts || Math.floor(Date.now()/1000);
          const title = (r.s || r.title || '').slice(0, 200);
          const content = (r.body || r.desc || '').slice(0, 500);
          const url = (r.link || r.u || '').slice(0, 200);
          const src = (r.src || r.source || type).slice(0, 50);
          const newsTime = (r.t || r.news_time || '').slice(0, 10);
          const imp = r.imp ? 1 : 0;
          inserter.run(src, title, content, url, ts, newsTime, imp);
          sqlCount++;
        } else if (type === 'whale') {
          inserter.run(
            r.c || '', r.val || 0, r.hash || '',
            r.ts || Math.floor(Date.now()/1000),
            r.from || '', r.to || '',
            r.exFrom || '', r.exTo || ''
          );
          sqlCount++;
        } else if (type === 'alerts') {
          inserter.run(
            r.type || 'price_alert',
            (r.reason || r.s || r.message || '').slice(0, 200),
            JSON.stringify(r).slice(0, 500),
            Date.now()
          );
          sqlCount++;
        } else if (type === 'eth') {
          inserter.run(
            r.fullAddr || r.address || '',
            'ethereum',
            'whale',
            String(r.balance || ''),
            Date.now()
          );
          sqlCount++;
        }
      } catch(e) { /* 唯一约束冲突静默跳过 */ }
    }
  }

  // ── 写 JSON（追加）──
  const jf = path.join(DATA_DIR, jsonFiles[type]);
  if (jf) {
    try {
      let existing = [];
      const containerField = type === 'whale' ? 'transfers' : type === 'eth' ? 'whales' : 'items';
      try {
        const d = JSON.parse(fs.readFileSync(jf, 'utf8'));
        existing = d[containerField] || [];
      } catch(e) {}

      const seen = new Set(existing.map(r => r[idField] || r.hash || r.s || JSON.stringify(r).slice(0, 60)));
      let added = 0;
      for (const r of records) {
        const key = r[idField] || r.hash || r.s || JSON.stringify(r).slice(0, 60);
        if (!key || seen.has(key)) continue;
        existing.unshift(r);
        seen.add(key);
        added++;
      }

      if (added > 0) {
        const maxSize = type === 'eth' ? 10000 : 500;
        if (existing.length > maxSize) existing = existing.slice(0, maxSize);
        const payload = { [containerField]: existing, updated: Date.now() };
        const dir = path.dirname(jf);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(jf, JSON.stringify(payload, null, 2));
      }
    } catch(e) {}
  }

  // ── 归档（P2）──
  try { const { archive } = require('./archive-manager'); archive(type, records, idField); } catch(e) {}

  return sqlCount;
}

/**
 * 覆盖模式：完全替换
 */
function overwrite(type, records) {
  if (!records) return 0;

  // SQLite
  let sqlCount = 0;
  const inserter = inserters[type];
  if (inserter) {
    // 覆盖模式下先标记旧数据，再插新的（简化版：直接插）
    for (const r of records) {
      try {
        if (type === 'eth') {
          inserter.run(r.fullAddr || r.address || '', r.balance || '', r.balance || '', 'eth-monitor', Date.now());
          sqlCount++;
        }
      } catch(e) {}
    }
  }

  // JSON（覆盖）
  const jf = path.join(DATA_DIR, jsonFiles[type]);
  if (jf) {
    try {
      const containerField = type === 'eth' ? 'whales' : 'items';
      const payload = { [containerField]: records, updated: Date.now() };
      const dir = path.dirname(jf);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(jf, JSON.stringify(payload, null, 2));
    } catch(e) {}
  }

  return sqlCount;
}

/**
 * 获取数据库统计（含按来源细分 + 今日新增）
 */
function dbStats() {
  const stats = {};
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) as cnt FROM ${t.name}`).get();
      stats[t.name] = r.cnt;
    } catch(e) {}
  }
  // 北京时间的今天零点（UTC+8）
  const now = new Date();
  const bjMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), -8, 0, 0));
  const todayStart = Math.floor(bjMidnight.getTime() / 1000);

  // 按来源细分 news_archive
  try {
    const srcs = db.prepare('SELECT source, COUNT(*) as cnt FROM news_archive GROUP BY source').all();
    const jin10 = srcs.find(s => s.source === 'jin10');
    const rss = srcs.filter(s => s.source !== 'jin10' && s.source !== 'rss');
    const rssOld = srcs.find(s => s.source === 'rss');
    stats._jin10_db = jin10 ? jin10.cnt : 0;
    stats._rss_db = (rssOld ? rssOld.cnt : 0) + rss.reduce((s, x) => s + x.cnt, 0);
    // 今日新增（北京时间）
    stats._jin10_today = db.prepare('SELECT COUNT(*) as cnt FROM news_archive WHERE source=? AND ts >= ?').get('jin10', todayStart)?.cnt || 0;
    stats._rss_today = db.prepare('SELECT COUNT(*) as cnt FROM news_archive WHERE source != ? AND source != ? AND ts >= ?').get('jin10', 'rss', todayStart)?.cnt || 0;
  } catch(e) {}
  // 鲸鱼今日
  try { stats._whale_today = db.prepare('SELECT COUNT(*) as cnt FROM whale_transfers WHERE ts >= ?').get(todayStart)?.cnt || 0; } catch(e) {}
  // 异动今日
  try { stats._alerts_today = db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE ts >= ?').get(todayStart)?.cnt || 0; } catch(e) {}
  // ETH今日
  try { stats._eth_today = db.prepare('SELECT COUNT(*) as cnt FROM addresses WHERE last_seen >= ?').get(todayStart)?.cnt || 0; } catch(e) {}

  return stats;
}

module.exports = { save, overwrite, dbStats };
