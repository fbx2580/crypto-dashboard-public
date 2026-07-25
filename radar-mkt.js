#!/usr/bin/env node
/** Task 20: 雷达市场快照 — 每日保存全市场吸筹状态 */
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');

const DB = path.join(__dirname, 'public', 'data', 'snapshots.db');
const RADAR = path.join(__dirname, 'public', 'data', 'analysis', 'accumulation_radar.json');
function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [mkt] ${m}`); }

// ═══ DB ═══
function initDB() {
  const db = new Database(DB);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS radar_market_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    timestamp TEXT NOT NULL,
    market_regime TEXT,
    btc_price REAL,
    radar_total INTEGER,
    high_count INTEGER,
    candidate_count INTEGER,
    watch_count INTEGER,
    average_score REAL,
    max_score INTEGER,
    score_90plus INTEGER,
    score_80_89 INTEGER,
    score_70_79 INTEGER,
    score_below60 INTEGER
  )`);
  return db;
}

// ═══ 保存 ═══
function save(db) {
  if (!fs.existsSync(RADAR)) { L('⚠ 雷达文件不存在'); return; }
  const d = JSON.parse(fs.readFileSync(RADAR, 'utf8'));
  const results = d.results || [];
  const today = new Date().toISOString().slice(0,10);
  const tiers = d.tiers || {};

  const scores = results.map(r => r.total);
  const avg = scores.length > 0 ? scores.reduce((s,v) => s+v, 0) / scores.length : 0;
  const max = scores.length > 0 ? Math.max(...scores) : 0;

  const dist = { '90+': 0, '80-89': 0, '70-79': 0, '<60': 0 };
  for (const s of scores) {
    if (s >= 90) dist['90+']++;
    else if (s >= 80) dist['80-89']++;
    else if (s >= 70) dist['70-79']++;
    else dist['<60']++;
  }

  const regime = results[0]?.marketRegime || 'neutral';
  const btc = results[0]?.btcMetrics?.price || 0;

  db.prepare(`INSERT OR REPLACE INTO radar_market_history 
    (date, timestamp, market_regime, btc_price, radar_total, high_count, candidate_count, watch_count, average_score, max_score, score_90plus, score_80_89, score_70_79, score_below60)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    today, new Date().toISOString(), regime, btc, results.length,
    tiers.high||0, tiers.candidate||0, tiers.watch||0,
    Math.round(avg), max, dist['90+'], dist['80-89'], dist['70-79'], dist['<60']
  );

  L(`✅ ${today}: ${results.length}币 avg${Math.round(avg)} max${max} 🔥${tiers.high} ⭐${tiers.candidate} 👀${tiers.watch} [${regime}]`);
}

// ═══ 趋势 ═══
function showTrend(db) {
  const rows = db.prepare(`SELECT * FROM radar_market_history ORDER BY date DESC LIMIT 14`).all();
  if (rows.length < 2) { L('  (数据不足，无趋势)'); return; }
  const recent = rows.slice(0, 7);
  const prev = rows.slice(7, 14);
  const rAvg = recent.reduce((s,r)=>s+r.radar_total,0)/recent.length;
  const pAvg = prev.length>0?prev.reduce((s,r)=>s+r.radar_total,0)/prev.length:rAvg;
  const dir = rAvg > pAvg*1.1 ? '📈 机会增加' : rAvg < pAvg*0.9 ? '📉 机会减少' : '→ 持平';
  L(`趋势(7d vs 7d前): ${dir} (均${Math.round(rAvg)} vs ${Math.round(pAvg)}个)`);
}

// ═══ 主 ═══
function main() {
  const db = initDB();
  save(db);
  showTrend(db);
  db.close();
}
try { main(); } catch(e) { L('❌ '+e.message); process.exit(1); }
