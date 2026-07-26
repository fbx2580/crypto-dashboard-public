#!/usr/bin/env node
/**
 * Lifecycle Radar — 合并策略 V1
 * 思路：V2 的环境过滤 + V5 的入场+退出 + 数据层的 BTC 状态
 */
const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, 'public', 'data', 'klines_cache');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [strat] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ 市场环境判断（复用数据层产出） ═══
function getMarketRegime() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data', 'market_data', 'latest.json'), 'utf8'));
    const btc = d.btc || {};
    // BTC 状态
    if (btc.price > btc.ma200 && btc.ret30d > 3) return 'bull';
    if (btc.price < btc.ma200 && btc.ret30d < -3) return 'bear';
    return 'sideways';
  } catch(e) { return 'sideways'; }
}

// ═══ V5 入场：60日新高 + 回踩不破 + 量健康 ═══
function checkEntry(klines) {
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const n = klines.length;
  const price = closes[n - 1];
  if (n < 200) return null;

  // 1. 接近60日新高
  const high60 = Math.max(...highs.slice(-60, -1));
  if (price < high60 * 0.95) return null;

  // 2. 回踩不破：近10天最低 ≥ 20天前高点的90%
  const high20 = Math.max(...highs.slice(-21, -10));
  const low10 = Math.min(...lows.slice(-10));
  if (low10 < high20 * 0.88) return null;

  // 3. 成交量健康：近10天均量 ≥ 30天均量的60%
  const vol10 = avg(vols.slice(-10));
  const vol30 = avg(vols.slice(-30));
  if (vol10 < vol30 * 0.6) return null;

  return { price, high60, low10, vol10 };
}

// ═══ V5 退出：止损-15% + 移动止盈 ═══
function simulateExit(klines, entryIdx, entryPrice) {
  const future = klines.slice(entryIdx + 1);
  let peak = entryPrice;
  for (let d = 0; d < Math.min(30, future.length); d++) {
    const high = future[d].high;
    const low = future[d].low;
    const close = future[d].close;
    if (high > peak) peak = high;
    // 止损
    if (low <= entryPrice * 0.85) return { pnl: -0.15, reason: '止损-15%', days: d + 1 };
    // 移动止盈
    if (peak > entryPrice * 1.10 && close <= peak * 0.90) return { pnl: (close - entryPrice) / entryPrice, reason: '移动止盈', days: d + 1 };
  }
  const lastClose = future[Math.min(29, future.length - 1)].close;
  return { pnl: (lastClose - entryPrice) / entryPrice, reason: '30日到期', days: 30 };
}

// ═══ 主流程 ═══
async function main() {
  L('合并策略回测 — V2环境过滤 + V5入场退出');
  const regime = getMarketRegime();
  L(`当前市场: ${regime}`);

  // 环境过滤：bear 市场不交易
  const bearFilter = regime === 'bear';
  
  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const trades = [];

  for (const file of cacheFiles) {
    const sym = file.replace('.json', '');
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
      const klines = cached.klines || [];
      if (klines.length < 250) continue;

      // 每 7 天扫描一次
      for (let i = 200; i < klines.length - 35; i += 7) {
        const pastKlines = klines.slice(0, i + 1);
        const entry = checkEntry(pastKlines);
        if (!entry) continue;

        // 环境过滤：仅用 BTC 时间近似
        const predDate = new Date(klines[i].time);
        const y = predDate.getFullYear(), m = predDate.getMonth();
        let btcRegime = 'sideways';
        if ((y === 2025 && m >= 9) || (y === 2026 && m <= 3)) btcRegime = 'bull';
        else if (y === 2025 && m >= 4 && m <= 8) btcRegime = 'bear';
        
        if (bearFilter && btcRegime === 'bear') continue;

        const exit = simulateExit(klines, i, entry.price);
        trades.push({
          symbol: sym,
          date: predDate.toISOString().slice(0, 10),
          entry: entry.price,
          pnl: exit.pnl,
          pnlPct: (exit.pnl * 100).toFixed(1) + '%',
          exitReason: exit.reason,
          exitDay: exit.days,
          btcRegime,
        });
      }
    } catch(e) {}
  }

  L(`信号: ${trades.length} 条`);

  // ═══ 统计 ═══
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const pnls = trades.map(t => t.pnl * 100);
  const totalWin = wins.reduce((s,t) => s + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  const sorted = [...pnls].sort((a,b) => b-a);

  // 组合回测
  let equity = 10000, peak = 10000, maxDD = 0, maxCL = 0, cl = 0;
  const positions = [];
  for (const t of trades.sort((a,b) => a.date.localeCompare(b.date))) {
    const tDate = new Date(t.date);
    for (let j = positions.length - 1; j >= 0; j--) {
      if ((tDate - new Date(positions[j].date)) / 86400000 > 30) {
        equity += positions[j].pnl * (equity * 0.10);
        if (positions[j].pnl > 0) cl = 0; else { cl++; maxCL = Math.max(maxCL, cl); }
        positions.splice(j, 1);
      }
    }
    if (positions.length >= 5) continue;
    positions.push({ date: t.date, pnl: t.pnl });
    const open = positions.reduce((s,p) => s + p.pnl * (equity * 0.10), 0);
    if (equity + open > peak) peak = equity + open;
    else { const dd = (peak - (equity + open)) / peak; if (dd > maxDD) maxDD = dd; }
  }
  positions.forEach(p => { equity += p.pnl * (equity * 0.10); if (p.pnl > 0) cl = 0; else { cl++; maxCL = Math.max(maxCL, cl); } });

  // ═══ 打印 ═══
  console.log('\n' + '═'.repeat(60));
  console.log('合并策略回测结果');
  console.log('═'.repeat(60));
  console.log(`\n信号: ${trades.length} | 胜率: ${(wins.length/trades.length*100).toFixed(0)}%`);
  console.log(`均收益: ${avg(pnls).toFixed(1)}% | 中位: ${median(pnls).toFixed(1)}%`);
  console.log(`PF: ${totalLoss > 0 ? (totalWin/totalLoss).toFixed(2) : 'N/A'}`);
  console.log(`无Top10: ${avg(sorted.slice(10)).toFixed(1)}%`);
  console.log(`\n退出分解:`);
  const byReason = {};
  trades.forEach(t => { if (!byReason[t.exitReason]) byReason[t.exitReason] = []; byReason[t.exitReason].push(t.pnl * 100); });
  for (const [r, ps] of Object.entries(byReason)) {
    console.log(`  ${r}: ${ps.length}笔 胜率${(ps.filter(p=>p>0).length/ps.length*100).toFixed(0)}% 均${avg(ps).toFixed(1)}%`);
  }
  console.log(`\n组合: $10K → $${equity.toFixed(0)} (${((equity/10000-1)*100).toFixed(1)}%) | DD: ${(maxDD*100).toFixed(1)}% | 连败: ${maxCL}`);

  // 按环境
  const byRegime = {};
  trades.forEach(t => { if (!byRegime[t.btcRegime]) byRegime[t.btcRegime] = []; byRegime[t.btcRegime].push(t.pnl * 100); });
  console.log('\n按BTC环境:');
  for (const [r, ps] of Object.entries(byRegime)) {
    console.log(`  ${r}: ${ps.length}笔 胜率${(ps.filter(p=>p>0).length/ps.length*100).toFixed(0)}% 中位${median(ps).toFixed(1)}%`);
  }

  L('✅ 完成');
}

main().catch(e => { L('FAIL: ' + e.message); process.exit(1); });
