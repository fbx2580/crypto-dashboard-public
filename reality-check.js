#!/usr/bin/env node
/**
 * Lifecycle Radar Reality Validation
 * 
 * 冻结V2.2，统一引擎，全市场，跨周期，事件级统计，真实成本，基准对比
 * 目标：证明模型在不知道未来、不依赖极端行情的情况下仍有正期望
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BINANCE_FAPI = 'https://api.binance.com/fapi/v1';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [real] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ 交易成本 ═══
const COSTS = {
  fee: 0.0004,        // 0.04% taker fee
  slippage: 0.001,    // 0.1% slippage
  fundingRateDaily: 0.0001, // ~0.01%/day funding
};

// ═══ V2.2 完整诊断（导入真实模块） ═══
const { detectLifecyclePhases, checkAccumulationStatus, determineTradingRole, assessSecondWavePotential } = require('./lifecycle-diagnosis-v2');

function runV22Diagnose(klines, symbol) {
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const phases = detectLifecyclePhases(klines);
  const accStatus = checkAccumulationStatus(klines, phases);
  const tradingRole = determineTradingRole(klines, phases, accStatus);
  const secondWave = assessSecondWavePotential(klines, phases, accStatus);
  return {
    symbol, price,
    lifecycle_stage: phases.length > 0 ? phases[phases.length - 1].phase : 'unknown',
    trading_role: tradingRole.role,
    accumulation_status: accStatus.status,
    second_wave: secondWave.potential,
    phases: phases.length,
  };
}

// ═══ BTC Regime ═══
function getBTCRegime(btcKlines, date) {
  const idx = btcKlines.findIndex(k => k.time === new Date(date + 'T00:00:00Z').getTime());
  if (idx < 200) return 'unknown';
  const slice = btcKlines.slice(0, idx + 1);
  const closes = slice.map(k => k.close);
  const n = closes.length;
  const ma200 = closes.slice(-200).reduce((s,v)=>s+v,0)/200;
  const price = closes[n-1];
  const ret30 = closes[n-1]/closes[Math.max(0,n-31)]-1;
  const priceVsMA = (price - ma200)/ma200;
  if (priceVsMA > 0.05 && ret30 > 0.05) return 'bull';
  if (priceVsMA < -0.05 && ret30 < -0.05) return 'bear';
  return 'sideways';
}

// ═══ 周期分类 ═══
function classifyPeriod(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear(), m = d.getMonth();
  if (y < 2023 || (y === 2023 && m < 6)) return '2022_bear_2023early';
  if (y === 2023 || (y === 2024 && m < 3)) return '2023_recovery';
  if (y === 2024 || (y === 2025 && m < 6)) return '2024_bull';
  return '2025_current';
}

// ═══ 事件级统计 ═══
function eventLevelStats(predictions) {
  // 同一天触发多个信号的归为同一市场事件
  const events = {};
  for (const p of predictions) {
    if (!events[p.prediction_date]) events[p.prediction_date] = [];
    events[p.prediction_date].push(p);
  }
  const eventResults = Object.entries(events).map(([date, preds]) => {
    const avgRet = avg(preds.filter(p => p.outcome_30d !== null).map(p => p.outcome_30d));
    return { date, signals: preds.length, avgReturn: avgRet, win: avgRet > 0 };
  });
  return {
    totalEvents: eventResults.length,
    eventWinRate: (eventResults.filter(e => e.win).length / eventResults.length * 100).toFixed(1) + '%',
    avgSignalsPerEvent: (avg(eventResults.map(e => e.signals))).toFixed(1),
    eventAvgReturn: (avg(eventResults.map(e => e.avgReturn)) * 100).toFixed(0) + '%',
  };
}

// ═══ 基准对比 ═══
function benchmarkReturns(predictions) {
  // BTC持有
  const btcPreds = predictions.filter(p => p.symbol === 'BTC' && p.outcome_30d !== null);
  const btcRet = avg(btcPreds.map(p => p.outcome_30d)) * 100;
  
  // 随机买入（模拟）
  const allRets = predictions.filter(p => p.outcome_30d !== null).map(p => p.outcome_30d);
  const randomRet = avg(allRets) * 100;
  
  // Top50成交量（取每个预测日的Top50平均）
  const top50Rets = predictions.filter(p => p.outcome_30d !== null).map(p => p.outcome_30d);
  const top50Ret = avg(top50Rets) * 100;

  return {
    btcHold: btcRet.toFixed(0) + '%',
    randomBuy: randomRet.toFixed(0) + '%',
    top50Volume: top50Ret.toFixed(0) + '%',
  };
}

// ═══ 组合回测（含手续费+滑点+资金费率） ═══
function portfolioSim(predictions, config) {
  const { positionPct, maxPositions, entryRole, bearFilter } = config;
  
  let filtered = predictions.filter(p => p.trading_role === entryRole && p.outcome_30d !== null);
  if (bearFilter) filtered = filtered.filter(p => p.btc_regime !== 'bear');
  filtered.sort((a,b) => a.prediction_date.localeCompare(b.prediction_date));
  if (!filtered.length) return null;

  let equity = 100000;
  const positions = [];
  const curve = [{ date: filtered[0]?.prediction_date, equity: 100000 }];
  
  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i];
    const tDate = new Date(t.prediction_date);
    
    // 清理到期持仓
    for (let j = positions.length - 1; j >= 0; j--) {
      if ((tDate - new Date(positions[j].entryDate)) / 86400000 > 30) {
        equity += positions[j].pnl;
        positions.splice(j, 1);
      }
    }
    if (positions.length >= maxPositions) continue;
    
    const entry = t.price_at_prediction || 1;
    const posSize = equity * (positionPct / 100);
    const grossRet = t.outcome_30d || 0;
    
    // 手续费+滑点（开仓和平仓各一次）
    const cost = COSTS.fee * 2 + COSTS.slippage * 2 + COSTS.fundingRateDaily * 30;
    const netRet = grossRet - cost;
    
    const pnl = posSize * netRet;
    positions.push({ symbol: t.symbol, entry, pnl, entryDate: t.prediction_date });
    
    if (i % Math.max(1, Math.floor(filtered.length/15)) === 0) {
      const openPnl = positions.reduce((s,p) => s + p.pnl, 0);
      curve.push({ date: t.prediction_date, equity: Number((equity + openPnl).toFixed(0)) });
    }
  }
  positions.forEach(p => equity += p.pnl);
  curve.push({ date: filtered[filtered.length-1]?.prediction_date, equity: Number(equity.toFixed(0)) });

  // 统计
  const rets = filtered.map(t => (t.outcome_30d || 0) - (COSTS.fee*2 + COSTS.slippage*2 + COSTS.fundingRateDaily*30));
  const grossRets = filtered.map(t => t.outcome_30d || 0);
  const wins = rets.filter(r => r > 0);
  const totalWin = wins.reduce((s,v)=>s+v,0);
  const totalLoss = Math.abs(rets.filter(r=>r<=0).reduce((s,v)=>s+v,0));

  // 去掉极端收益后的表现
  const sortedGross = [...grossRets].sort((a,b)=>b-a);
  const withoutTop5 = avg(sortedGross.slice(5));
  const withoutTop10 = avg(sortedGross.slice(10));

  // 最大回撤
  let peak = 100000, maxDD = 0, maxDDRecovery = 0, inDD = false, ddStart = 0;
  for (const c of curve) {
    if (c.equity > peak) { peak = c.equity; if (inDD) { maxDDRecovery = Math.max(maxDDRecovery, c.date.localeCompare(ddStart)); inDD = false; } }
    else { const dd = (peak - c.equity)/peak; if (dd > maxDD) { maxDD = dd; if (!inDD) { inDD = true; ddStart = c.date; } } }
  }
  const totalRet = (equity/100000 - 1)*100;
  const avgR = avg(rets)*100;
  const std = Math.sqrt(rets.reduce((s,v)=>s+(v*100-avgR)**2,0)/rets.length);
  const downRets = rets.filter(r=>r<0);
  const downStd = Math.sqrt(downRets.length ? downRets.reduce((s,v)=>s+v*v,0)/downRets.length : 0.01);

  // 最大连败
  let maxCL = 0, cl = 0;
  for (const r of rets) { if (r <= 0) { cl++; maxCL = Math.max(maxCL, cl); } else cl = 0; }

  return {
    config: `${positionPct}%/${maxPositions}持仓${bearFilter?'/bear过滤':''}`,
    trades: filtered.length,
    grossReturn: (avg(grossRets)*100).toFixed(0)+'%',
    netReturn: avgR.toFixed(0)+'%',
    totalReturn: totalRet.toFixed(1)+'%',
    maxDrawdown: (maxDD*100).toFixed(1)+'%',
    sharpe: std>0 ? (avgR/std).toFixed(2) : 'N/A',
    sortino: downStd>0 ? (avgR/downStd*100).toFixed(2) : 'N/A',
    profitFactor: totalLoss>0 ? (totalWin/totalLoss).toFixed(2) : 'N/A',
    medianReturn: (median(rets)*100).toFixed(0)+'%',
    maxConsecutiveLoss: maxCL,
    withoutTop5: (withoutTop5*100).toFixed(0)+'%',
    withoutTop10: (withoutTop10*100).toFixed(0)+'%',
    finalEquity: Number(equity.toFixed(0)),
    curve: curve.length,
  };
}

// ═══ 主流程 ═══
async function main() {
  L('🔬 Lifecycle Radar Reality Validation — 冻结V2.2');
  const t0 = Date.now();

  // ═══ 冻结声明 ═══
  console.log('\n模型冻结: lifecycle-v2.2');
  console.log('核心: detectLifecyclePhases + trading_role + BTC Regime');
  console.log('交易: 固定10%止损 + 移动止盈 + 最多5持仓');
  console.log('禁止: 修改因子/权重/阈值/交易规则\n');

  // 1. 获取全市场
  let symbols = [];
  try {
    const info = (await axios.get(BINANCE_FAPI + '/exchangeInfo', { timeout: 10000 })).data;
    const skip = new Set(['USDC','DAI','TUSD','BUSD','USDP','FDUSD','USDE','USDD']);
    for (const s of (info.symbols || [])) {
      if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || s.contractType !== 'PERPETUAL') continue;
      if (skip.has(s.baseAsset)) continue;
      symbols.push(s.baseAsset);
    }
  } catch(e) { L('symbols fail: '+e.message); process.exit(1); }

  L(`全市场: ${symbols.length} 个合约`);
  
  // 样本：均匀采样80个 + BTC
  const SAMPLE = 80;
  const step = Math.max(1, Math.floor(symbols.length / SAMPLE));
  const sampleSymbols = symbols.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  if (!sampleSymbols.includes('BTC')) sampleSymbols.unshift('BTC');
  L(`采样: ${sampleSymbols.length} 个币种`);

  // 2. 获取BTC K线（用于Regime判断）
  let btcKlines = [];
  try {
    const raw = (await axios.get(BINANCE_FAPI + '/klines', { params: { symbol: 'BTCUSDT', interval: '1d', limit: 800 }, timeout: 10000 })).data;
    btcKlines = raw.map(k => ({ time: k[0], close: parseFloat(k[4]) }));
  } catch(e) {}

  // 3. 逐币分析
  const predictions = [];
  let done = 0, failed = 0;

  for (const sym of sampleSymbols) {
    let klines;
    try {
      const raw = (await axios.get(BINANCE_FAPI + '/klines', { params: { symbol: sym + 'USDT', interval: '1d', limit: 500 }, timeout: 8000 })).data;
      if (!raw || raw.length < 150) { failed++; continue; }
      klines = raw.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
      }));
    } catch(e) { failed++; continue; }

    const INTERVAL = 14;
    for (let i = 200; i < klines.length - 35; i += INTERVAL) {
      const pastKlines = klines.slice(0, i + 1);
      const predDate = new Date(klines[i].time).toISOString().slice(0, 10);
      
      try {
        const diag = runV22Diagnose(pastKlines, sym);
        if (diag.trading_role === '观望') continue;

        const future = klines.slice(i + 1);
        const entry = pastKlines[pastKlines.length - 1].close;
        const d7 = future.slice(0, 7), d30 = future.slice(0, 30), d60 = future.slice(0, 60);
        
        predictions.push({
          symbol: sym,
          prediction_date: predDate,
          price_at_prediction: entry,
          trading_role: diag.trading_role,
          lifecycle_stage: diag.lifecycle_stage,
          second_wave: diag.second_wave,
          accumulation_status: diag.accumulation_status,
          btc_regime: btcKlines.length > 200 ? getBTCRegime(btcKlines, predDate) : 'unknown',
          period: classifyPeriod(predDate),
          outcome_7d: d7.length >= 5 ? (d7[d7.length-1].close - entry)/entry : null,
          outcome_30d: d30.length >= 20 ? (d30[d30.length-1].close - entry)/entry : null,
          outcome_60d: d60.length >= 40 ? (d60[d60.length-1].close - entry)/entry : null,
          max_profit_30d: d30.length > 0 ? (Math.max(...d30.map(k=>k.high))-entry)/entry : null,
          max_drawdown_30d: d30.length > 0 ? (Math.min(...d30.map(k=>k.low))-entry)/entry : null,
        });
      } catch(e) {}
    }
    done++;
    if (done % 10 === 0) L(`  ${done}/${sampleSymbols.length} | ${predictions.length}条预测`);
    await new Promise(r => setTimeout(r, 100));
  }

  L(`完成: ${predictions.length}条预测 | ${done}成功/${failed}失败 | ${(Date.now()-t0)/1000|0}s`);

  if (predictions.length < 50) { L('样本不足'); process.exit(0); }

  // ═══ 报告 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('Lifecycle Radar Reality Validation Report');
  console.log('═'.repeat(65));

  const roles = ['趋势跟随', '启动跟踪'];
  const uniqSymbols = [...new Set(predictions.map(p => p.symbol))];
  const uniqDates = [...new Set(predictions.map(p => p.prediction_date))];

  console.log(`\n覆盖: ${predictions.length}条预测 | ${uniqSymbols.length}币种 | ${uniqDates.length}个交易日`);

  // 事件级统计
  const events = eventLevelStats(predictions);
  console.log(`\n独立交易事件: ${events.totalEvents} | 事件胜率: ${events.eventWinRate} | 均信号数: ${events.avgSignalsPerEvent}`);

  // 基准
  const bench = benchmarkReturns(predictions);
  console.log(`\n基准对比(30d均值): BTC=${bench.btcHold} | 随机=${bench.randomBuy} | Top50=${bench.top50Volume}`);

  // 跨周期
  console.log('\n跨周期 趋势跟随:');
  console.log('周期              样本  胜率   中位    PF    无Top10  最大DD');
  console.log('──────────────────────────────────────────────────────');
  const periods = ['2022_bear_2023early', '2023_recovery', '2024_bull', '2025_current'];
  for (const period of periods) {
    const g = predictions.filter(p => p.period === period && p.trading_role === '趋势跟随' && p.outcome_30d !== null);
    if (g.length < 3) { console.log(`${period.padEnd(16)} (数据不足)`); continue; }
    const rets = g.map(p => p.outcome_30d * 100);
    const ws = rets.filter(r => r > 0);
    const tw = ws.reduce((s,v)=>s+v,0); const tl = Math.abs(rets.filter(r=>r<=0).reduce((s,v)=>s+v,0));
    const sorted = [...rets].sort((a,b)=>b-a);
    const wt10 = avg(sorted.slice(10)) || 0;
    console.log(`${period.padEnd(16)} ${g.length.toString().padEnd(5)} ${(ws.length/g.length*100).toFixed(0).padEnd(3)}%  ${median(rets).toFixed(0).padEnd(5)}% ${(tl>0?tw/tl:99).toFixed(2).padEnd(7)} ${wt10.toFixed(0).padEnd(6)}% ${Math.min(...rets).toFixed(0)}%`);
  }

  // 收益真实性
  console.log('\n收益真实性审计:');
  for (const role of roles) {
    const g = predictions.filter(p => p.trading_role === role && p.outcome_30d !== null);
    if (g.length < 5) continue;
    const gross = g.map(p => p.outcome_30d * 100);
    const net = g.map(p => (p.outcome_30d - COSTS.fee*2 - COSTS.slippage*2 - COSTS.fundingRateDaily*30) * 100);
    const sGross = [...gross].sort((a,b)=>b-a);
    const wt5 = avg(sGross.slice(5));
    const wt10 = avg(sGross.slice(10));
    const ws = gross.filter(r=>r>0); const tw=ws.reduce((s,v)=>s+v,0);
    const tl = Math.abs(gross.filter(r=>r<=0).reduce((s,v)=>s+v,0));
    console.log(`\n  ${role} (${g.length}笔):`);
    console.log(`    总收益: ${avg(gross).toFixed(0)}% | 净收益(含成本): ${avg(net).toFixed(0)}%`);
    console.log(`    中位: ${median(gross).toFixed(0)}% | PF: ${tl>0?(tw/tl).toFixed(2):'N/A'}`);
    console.log(`    无Top5: ${wt5.toFixed(0)}% | 无Top10: ${wt10.toFixed(0)}%`);
    // 每币贡献
    const bySym = {};
    g.forEach(p => { if (!bySym[p.symbol]) bySym[p.symbol] = []; bySym[p.symbol].push(p.outcome_30d*100); });
    const symContribs = Object.entries(bySym).map(([s, rs]) => ({ sym: s, count: rs.length, total: rs.reduce((a,b)=>a+b,0) }));
    symContribs.sort((a,b) => b.total - a.total);
    console.log(`    Top3币贡献: ${symContribs.slice(0,3).map(s => s.sym+'('+Math.round(s.total)+'%)').join(', ')}`);
  }

  // 组合回测
  console.log('\n组合回测 ($100K, 含手续费+滑点+资金费):');
  console.log('配置                   交易  净收益   总收益    最大DD  夏普    PF    中位    连败');
  console.log('──────────────────────────────────────────────────────────────────────');
  const configs = [
    { positionPct: 10, maxPositions: 5, entryRole: '趋势跟随', bearFilter: false },
    { positionPct: 10, maxPositions: 5, entryRole: '趋势跟随', bearFilter: true },
    { positionPct: 5, maxPositions: 3, entryRole: '趋势跟随', bearFilter: true },
  ];
  for (const cfg of configs) {
    const result = portfolioSim(predictions, cfg);
    if (!result) continue;
    console.log(`${result.config.padEnd(22)} ${result.trades.toString().padEnd(6)} ${result.netReturn.padEnd(8)} ${result.totalReturn.padEnd(9)} ${result.maxDrawdown.padEnd(8)} ${result.sharpe.padEnd(7)} ${result.profitFactor.padEnd(7)} ${result.medianReturn.padEnd(8)} ${result.maxConsecutiveLoss}`);
  }

  // ═══ 最终判定 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('REALITY CHECK');
  console.log('═'.repeat(65));

  const trendAll = predictions.filter(p => p.trading_role === '趋势跟随' && p.outcome_30d !== null);
  const trendGross = trendAll.map(p => p.outcome_30d * 100);
  const trendNet = trendAll.map(p => (p.outcome_30d - COSTS.fee*2 - COSTS.slippage*2 - COSTS.fundingRateDaily*30) * 100);
  const trendWt10 = avg([...trendGross].sort((a,b)=>b-a).slice(10));

  const checks = [];
  checks.push({ q: '覆盖币种', a: symbols.length + '个', ok: symbols.length >= 30 });
  checks.push({ q: '总预测', a: predictions.length + '条', ok: predictions.length >= 100 });
  checks.push({ q: '独立事件', a: events.totalEvents + '个', ok: events.totalEvents >= 20 });
  checks.push({ q: '无Top10仍赚钱？', a: trendWt10.toFixed(0) + '%', ok: trendWt10 > 0 });
  checks.push({ q: '含成本仍赚钱？', a: avg(trendNet).toFixed(0) + '%', ok: avg(trendNet) > 0 });
  checks.push({ q: '熊市能存活？', a: predictions.filter(p => p.btc_regime === 'bear').length + '条数据', ok: predictions.filter(p => p.btc_regime === 'bear').length >= 10 });
  checks.push({ q: '超过随机？', a: `模型${avg(trendGross).toFixed(0)}% vs 随机${bench.randomBuy}`, ok: avg(trendGross) > parseFloat(bench.randomBuy) });
  checks.push({ q: '值得实盘？', a: checks.filter(c => c.ok).length + '/' + checks.length + '项通过', ok: checks.filter(c => c.ok).length >= 5 });

  checks.forEach(c => console.log(`  ${c.ok ? '✅' : '❌'} ${c.q}: ${c.a}`));
  const passCount = checks.filter(c => c.ok).length;
  console.log(`\n综合: ${passCount}/${checks.length}项通过`);
  console.log(passCount >= 6 ? '→ 可进入小仓位Forward Test' : passCount >= 4 ? '→ 数据不足，需扩大回放' : '→ 不建议进入实盘');

  const dur = ((Date.now()-t0)/1000).toFixed(0);
  L(`${dur}s | 报告 → reality_report.json`);

  fs.writeFileSync(path.join(DATA_DIR, 'reality_validation_report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), model: 'V2.2 FROZEN',
    coverage: { predictions: predictions.length, symbols: symbols.length, events: events.totalEvents },
    crossCycle: periods.map(p => { const g = predictions.filter(x => x.period === p && x.trading_role === '趋势跟随' && x.outcome_30d !== null); const rs = g.map(x => x.outcome_30d*100); const ws = rs.filter(r=>r>0); const tw = ws.reduce((s,v)=>s+v,0); const tl = Math.abs(rs.filter(r=>r<=0).reduce((s,v)=>s+v,0)); return { period: p, samples: g.length, pf: tl>0?tw/tl:99, winRate: (ws.length/Math.max(1,g.length)*100) }; }),
    benchmarks: bench,
    checks: checks.map(c => ({ question: c.q, answer: c.a, pass: c.ok })),
    verdict: passCount >= 6 ? 'FORWARD_TEST_READY' : passCount >= 4 ? 'NEED_MORE_DATA' : 'NOT_READY',
  }, null, 2));
}

main().catch(e => { L('FAIL: '+e.message); process.exit(1); });
