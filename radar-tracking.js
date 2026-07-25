#!/usr/bin/env node
/**
 * Task 10: 雷达信号历史追踪
 * 
 * 每日保存雷达分数 + 自动统计7/30/60天表现
 * 不修改评分，只观察真实表现
 */

const axios = require('axios'); const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const BINANCE = 'https://api.binance.com/api/v3';
const DIR = path.join(__dirname, 'public', 'data', 'analysis');
const DB_PATH = path.join(__dirname, 'public', 'data', 'radar_tracking.db');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [track] ${m}`); }
async function gj(u,p={}){ return (await axios.get(u,{params:p,timeout:15000})).data; }

// ═══ DB ═══
function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      radar_score INTEGER,
      tier TEXT,
      drawdown_pct REAL,
      accum_days INTEGER,
      atr_contraction REAL,
      price_vs_ma60 REAL,
      market_cap REAL,
      risk_deduct INTEGER,
      btc_regime TEXT,
      entry_price REAL,
      return_7d REAL DEFAULT NULL,
      return_30d REAL DEFAULT NULL,
      return_60d REAL DEFAULT NULL,
      UNIQUE(date, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_rh_date ON radar_history(date);
    CREATE INDEX IF NOT EXISTS idx_rh_score ON radar_history(radar_score);
  `);
  return db;
}

// ═══ 保存当日记分 ═══
function saveToday(db) {
  const radarFile = path.join(DIR, 'accumulation_radar.json');
  if (!fs.existsSync(radarFile)) { L('⚠ 雷达数据不存在'); return; }
  const data = JSON.parse(fs.readFileSync(radarFile, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO radar_history 
    (date, symbol, radar_score, tier, drawdown_pct, accum_days, atr_contraction, price_vs_ma60, market_cap, risk_deduct, btc_regime, entry_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (const r of (data.results || [])) {
      const b = r.breakdown || {};
      insert.run(
        today, r.symbol, r.total, r.tier,
        b.drawdown?.value || 0, b.time?.value || 0,
        b.volatility?.value || 0, b.structure?.value || 0,
        b.liquidity?.value || 0, r.riskDeduct || 0,
        r.marketRegime || 'neutral', r.price || 0
      );
    }
  });
  txn();
  L(`✅ 保存 ${data.results.length}条七级雷达 → ${today}`);
}

// ═══ 回溯历史表现 ═══
async function backfillReturns(db) {
  L('回溯历史表现…');

  // 找到7天前有记录但还没算收益的日期
  const stale = db.prepare(`
    SELECT DISTINCT date FROM radar_history 
    WHERE return_7d IS NULL AND date <= date('now', '-7 days')
    ORDER BY date DESC LIMIT 5
  `).all();

  if (stale.length === 0) { L('  无需回溯'); return; }

  for (const { date } of stale) {
    const entries = db.prepare('SELECT * FROM radar_history WHERE date = ?').all(date);
    if (entries.length === 0) continue;

    L(`  回溯 ${date}: ${entries.length}条`);

    const startMs = new Date(date).getTime();
    const update = db.prepare('UPDATE radar_history SET return_7d=?, return_30d=?, return_60d=? WHERE date=? AND symbol=?');

    let done = 0;
    for (const e of entries) {
      const sym = e.symbol + 'USDT';
      try {
        // 拉从那天到现在的K线
        const klines = await gj(`${BINANCE}/klines`, { symbol: sym, interval: '1d', startTime: startMs, limit: 90 });
        if (klines.length < 5) continue;

        const entryPrice = e.entry_price || parseFloat(klines[0][4]);
        const r7d = klines.length > 7 ? (parseFloat(klines[Math.min(7, klines.length-1)][4]) - entryPrice) / entryPrice : null;
        const r30d = klines.length > 30 ? (parseFloat(klines[Math.min(30, klines.length-1)][4]) - entryPrice) / entryPrice : null;
        const r60d = klines.length > 60 ? (parseFloat(klines[Math.min(60, klines.length-1)][4]) - entryPrice) / entryPrice : null;

        if (r7d !== null) update.run(r7d, r30d, r60d, date, e.symbol);
      } catch(e) {}
      done++;
      if (done % 3 === 0) await new Promise(r => setTimeout(r, 10));
    }
    L(`    完成 ${done}条回溯`);
  }
}

// ═══ 性能报告 ═══
function generateReport(db) {
  L('生成性能报告…');

  const report = ['# 雷达信号历史追踪报告\n'];
  report.push(`> 生成时间: ${new Date().toISOString().slice(0, 16)}\n\n`);

  // 1. 按等级统计
  report.push('## 1. 按等级胜率\n\n');
  const tiers = [
    ['🔥 高关注(≥90)', 'radar_score >= 90'],
    ['⭐ 候选(70-89)', 'radar_score >= 70 AND radar_score < 90'],
    ['👀 观察(40-69)', 'radar_score >= 40 AND radar_score < 70'],
  ];

  report.push('| 等级 | 样本 | 7d胜率 | 30d胜率 | 60d胜率 | 7d均收益 | 30d均收益 |');
  report.push('|------|------|--------|---------|---------|----------|----------|');

  for (const [label, cond] of tiers) {
    const rows = db.prepare(`SELECT return_7d, return_30d, return_60d FROM radar_history WHERE ${cond} AND return_7d IS NOT NULL`).all();
    if (rows.length === 0) { report.push(`| ${label} | 0 | — | — | — | — | — |`); continue; }
    const r7 = rows.map(r => r.return_7d), r30 = rows.map(r => r.return_30d), r60 = rows.map(r => r.return_60d).filter(v => v !== null);
    const w7 = r7.filter(v => v > 0).length / r7.length;
    const w30 = r30.filter(v => v !== null && v > 0).length / r30.filter(v => v !== null).length || 0;
    const w60 = r60.length > 0 ? r60.filter(v => v > 0).length / r60.length : 0;
    const a7 = r7.reduce((s,v) => s+v, 0) / r7.length;
    const a30 = r30.filter(v => v !== null).reduce((s,v) => s+v, 0) / r30.filter(v => v !== null).length || 0;
    report.push(`| ${label} | ${rows.length} | ${(w7*100).toFixed(0)}% | ${(w30*100).toFixed(0)}% | ${(w60*100).toFixed(0)}% | ${(a7*100).toFixed(1)}% | ${(a30*100).toFixed(1)}% |`);
  }

  // 2. 按市场环境
  report.push('\n## 2. 按市场环境\n\n');
  const regimes = db.prepare('SELECT DISTINCT btc_regime FROM radar_history WHERE return_7d IS NOT NULL').all();
  report.push('| 环境 | 样本 | 7d胜率 | 30d胜率 |');
  report.push('|------|------|--------|---------|');
  for (const { btc_regime } of regimes) {
    const rows = db.prepare('SELECT return_7d, return_30d FROM radar_history WHERE btc_regime=? AND return_7d IS NOT NULL').all(btc_regime);
    if (rows.length === 0) continue;
    const w7 = rows.filter(r => r.return_7d > 0).length / rows.length;
    const r30f = rows.filter(r => r.return_30d !== null);
    const w30 = r30f.length > 0 ? r30f.filter(r => r.return_30d > 0).length / r30f.length : 0;
    report.push(`| ${btc_regime} | ${rows.length} | ${(w7*100).toFixed(0)}% | ${(w30*100).toFixed(0)}% |`);
  }

  // 3. 结论
  report.push('\n## 3. 结论\n');
  report.push('- 雷达级别越高，胜率越应呈递增趋势。若出现反转则需检查过拟合。\n');
  report.push('- 不同市场环境下雷达表现应有显著差异。\n');
  report.push('- 此报告基于真实历史数据，不修改评分模型。\n');

  return report.join('\n');
}

// ═══ 主流程 ═══
async function main() {
  L('🔭 雷达历史追踪');
  const db = initDB();
  saveToday(db);
  await backfillReturns(db);
  const report = generateReport(db);
  fs.writeFileSync(path.join(DIR, 'radar_performance_report.md'), report);
  db.close();
  L('✅ 报告已保存');
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
