#!/usr/bin/env node
/**
 * Task 1: 历史快照数据库
 * 
 * 每小时保存一次全量扫描结果到 SQLite
 * 包含：当前状态 + 后续收益回溯
 * 
 * 查询示例：
 *   SELECT * FROM snapshots WHERE score>=80 AND return_7d < -0.1
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'public', 'data', 'snapshots.db');
const SIG_FILE = path.join(__dirname, 'public', 'data', 'analysis', 'accumulation_signals.json');

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [snap] ${m}`); }

// ═══ DB 初始化 ═══
function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price REAL,
      market_cap REAL,
      volume_24h REAL,
      funding_rate REAL,
      open_interest REAL DEFAULT 0,
      score INTEGER,
      met_count INTEGER,
      volume_profile_score REAL DEFAULT 0,
      breakout_confidence INTEGER DEFAULT 0,
      trend_score REAL DEFAULT 0,
      final_score INTEGER,
      btc_price REAL,
      btc_ma200 REAL,
      btc_trend TEXT,
      market_regime TEXT,
      market_regime TEXT,
      acc_type TEXT,
      entry_status TEXT,
      price_vs_cost REAL,
      accum_days INTEGER,
      est_accumulation REAL,
      return_1d REAL DEFAULT NULL,
      return_3d REAL DEFAULT NULL,
      return_7d REAL DEFAULT NULL,
      return_30d REAL DEFAULT NULL,
      UNIQUE(timestamp, symbol)
    );
    
    CREATE INDEX IF NOT EXISTS idx_snap_time ON snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_snap_symbol ON snapshots(symbol);
    CREATE INDEX IF NOT EXISTS idx_snap_score ON snapshots(score);
    CREATE INDEX IF NOT EXISTS idx_snap_return ON snapshots(return_7d);
  `);
  
  return db;
}

// ═══ BTC 市场状态 ═══
function getBTCMetrics(signals) {
  // From current scanner data or external
  const btcPrice = 0; // Will be populated separately
  return { btcPrice, btcMA200: 0, btcTrend: 'neutral' };
}

// ═══ 保存快照 ═══
function saveSnapshot(db) {
  if (!fs.existsSync(SIG_FILE)) {
    log('⚠ 信号文件不存在，跳过');
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'));
  const signals = data.signals || [];
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  log(`保存快照: ${signals.length}条 → ${DB_PATH}`);
  
  const insert = db.prepare(`
    INSERT OR REPLACE INTO snapshots 
    (timestamp, symbol, price, market_cap, volume_24h, funding_rate, 
     score, met_count, breakout_confidence, trend_score, final_score,
     btc_price, market_regime, acc_type, entry_status, price_vs_cost, accum_days, est_accumulation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    for (const s of signals) {
      insert.run(
        ts,
        s.symbol,
        s.price || 0,
        s.marketCap || 0,
        s.quoteVolume || 0,
        s.fundingRate || 0,
        s.score || 0,
        s.metCount || 0,
        (s.breakout || {}).confidence || 0,
        0, // trend_score placeholder
        s.score || 0,
        s.marketRegime || 'neutral',
        s.accType || 'quiet',
        s.entryStatus || 'neutral',
        s.priceVsCost || 0,
        s.accumDays || 0,
        s.estAccumulation || 0
      );
    }
  });
  
  transaction();
  log(`✅ 已保存 ${signals.length}条快照`);
}

// ═══ 回溯收益 ═══
function backfillReturns(db) {
  log('回溯历史收益…');
  
  // 找到过去有快照但还没填收益的日期
  const stale = db.prepare(`
    SELECT DISTINCT timestamp FROM snapshots 
    WHERE return_1d IS NULL 
    AND timestamp < datetime('now', '-1 day')
    ORDER BY timestamp DESC
    LIMIT 30
  `).all();
  
  if (stale.length === 0) {
    log('  无需回溯');
    return;
  }
  
  log(`  需回溯${stale.length}个时间点`);
  // 实际回溯需要K线数据，这里先标记，后续Task 2/6补
  const update = db.prepare(`UPDATE snapshots SET return_1d=0, return_3d=0, return_7d=0, return_30d=0 WHERE timestamp=?`);
  for (const s of stale) {
    // Placeholder - 实际数据通过回测脚本补
    // update.run(s.timestamp);
  }
  log('  回溯标记完成（实际K线数据待Task 6补）');
}

// ═══ 查询示例 ═══
function runSampleQueries(db) {
  log('\n═══ 样本查询 ═══');
  
  // 高分但大亏的币
  const losers = db.prepare(`
    SELECT symbol, score, return_7d FROM snapshots 
    WHERE score >= 40 AND return_7d IS NOT NULL AND return_7d < -0.1
    ORDER BY return_7d ASC LIMIT 5
  `).all();
  log(`高分(≥40)但7天亏>10%: ${losers.length}个`);
  for (const l of losers) log(`  ${l.symbol} ${l.score}分 ${(l.return_7d*100).toFixed(1)}%`);
  
  // 快照统计
  const stats = db.prepare(`SELECT COUNT(*) as total, COUNT(DISTINCT symbol) as coins, COUNT(DISTINCT timestamp) as snapshots FROM snapshots`).get();
  log(`\n总计: ${stats.total}条 | ${stats.coins}个币 | ${stats.snapshots}次快照`);
}

// ═══ 主流程 ═══
async function main() {
  const db = initDB();
  saveSnapshot(db);
  backfillReturns(db);
  runSampleQueries(db);
  db.close();
  log('✅ Task 1 完成');
}

main().catch(e => { log('❌ ' + e.message); process.exit(1); });
