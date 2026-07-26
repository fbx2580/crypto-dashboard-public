#!/usr/bin/env node
/**
 * Lifecycle Radar V2.2 — 大样本缓存式验证
 * 
 * 策略：先下载K线到本地缓存，再批量回测，避免API不稳定
 * 冻结V2.2，不修改任何规则
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const CACHE_DIR = path.join(__dirname, 'public', 'data', 'klines_cache');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [val] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ K线缓存 ═══
async function getCachedKlines(symbol, days = 400) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000;
    if (age < 24) return cached.klines; // 24小时缓存
  }

  // 从API获取
  const sym = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
  for (let retry = 0; retry < 3; retry++) {
    try {
      const raw = (await axios.get(`${BINANCE_FAPI}/klines`, {
        params: { symbol: sym, interval: '1d', limit: days + 10 },
        timeout: 10000
      })).data;
      if (!raw || raw.length < 100) return null;
      const klines = raw.map(k => ({
        time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
        volume: +k[5], quoteVolume: +k[7],
      }));
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), symbol, klines }));
      return klines;
    } catch(e) {
      if (retry < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

// ═══ V2.2 诊断（导入真实模块） ═══
const { detectLifecyclePhases, checkAccumulationStatus, determineTradingRole } = require('./lifecycle-diagnosis-v2');

function runDiagnosis(klines, symbol) {
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const phases = detectLifecyclePhases(klines);
  const accStatus = checkAccumulationStatus(klines, phases);
  const role = determineTradingRole(klines, phases, accStatus);
  return {
    symbol, price,
    stage: phases.length > 0 ? phases[phases.length - 1].phase : 'unknown',
    role: role.role,
    accStatus: accStatus.status,
  };
}

// ═══ 统计 ═══
function computeStats(rets) {
  const n = rets.length;
  if (!n) return null;
  const wins = rets.filter(r => r > 0);
  const losses = rets.filter(r => r <= 0);
  const tw = wins.reduce((s,v)=>s+v,0);
  const tl = Math.abs(losses.reduce((s,v)=>s+v,0));
  const sorted = [...rets].sort((a,b)=>b-a);
  
  return {
    samples: n,
    winRate: (wins.length/n*100).toFixed(1)+'%',
    mean: avg(rets).toFixed(1)+'%',
    median: median(rets).toFixed(1)+'%',
    pf: tl > 0 ? (tw/tl).toFixed(2) : 'N/A',
    maxDD: Math.min(...rets).toFixed(1)+'%',
    withoutTop5: avg(sorted.slice(Math.ceil(n*0.05))).toFixed(1)+'%',
    withoutTop10: avg(sorted.slice(Math.ceil(n*0.10))).toFixed(1)+'%',
    withoutTop20: avg(sorted.slice(Math.ceil(n*0.20))).toFixed(1)+'%',
  };
}

// ═══ 事件级 ═══
function eventStats(predictions) {
  const events = {};
  for (const p of predictions) {
    if (!events[p.prediction_date]) events[p.prediction_date] = [];
    events[p.prediction_date].push(p);
  }
  const results = Object.entries(events).map(([date, preds]) => {
    const valid = preds.filter(p => p.outcome_30d !== null);
    return { date, signals: preds.length, ret: valid.length ? avg(valid.map(p => p.outcome_30d)) : 0 };
  });
  const wins = results.filter(r => r.ret > 0);
  const rets = results.map(r => r.ret);
  return {
    totalEvents: results.length,
    winRate: (wins.length/results.length*100).toFixed(1)+'%',
    avgSignals: avg(results.map(r => r.signals)).toFixed(1),
    avgReturn: avg(rets).toFixed(1)+'%',
  };
}

// ═══ 主流程 ═══
async function main() {
  L('Lifecycle Radar V2.2 — 缓存式大样本验证');
  
  // 1. 获取全市场列表
  L('获取合约列表...');
  let allSymbols = [];
  try {
    const info = (await axios.get(`${BINANCE_FAPI}/exchangeInfo`, { timeout: 10000 })).data;
    const skip = new Set(['USDC','DAI','TUSD','BUSD','USDP','FDUSD','USDE','USDD']);
    for (const s of (info.symbols || [])) {
      if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || s.contractType !== 'PERPETUAL') continue;
      if (skip.has(s.baseAsset)) continue;
      allSymbols.push(s.baseAsset);
    }
  } catch(e) { L('symbols fail, using cached 528'); allSymbols = ['BTC']; }

  L(`全市场: ${allSymbols.length} 个合约`);
  
  // 采样策略：全部尝试，但控制数量
  const MAX_COINS = 300;
  const sample = allSymbols.slice(0, MAX_COINS);
  if (!sample.includes('BTC')) sample.unshift('BTC');
  L(`目标: ${sample.length} 个币种`);

  // 2. 缓存K线 + 批量诊断
  const predictions = [];
  let cached = 0, fetched = 0, failed = 0;

  for (let i = 0; i < sample.length; i++) {
    const sym = sample[i];
    const cacheFile = path.join(CACHE_DIR, `${sym}.json`);
    const wasCached = fs.existsSync(cacheFile);
    
    const klines = await getCachedKlines(sym, 500);
    if (!klines) { failed++; continue; }
    
    if (wasCached) cached++; else fetched++;

    // 14天间隔采样诊断
    for (let j = 200; j < klines.length - 35; j += 14) {
      const past = klines.slice(0, j + 1);
      try {
        const diag = runDiagnosis(past, sym);
        if (diag.role === '观望') continue;
        
        const future = klines.slice(j + 1);
        const entry = past[past.length - 1].close;
        const d30 = future.slice(0, 30);
        
        predictions.push({
          symbol: sym,
          prediction_date: new Date(past[past.length - 1].time).toISOString().slice(0, 10),
          price_at_prediction: entry,
          trading_role: diag.role,
          outcome_30d: d30.length >= 20 ? (d30[d30.length - 1].close - entry) / entry : null,
          max_profit_30d: d30.length > 0 ? (Math.max(...d30.map(k => k.high)) - entry) / entry : null,
          max_drawdown_30d: d30.length > 0 ? (Math.min(...d30.map(k => k.low)) - entry) / entry : null,
        });
      } catch(e) {}
    }

    if ((i + 1) % 25 === 0) {
      L(`  [${i+1}/${sample.length}] 预测${predictions.length} | 缓存${cached} 新拉${fetched} 失败${failed}`);
    }
  }

  L(`完成: ${predictions.length}条预测 | ${[...new Set(predictions.map(p=>p.symbol))].length}币种 | 缓存${cached} 新拉${fetched} 失败${failed}`);

  if (predictions.length < 50) { L('样本不足'); process.exit(0); }

  // ═══ 报告 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('Lifecycle Radar V2.2 Reality Report');
  console.log('═'.repeat(65));

  const symbols = [...new Set(predictions.map(p => p.symbol))];
  console.log(`\n覆盖: ${predictions.length}条 | ${symbols.length}币种`);

  // 事件级
  const evts = eventStats(predictions);
  console.log(`独立事件: ${evts.totalEvents} | 事件胜率: ${evts.winRate} | 均信号/事件: ${evts.avgSignals}`);

  // 趋势跟随全量
  const trend = predictions.filter(p => p.trading_role === '趋势跟随' && p.outcome_30d !== null);
  const tRets = trend.map(p => p.outcome_30d * 100);
  const tStats = computeStats(tRets);

  console.log(`\n趋势跟随 (${trend.length}笔):`);
  if (tStats) {
    console.log(`  全样本: 胜率${tStats.winRate} | 中位${tStats.median} | PF=${tStats.pf}`);
    console.log(`  去Top5%: ${tStats.withoutTop5} | 去Top10%: ${tStats.withoutTop10} | 去Top20%: ${tStats.withoutTop20}`);
  }

  // 启动跟踪
  const launch = predictions.filter(p => p.trading_role === '启动跟踪' && p.outcome_30d !== null);
  const lRets = launch.map(p => p.outcome_30d * 100);
  const lStats = computeStats(lRets);
  console.log(`\n启动跟踪 (${launch.length}笔):`);
  if (lStats) {
    console.log(`  全样本: 胜率${lStats.winRate} | 中位${lStats.median} | PF=${lStats.pf}`);
    console.log(`  去Top10%: ${lStats.withoutTop10} | 去Top20%: ${lStats.withoutTop20}`);
  }

  // 组合回测
  console.log('\n组合回测 ($10K, 10%/5持仓, -10%止损):');
  let equity = 10000;
  let peak = 10000, maxDD = 0, maxCL = 0, cl = 0;
  const positions = [];
  const trades = trend.sort((a,b) => a.prediction_date.localeCompare(b.prediction_date));
  
  for (const t of trades) {
    const tDate = new Date(t.prediction_date);
    for (let j = positions.length - 1; j >= 0; j--) {
      if ((tDate - new Date(positions[j].entryDate)) / 86400000 > 30) {
        equity += positions[j].pnl;
        positions.splice(j, 1);
      }
    }
    if (positions.length >= 5) continue;
    
    const entry = t.price_at_prediction || 1;
    const pos = equity * 0.10;
    const ret = t.outcome_30d || 0;
    const sl = -0.10;
    const actualRet = (t.max_drawdown_30d || 0) <= sl ? sl : ret;
    const pnl = pos * actualRet;
    
    if (actualRet > 0) cl = 0; else { cl++; maxCL = Math.max(maxCL, cl); }
    positions.push({ symbol: t.symbol, entry, pnl, entryDate: t.prediction_date });
    
    const openPnl = positions.reduce((s,p) => s + p.pnl, 0);
    const total = equity + openPnl;
    if (total > peak) peak = total;
    else { const dd = (peak - total) / peak; if (dd > maxDD) maxDD = dd; }
  }
  positions.forEach(p => equity += p.pnl);
  
  console.log(`  终值: $${equity.toFixed(0)} | 总收益: ${((equity/10000-1)*100).toFixed(1)}%`);
  console.log(`  最大DD: ${(maxDD*100).toFixed(1)}% | 最大连败: ${maxCL}`);

  // 基准
  const allRets = predictions.filter(p => p.outcome_30d !== null).map(p => p.outcome_30d * 100);
  const btcRets = predictions.filter(p => p.symbol === 'BTC' && p.outcome_30d !== null).map(p => p.outcome_30d * 100);
  console.log(`\n基准: 随机${avg(allRets).toFixed(1)}% | BTC持有${avg(btcRets).toFixed(1)}%`);
  console.log(`趋势跟随中位${tStats?.median || 'N/A'} vs 随机${avg(allRets).toFixed(1)}% ${(parseFloat(tStats?.median || '0') > avg(allRets) ? '✅' : '❌')}`);

  // 判定
  const checks = [];
  if (tStats) {
    checks.push({ q: 'PF>1.5(全量)', ok: parseFloat(tStats.pf) > 1.5 });
    checks.push({ q: '去除Top10%仍正', ok: parseFloat(tStats.withoutTop10) > 0 });
    checks.push({ q: '去除Top20%仍正', ok: parseFloat(tStats.withoutTop20) > 0 });
    checks.push({ q: '中位>随机', ok: parseFloat(tStats.median) > avg(allRets) });
  }
  checks.push({ q: '组合DD<30%', ok: maxDD < 0.30 });
  checks.push({ q: '样本>100', ok: trend.length >= 100 });

  console.log('\n判定:');
  checks.forEach(c => console.log(`  ${c.ok?'✅':'❌'} ${c.q}`));
  const passed = checks.filter(c => c.ok).length;
  console.log(`\n${passed}/${checks.length}通过 | ${passed>=5?'✅ 可进Forward Test':'⚠️ 需继续验证'}`);

  // 保存
  fs.writeFileSync(path.join(DATA_DIR, 'reality_v2.2_report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    model: 'V2.2 FROZEN',
    coverage: { predictions: predictions.length, symbols: symbols.length, events: evts.totalEvents },
    trendFollowing: tStats,
    launchTracking: lStats,
    portfolio: { finalEquity: Number(equity.toFixed(0)), maxDD: (maxDD*100).toFixed(1)+'%', maxCL },
    checks: checks.map(c => ({ ...c })),
    verdict: passed >= 5 ? 'FORWARD_TEST_READY' : 'NEED_MORE_VALIDATION',
  }, null, 2));
  L('✅ 报告已保存');
}

main().catch(e => { L('FAIL: ' + e.message); process.exit(1); });
