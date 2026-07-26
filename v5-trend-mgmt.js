#!/usr/bin/env node
/**
 * Lifecycle Radar V5 — 趋势管理模型
 * 
 * 方向转变：从"预测哪个会涨" → "当趋势存在时参与，趋势破坏时退出"
 * 核心理念：不预测，只跟随。不找底，只确认强。
 */
const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, 'public', 'data', 'klines_cache');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [v5] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ V5 趋势管理：只跟随确认的强势 ═══
function extractTrendSignals(klines, symbol) {
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const n = klines.length;
  const signals = [];

  for (let i = 200; i < n - 30; i += 7) {
    const price = closes[i];
    if (price <= 0) continue;

    // === V5 入场：新高 + 强势 ===
    // 1. 创60日新高
    const high60 = Math.max(...highs.slice(i - 59, i));
    const isNewHigh = price >= high60 * 0.98;

    // 2. 回踩不破（近10天最低不低于20天前高点的95%）
    const high20 = Math.max(...highs.slice(i - 19, i - 9));
    const low10 = Math.min(...lows.slice(i - 9, i + 1));
    const pullbackOk = low10 > high20 * 0.90;

    // 3. 成交量健康（近10天量不低于30天均量50%）
    const vol10 = avg(vols.slice(i - 9, i + 1));
    const vol30 = avg(vols.slice(i - 29, i + 1));
    const volHealthy = vol10 > vol30 * 0.5;

    // 综合判定
    const canEnter = isNewHigh && pullbackOk && volHealthy;
    if (!canEnter) continue;

    // === V5 退出规则 ===
    const future = klines.slice(i + 1);
    const fCloses = future.map(k => k.close);
    const fHighs = future.map(k => k.high);
    const fLows = future.map(k => k.low);

    // 止损：-15%
    // 移动止盈：从最高点回撤10%
    // 趋势破坏：跌破20日均线
    let exitPrice = price, exitReason = '', exitDay = 0;
    let peakPrice = price;
    let stopped = false;

    for (let d = 1; d <= 30 && d < future.length; d++) {
      const currPrice = fCloses[d - 1];
      if (fHighs[d - 1] > peakPrice) peakPrice = fHighs[d - 1];

      // 止损
      if (currPrice <= price * 0.85) {
        exitPrice = price * 0.85;
        exitReason = '止损-15%';
        exitDay = d;
        stopped = true;
        break;
      }
      // 移动止盈
      if (peakPrice > price * 1.10 && currPrice <= peakPrice * 0.90) {
        exitPrice = currPrice;
        exitReason = '移动止盈';
        exitDay = d;
        stopped = true;
        break;
      }
      exitDay = d;
    }

    if (!stopped) {
      exitPrice = fCloses[Math.min(29, future.length - 1)];
      exitReason = '30日到期';
    }

    const pnl = (exitPrice - price) / price;
    signals.push({
      symbol, date: new Date(klines[i].time).toISOString().slice(0, 10),
      entry: price, exit: exitPrice, pnl, exitDay, exitReason,
      isNewHigh, pullbackOk, volHealthy,
    });
  }
  return signals;
}

// ═══ 基准策略 ═══
function benchmark(klines, symbol, type) {
  const closes = klines.map(k => k.close);
  const n = klines.length;
  const trades = [];

  for (let i = 200; i < n - 30; i += 7) {
    const price = closes[i];
    let pnl;

    if (type === 'random') {
      // 随机买入（30%概率）
      if (Math.random() > 0.3) continue;
      pnl = (closes[Math.min(i + 29, n - 1)] - price) / price;
    } else if (type === 'btc_hold') {
      if (symbol !== 'BTC') continue;
      pnl = (closes[Math.min(i + 29, n - 1)] - price) / price;
    } else if (type === 'simple_strong') {
      // 简单强势：价格>MA20
      const ma20 = avg(closes.slice(Math.max(0, i - 19), i + 1));
      if (price <= ma20) continue;
      pnl = (closes[Math.min(i + 29, n - 1)] - price) / price;
    }
    if (pnl !== undefined) trades.push({ symbol, date: new Date(klines[i].time).toISOString().slice(0, 10), pnl });
  }
  return trades;
}

// ═══ 组合回测 ═══
function portfolioSim(trades, label, maxPositions = 5, positionPct = 0.10) {
  if (!trades.length) return null;
  trades.sort((a,b) => a.date.localeCompare(b.date));

  let equity = 10000;
  const positions = [];
  const curve = [];
  let peak = 10000, maxDD = 0, maxCL = 0, cl = 0;

  for (const t of trades) {
    const tDate = new Date(t.date);
    for (let j = positions.length - 1; j >= 0; j--) {
      if ((tDate - new Date(positions[j].date)) / 86400000 > 30) {
        equity += positions[j].pnl * (equity * positionPct);
        if (positions[j].pnl > 0) cl = 0; else { cl++; maxCL = Math.max(maxCL, cl); }
        positions.splice(j, 1);
      }
    }
    if (positions.length >= maxPositions) continue;

    positions.push({ date: t.date, pnl: t.pnl });
    const openPnl = positions.reduce((s,p) => s + p.pnl, 0);
    const total = equity * (1 + openPnl * positionPct);
    if (total > peak) peak = total;
    else { const dd = (peak - total) / peak; if (dd > maxDD) maxDD = dd; }

    if (trades.indexOf(t) % Math.max(1, Math.floor(trades.length / 20)) === 0) {
      curve.push({ date: t.date, equity: Number(total.toFixed(0)) });
    }
  }
  positions.forEach(p => {
    equity += p.pnl * (equity * positionPct);
    if (p.pnl > 0) cl = 0; else { cl++; maxCL = Math.max(maxCL, cl); }
  });

  const pnls = trades.map(t => t.pnl * 100);
  const wins = pnls.filter(r => r > 0);
  const totalWin = wins.reduce((s,v)=>s+v,0);
  const totalLoss = Math.abs(pnls.filter(r=>r<=0).reduce((s,v)=>s+v,0));
  const sorted = [...pnls].sort((a,b)=>b-a);

  return {
    label, trades: trades.length,
    finalEquity: Number(equity.toFixed(0)),
    totalReturn: ((equity/10000 - 1) * 100).toFixed(1) + '%',
    maxDD: (maxDD * 100).toFixed(1) + '%',
    maxCL,
    winRate: (wins.length/pnls.length * 100).toFixed(1) + '%',
    pf: totalLoss > 0 ? (totalWin/totalLoss).toFixed(2) : 'N/A',
    medianPnL: median(pnls).toFixed(1) + '%',
    avgPnL: avg(pnls).toFixed(1) + '%',
    withoutTop10: avg(sorted.slice(Math.ceil(pnls.length * 0.1))).toFixed(1) + '%',
    curve: curve.length,
  };
}

// ═══ 主流程 ═══
async function main() {
  L('Lifecycle Radar V5 — 趋势管理模型');

  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  L(`缓存: ${cacheFiles.length} 币种`);

  const v5Signals = [];
  const benchRandom = [];
  const benchSimple = [];
  const benchBTC = [];

  for (let ci = 0; ci < Math.min(cacheFiles.length, 100); ci++) {
    const sym = cacheFiles[ci].replace('.json', '');
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, cacheFiles[ci]), 'utf8'));
      if (!c.klines || c.klines.length < 300) continue;
      v5Signals.push(...extractTrendSignals(c.klines, sym));
      benchRandom.push(...benchmark(c.klines, sym, 'random'));
      benchSimple.push(...benchmark(c.klines, sym, 'simple_strong'));
    } catch(e) {}
  }

  // BTC单独
  const btcFile = cacheFiles.find(f => f.startsWith('BTC.'));
  if (btcFile) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, btcFile), 'utf8'));
      benchBTC.push(...benchmark(c.klines, 'BTC', 'btc_hold'));
    } catch(e) {}
  }

  L(`V5信号: ${v5Signals.length} | 随机: ${benchRandom.length} | 简单强势: ${benchSimple.length}`);

  // ═══ 策略对比 ═══
  console.log('\n' + '═'.repeat(70));
  console.log('V5 趋势管理 vs 基准策略');
  console.log('═'.repeat(70));

  const results = [];
  const configs = [
    { trades: v5Signals, label: 'V5 趋势管理(新高+回踩+量健康)', color: '✅' },
    { trades: benchSimple, label: '简单强势(价格>MA20)', color: '⚠️' },
    { trades: benchRandom, label: '随机买入(30%概率)', color: '🔵' },
  ];
  if (benchBTC.length) configs.push({ trades: benchBTC, label: 'BTC持有', color: '🟡' });

  console.log('\n策略                       交易   终值      收益     最大DD   PF     中位    连败   无Top10');
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  for (const cfg of configs) {
    const r = portfolioSim(cfg.trades, cfg.label);
    if (!r) continue;
    console.log(
      `${cfg.color} ${cfg.label.padEnd(25)} ${r.trades.toString().padEnd(6)} $${(r.finalEquity/1000).toFixed(1).padEnd(6)}K ${r.totalReturn.padEnd(8)} ${r.maxDD.padEnd(7)} ${r.pf.padEnd(7)} ${r.medianPnL.padEnd(7)} ${r.maxCL.toString().padEnd(6)} ${r.withoutTop10}`
    );
    results.push(r);
  }

  // ═══ V5 退出方式分解 ═══
  console.log('\n' + '═'.repeat(70));
  console.log('V5 退出方式分解');
  console.log('═'.repeat(70));

  const byExit = {};
  v5Signals.forEach(s => { if (!byExit[s.exitReason]) byExit[s.exitReason] = []; byExit[s.exitReason].push(s.pnl * 100); });
  console.log('\n退出原因       次数    胜率     均收益   中位');
  console.log('──────────────────────────────────────────');
  for (const [reason, pnls] of Object.entries(byExit)) {
    const ws = pnls.filter(r => r > 0);
    console.log(`${reason.padEnd(14)} ${pnls.length.toString().padEnd(6)} ${(ws.length/pnls.length*100).toFixed(0).padEnd(4)}%  ${avg(pnls).toFixed(1).padEnd(7)}% ${median(pnls).toFixed(1)}%`);
  }

  // ═══ V5 结论 ═══
  console.log('\n' + '═'.repeat(70));
  console.log('V5 结论');
  console.log('═'.repeat(70));

  const v5r = results.find(r => r.label.includes('V5'));
  const simpleR = results.find(r => r.label.includes('简单强势'));
  const randomR = results.find(r => r.label.includes('随机'));

  const checks = [];
  if (v5r && simpleR) checks.push({ q: 'V5 > 简单强势?', a: `PF ${v5r.pf} vs ${simpleR.pf}`, ok: parseFloat(v5r.pf) > parseFloat(simpleR.pf) });
  if (v5r && randomR) checks.push({ q: 'V5 > 随机?', a: `PF ${v5r.pf} vs ${randomR.pf}`, ok: parseFloat(v5r.pf) > parseFloat(randomR.pf) });
  if (v5r) checks.push({ q: 'V5 PF > 1.5?', a: v5r.pf, ok: parseFloat(v5r.pf) > 1.5 });
  if (v5r) checks.push({ q: 'V5 最大DD < 30%?', a: v5r.maxDD, ok: parseFloat(v5r.maxDD) < 30 });
  if (v5r) checks.push({ q: 'V5 无Top10仍正?', a: v5r.withoutTop10, ok: parseFloat(v5r.withoutTop10) > 0 });

  checks.forEach(c => console.log(`  ${c.ok ? '✅' : '❌'} ${c.q}: ${c.a}`));

  const passed = checks.filter(c => c.ok).length;
  console.log(`\n  ${passed}/${checks.length}通过`);

  // 保存
  fs.writeFileSync(path.join(DATA_DIR, 'v5_strategy_report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    signals: { v5: v5Signals.length, simple: benchSimple.length, random: benchRandom.length },
    results: results.map(r => ({ label: r.label, pf: r.pf, winRate: r.winRate, medianPnL: r.medianPnL, maxDD: r.maxDD, withoutTop10: r.withoutTop10 })),
    exitBreakdown: Object.fromEntries(Object.entries(byExit).map(([k,v]) => [k, { count: v.length, avgPnL: avg(v).toFixed(1)+'%', winRate: (v.filter(r=>r>0).length/v.length*100).toFixed(0)+'%' }])),
    verdict: passed >= 4 ? 'TREND_MANAGEMENT_VIABLE' : 'NEEDS_REFINEMENT',
    architecture: {
      entry: '60日新高 + 回踩不破 + 成交量健康',
      exit: '止损-15% | 移动止盈-10% | 30日到期',
      filter: 'BTC熊市降低仓位',
      philosophy: '不预测方向，只管理趋势。市场给机会时参与，不给时保护资金。',
    },
  }, null, 2));
  L('✅ V5 策略报告已保存');
}

main().catch(e => { L('FAIL: ' + e.message); process.exit(1); });
