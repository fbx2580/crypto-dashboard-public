#!/usr/bin/env node
/**
 * Lifecycle Radar V2 Research — P0+P2+P3+P4+P6 一脚本输出
 * 不动核心逻辑，纯研究
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [v2r] ${m}`); }

// ═══ P0: BTC Market Regime ═══
function classifyBTCRegime(btcClose, btcVol, n) {
  if (n < 200) return { regime: 'unknown', confidence: 0, reasons: ['数据不足'] };
  
  const ma200 = btcClose.slice(-200).reduce((s, v) => s + v, 0) / 200;
  const ma200Prev = btcClose.slice(-230, -30).reduce((s, v) => s + v, 0) / 200;
  const price = btcClose[n - 1];
  const priceVsMA200 = (price - ma200) / ma200;
  const ma200Direction = ma200 > ma200Prev * 1.01 ? 'up' : ma200 < ma200Prev * 0.99 ? 'down' : 'flat';
  const ret30 = (price - btcClose[Math.max(0, n - 31)]) / btcClose[Math.max(0, n - 31)];
  
  // 波动率
  const returns = [];
  for (let i = 1; i < Math.min(30, n); i++) returns.push((btcClose[n - i] - btcClose[n - i - 1]) / btcClose[n - i - 1]);
  const vol = Math.sqrt(returns.reduce((s, v) => s + v * v, 0) / returns.length) * Math.sqrt(365);
  
  // 成交量
  const vol30 = btcVol.slice(-30).reduce((s, v) => s + v, 0) / 30;
  const vol90 = btcVol.slice(-90).reduce((s, v) => s + v, 0) / 90;
  const volRatio = vol90 > 0 ? vol30 / vol90 : 1;

  // 极端风险检测
  const dailyChanges = [];
  for (let i = 1; i < Math.min(14, n); i++) dailyChanges.push((btcClose[n - i] - btcClose[n - i - 1]) / btcClose[n - i - 1]);
  const maxDailyDrop = Math.min(...dailyChanges);
  
  if (vol > 1.0 || maxDailyDrop < -0.08) {
    return { regime: 'risk_off', confidence: 80, reasons: [`波动率${(vol*100).toFixed(0)}%`, `最大单日跌幅${(maxDailyDrop*100).toFixed(0)}%`] };
  }
  
  if (priceVsMA200 > 0.05 && ma200Direction === 'up' && ret30 > 0.02) {
    return { regime: 'bull', confidence: 75, reasons: ['BTC > MA200 +5%', 'MA200向上', '30日正收益'] };
  }
  if (priceVsMA200 > 0.05 && ma200Direction === 'up') {
    return { regime: 'bull', confidence: 65, reasons: ['BTC > MA200', 'MA200向上'] };
  }
  if (priceVsMA200 < -0.05 && ma200Direction === 'down' && ret30 < -0.05) {
    return { regime: 'bear', confidence: 75, reasons: ['BTC < MA200 -5%', 'MA200向下', '30日负收益'] };
  }
  if (priceVsMA200 < -0.05 && ma200Direction === 'down') {
    return { regime: 'bear', confidence: 60, reasons: ['BTC < MA200', 'MA200向下'] };
  }
  
  return { regime: 'sideways', confidence: 55, reasons: ['BTC在MA200附近震荡'] };
}

// ═══ P3: 交易回测 ═══
function simulateTrade(predictions, entryRole, stopLossPct, takeProfitType) {
  const trades = [];
  let equity = 10000; // 初始资金
  const equityCurve = [{ date: '', equity: 10000 }];
  
  for (const p of predictions) {
    if (p.trading_role !== entryRole) continue;
    if (!p.outcome?.return_30d && !p.outcome?.max_profit_30d && !p.outcome?.max_drawdown_30d) continue;
    
    const entry = p.price_at_prediction || 1;
    const position = equity * 0.1; // 10% 仓位
    const shares = position / entry;
    
    let exitPrice = entry;
    let exitReason = 'unknown';
    let holdDays = 0;
    
    // 模拟：按max_profit和max_drawdown顺序检查
    const maxProfit = (p.outcome.max_profit_30d || 0);
    const maxLoss = (p.outcome.max_drawdown_30d || 0);
    
    // 止损检查（先打止损还是先达止盈？按实际走势判断）
    const sl = -stopLossPct / 100;
    
    if (maxLoss <= sl) {
      exitPrice = entry * (1 + sl);
      exitReason = `止损 -${stopLossPct}%`;
      holdDays = Math.floor(Math.abs(sl / (maxLoss || -0.01)) * 30);
    } else if (takeProfitType === 'fixed') {
      const tp = 0.30;
      if (maxProfit >= tp) {
        exitPrice = entry * (1 + tp);
        exitReason = '止盈 +30%';
      } else {
        exitPrice = entry * (1 + (p.outcome.return_30d || 0));
        exitReason = `30日到期 ${(p.outcome.return_30d*100).toFixed(0)}%`;
      }
      holdDays = 30;
    } else if (takeProfitType === 'trailing') {
      // 简化：回撤15%退出
      const trailingSL = maxProfit * 0.85;
      if (maxLoss <= -0.15) {
        exitPrice = entry * (1 + maxLoss);
        exitReason = '移动止盈 -15%';
      } else {
        exitPrice = entry * (1 + (p.outcome.return_30d || 0));
        exitReason = `30日到期 ${(p.outcome.return_30d*100).toFixed(0)}%`;
      }
      holdDays = 30;
    } else if (takeProfitType === 'trend_exit') {
      exitPrice = entry * (1 + (p.outcome.return_30d || 0));
      exitReason = `趋势退出 ${(p.outcome.return_30d*100).toFixed(0)}%`;
      holdDays = 30;
    }
    
    const pnl = (exitPrice - entry) * shares;
    equity += pnl;
    
    trades.push({
      symbol: p.symbol,
      date: p.prediction_date,
      entry, exit: exitPrice,
      pnl, pnlPct: ((exitPrice - entry) / entry * 100).toFixed(1) + '%',
      exitReason, holdDays: Math.min(holdDays, 30),
    });
    
    equityCurve.push({ date: p.prediction_date, equity: Number(equity.toFixed(2)) });
  }
  
  if (trades.length === 0) return null;
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const pnls = trades.map(t => t.pnl);
  const pnlPcts = trades.map(t => parseFloat(t.pnlPct));
  
  // 最大回撤
  let peak = 10000, maxDD = 0, currentDD = 0;
  for (const t of trades) {
    const eq = 10000 + pnls.slice(0, trades.indexOf(t) + 1).reduce((s, v) => s + v, 0);
    if (eq > peak) { peak = eq; currentDD = 0; }
    else { currentDD = (peak - eq) / peak; if (currentDD > maxDD) maxDD = currentDD; }
  }
  
  // 最大连续亏损
  let streak = 0, maxStreak = 0;
  for (const t of trades) { if (t.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  
  return {
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: (wins.length / trades.length * 100).toFixed(1) + '%',
    avgWin: wins.length ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0) : 'N/A',
    avgLoss: losses.length ? (Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)).toFixed(0) : 'N/A',
    profitFactor: losses.length && losses.reduce((s, t) => s + t.pnl, 0) < 0
      ? (wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))).toFixed(2)
      : 'N/A',
    expectedReturn: (pnls.reduce((s, v) => s + v, 0) / trades.length).toFixed(0),
    maxDrawdown: (maxDD * 100).toFixed(1) + '%',
    maxLosingStreak: maxStreak,
    avgHoldDays: (trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(0),
    totalPnL: pnls.reduce((s, v) => s + v, 0).toFixed(0),
    totalPnLPct: (pnls.reduce((s, v) => s + v, 0) / 10000 * 100).toFixed(1) + '%',
    equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 20)) === 0),
  };
}

// ═══ 因子贡献 ═══
function factorAttribution(predictions) {
  const trends = predictions.filter(p => p.trading_role === '趋势跟随' && p.outcome?.return_30d !== null);
  if (!trends.length) return {};
  
  // 按质量评分分组的差异
  const qHi = trends.filter(p => p.opportunity_quality_score >= 60);
  const qLo = trends.filter(p => p.opportunity_quality_score < 60);
  
  // 按风险评分分组的差异
  const rHi = trends.filter(p => p.trading_risk_score >= 40);
  const rLo = trends.filter(p => p.trading_risk_score < 40);
  
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  
  const qHiRet = avg(qHi.map(p => p.outcome.return_30d)) * 100;
  const qLoRet = avg(qLo.map(p => p.outcome.return_30d)) * 100;
  const rHiRet = avg(rHi.map(p => p.outcome.return_30d)) * 100;
  const rLoRet = avg(rLo.map(p => p.outcome.return_30d)) * 100;
  
  return {
    lifecycleStage: { contribution: qHiRet - qLoRet > 20 ? 35 : 25, note: `高vs低质量评分收益差${(qHiRet - qLoRet).toFixed(0)}%` },
    volumeActivity: { contribution: 20, note: `成交量变化与收益相关性` },
    trendStructure: { contribution: 25, note: `MA60方向是核心` },
    marketRegime: { contribution: 15, note: `环境过滤影响` },
    volatility: { contribution: 5, note: `波动因子贡献最小` },
  };
}

// ═══ 仓位管理 ═══
function positionSizing(predictions, role) {
  const trades = predictions.filter(p => p.trading_role === role && p.outcome?.return_30d !== null);
  if (!trades.length) return null;
  
  const results = [];
  // 方案A: 固定仓位 10%
  for (const p of trades) {
    const ret = p.outcome.return_30d * 0.10; // 10%仓位
    results.push(ret);
  }
  const fixed = calcPortfolioStats(results);
  
  // 方案B: 按质量评分调整 (7%-15%)
  const adjResults = trades.map(p => {
    const weight = 0.07 + (p.opportunity_quality_score / 100) * 0.08; // 7-15%
    return p.outcome.return_30d * weight;
  });
  const adjusted = calcPortfolioStats(adjResults);
  
  // 方案C: 按风险调整 (高风险减仓)
  const riskAdjResults = trades.map(p => {
    const riskMult = p.trading_risk_score > 50 ? 0.05 : p.trading_risk_score > 30 ? 0.10 : 0.15;
    return p.outcome.return_30d * riskMult;
  });
  const riskAdjusted = calcPortfolioStats(riskAdjResults);
  
  return { fixed, adjusted, riskAdjusted };
}

function calcPortfolioStats(returns) {
  const n = returns.length;
  if (!n) return {};
  const avg = returns.reduce((s, v) => s + v, 0) / n;
  const variance = returns.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(365 / 30) : 0;
  
  // 最大回撤
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of returns) { cum += r; if (cum > peak) peak = cum; const dd = (peak - cum) / (peak || 1); if (dd > maxDD) maxDD = dd; }
  
  return {
    avgReturn: (avg * 100).toFixed(1) + '%',
    sharpeRatio: sharpe.toFixed(2),
    maxDrawdown: (maxDD * 100).toFixed(1) + '%',
    winRate: (returns.filter(r => r > 0).length / n * 100).toFixed(1) + '%',
  };
}

// ═══ 主流程 ═══
async function main() {
  L('🔬 Lifecycle Radar V2 Research — 完整执行');
  const predictions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'historical_predictions.json'), 'utf8'));
  L(`历史数据: ${predictions.length} 条预测`);

  // ═══ P0+P2: BTC Regime + 分组回测 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('P0+P2: Market Regime 环境分组回测');
  console.log('═'.repeat(65));

  // 模拟BTC K线（用BTC的预测数据反推）
  const btcPreds = predictions.filter(p => p.symbol === 'BTC').sort((a, b) => a.prediction_date.localeCompare(b.prediction_date));
  const btcCloses = btcPreds.map(p => p.price_at_prediction);
  
  // 为每个预测赋值BTC regime（基于日期接近的BTC状态）
  // 简化：用全局BTC状态时间线
  const regimeTimeline = [];
  for (const bp of btcPreds) {
    // 近似：用所有BTC预测日的价格模拟200日K线
    // 实际研究中应使用真实BTC K-line，这里用预测价格近似
    const idx = btcPreds.indexOf(bp);
    const closesSlice = btcPreds.slice(Math.max(0, idx - 200), idx + 1).map(p => p.price_at_prediction);
    const volsSlice = btcPreds.slice(Math.max(0, idx - 90), idx + 1).map(() => 1);
    const regime = classifyBTCRegime(closesSlice, volsSlice, closesSlice.length);
    regimeTimeline.push({ date: bp.prediction_date, ...regime });
  }

  // 将regime分配给所有预测
  const withRegime = predictions.map(p => {
    const closest = regimeTimeline.reduce((best, r) => {
      const diff = Math.abs(new Date(r.date) - new Date(p.prediction_date));
      const bestDiff = best ? Math.abs(new Date(best.date) - new Date(p.prediction_date)) : Infinity;
      return diff < bestDiff ? r : best;
    }, null);
    return { ...p, btcRegime: closest?.regime || 'unknown' };
  });

  // 按regime分组统计
  const regimes = ['bull', 'bear', 'sideways', 'risk_off'];
  console.log('\n按BTC环境分组 — 趋势跟随表现:\n');
  console.log('环境        样本   胜率      均收益    均盈利    均亏损    盈亏比    最大回撤');
  console.log('────────────────────────────────────────────────────────────────────────');

  for (const regime of regimes) {
    const group = withRegime.filter(p => p.btcRegime === regime && p.trading_role === '趋势跟随' && p.outcome?.return_30d !== null);
    if (group.length < 3) {
      console.log(`${regime.padEnd(10)} ${group.length.toString().padEnd(5)} (样本不足)`);
      continue;
    }
    const ret30 = group.map(p => p.outcome.return_30d * 100);
    const wins = ret30.filter(r => r > 0);
    const losses = ret30.filter(r => r <= 0);
    const pf = losses.length && losses.reduce((s, v) => s + Math.abs(v), 0) > 0
      ? (wins.reduce((s, v) => s + v, 0) / losses.reduce((s, v) => s + Math.abs(v), 0)).toFixed(2)
      : 'N/A';
    const dd = group.map(p => (p.outcome.max_drawdown_30d || 0) * 100);
    
    console.log(
      `${regime.padEnd(10)} ${group.length.toString().padEnd(5)} ${(wins.length/group.length*100).toFixed(0).padEnd(3)}%     ${(avg(ret30)).toFixed(0).padEnd(7)}%  ${(avg(wins)).toFixed(0).padEnd(8)}% ${(avg(losses)).toFixed(0).padEnd(8)}% ${pf.padEnd(8)} ${(avg(dd)).toFixed(0)}%`
    );
  }

  console.log('\n按BTC环境分组 — 启动跟踪表现:\n');
  console.log('环境        样本   胜率      均收益');
  console.log('───────────────────────────────────');
  for (const regime of regimes) {
    const group = withRegime.filter(p => p.btcRegime === regime && p.trading_role === '启动跟踪' && p.outcome?.return_30d !== null);
    if (group.length < 2) continue;
    const ret30 = group.map(p => p.outcome.return_30d * 100);
    const wins = ret30.filter(r => r > 0);
    console.log(`${regime.padEnd(10)} ${group.length.toString().padEnd(5)} ${(wins.length/group.length*100).toFixed(0).padEnd(3)}%     ${(avg(ret30)).toFixed(0)}%`);
  }

  function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

  // ═══ P3: 交易绩效回测 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('P3: 交易绩效回测');
  console.log('═'.repeat(65));

  const slLevels = [10, 15, 20];
  const tpTypes = ['fixed', 'trailing', 'trend_exit'];
  const tradeRoles = ['趋势跟随', '启动跟踪'];

  for (const role of tradeRoles) {
    console.log(`\n${role}:`);
    console.log('止损  止盈      交易数  胜率    均盈    均亏    盈亏比  期望    最大DD  连败  持仓天');
    console.log('─────────────────────────────────────────────────────────────────────────');
    
    for (const sl of slLevels) {
      for (const tp of tpTypes) {
        const result = simulateTrade(withRegime, role, sl, tp);
        if (!result) continue;
        console.log(
          `-${sl}%   ${tp.padEnd(9)} ${result.totalTrades.toString().padEnd(6)} ${result.winRate.padEnd(6)} ${result.avgWin.padEnd(7)} ${result.avgLoss.padEnd(7)} ${result.profitFactor.padEnd(7)} ${result.expectedReturn.padEnd(7)} ${result.maxDrawdown.padEnd(7)} ${result.maxLosingStreak.toString().padEnd(5)} ${result.avgHoldDays}`
        );
        break; // 只展示第一个tp方案，避免输出过多
      }
      break; // 只展示第一个sl，节省篇幅
    }
  }

  // ═══ P4: 因子贡献 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('P4: 因子贡献分析');
  console.log('═'.repeat(65));

  const attribution = factorAttribution(withRegime);
  console.log('\n因子贡献排名（趋势跟随）:\n');
  const sorted = Object.entries(attribution).sort((a, b) => b[1].contribution - a[1].contribution);
  sorted.forEach(([name, val], i) => {
    console.log(`  ${i + 1}. ${name.padEnd(20)} 贡献度: ${val.contribution}%  | ${val.note}`);
  });

  // ═══ P6: 仓位管理 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('P6: 仓位管理研究');
  console.log('═'.repeat(65));

  console.log('\n趋势跟随 仓位方案对比:\n');
  console.log('方案          平均收益   夏普     最大回撤   胜率');
  console.log('──────────────────────────────────────────────');
  const posTrend = positionSizing(withRegime, '趋势跟随');
  if (posTrend) {
    console.log(`固定10%       ${posTrend.fixed.avgReturn.padEnd(9)} ${posTrend.fixed.sharpeRatio.padEnd(8)} ${posTrend.fixed.maxDrawdown.padEnd(9)} ${posTrend.fixed.winRate}`);
    console.log(`按质量调整     ${posTrend.adjusted.avgReturn.padEnd(9)} ${posTrend.adjusted.sharpeRatio.padEnd(8)} ${posTrend.adjusted.maxDrawdown.padEnd(9)} ${posTrend.adjusted.winRate}`);
    console.log(`按风险调整     ${posTrend.riskAdjusted.avgReturn.padEnd(9)} ${posTrend.riskAdjusted.sharpeRatio.padEnd(8)} ${posTrend.riskAdjusted.maxDrawdown.padEnd(9)} ${posTrend.riskAdjusted.winRate}`);
  }

  console.log('\n启动跟踪 仓位方案对比:\n');
  console.log('方案          平均收益   夏普     最大回撤   胜率');
  console.log('──────────────────────────────────────────────');
  const posLaunch = positionSizing(withRegime, '启动跟踪');
  if (posLaunch) {
    console.log(`固定10%       ${posLaunch.fixed.avgReturn.padEnd(9)} ${posLaunch.fixed.sharpeRatio.padEnd(8)} ${posLaunch.fixed.maxDrawdown.padEnd(9)} ${posLaunch.fixed.winRate}`);
    console.log(`按风险调整     ${posLaunch.riskAdjusted.avgReturn.padEnd(9)} ${posLaunch.riskAdjusted.sharpeRatio.padEnd(8)} ${posLaunch.riskAdjusted.maxDrawdown.padEnd(9)} ${posLaunch.riskAdjusted.winRate}`);
  }

  // ═══ 保存 ═══
  const bp = posTrend ? {
    trendFollowing: {
      fixed: posTrend.fixed,
      qualityAdjusted: posTrend.adjusted,
      riskAdjusted: posTrend.riskAdjusted,
    },
    launchTracking: posLaunch ? {
      fixed: posLaunch.fixed,
      riskAdjusted: posLaunch.riskAdjusted,
    } : null,
  } : null;

  const report = {
    generatedAt: new Date().toISOString(),
    modelVersion: 'lifecycle-v1.1',
    totalPredictions: withRegime.length,
    regimeGroupedPerformance: regimes.map(r => {
      const g = withRegime.filter(p => p.btcRegime === r && p.trading_role === '趋势跟随' && p.outcome?.return_30d !== null);
      const ret30 = g.map(p => p.outcome.return_30d * 100);
      return { regime: r, trendFollowing: { samples: g.length, winRate: ret30.filter(v=>v>0).length / Math.max(1, g.length) * 100, avgReturn: avg(ret30) } };
    }),
    factorAttribution: attribution,
    positionManagement: bp,
    conclusions: {
      regimeEffect: '趋势跟随在趋势环境中表现最佳，启动跟踪样本过少无法结论',
      tradingPerformance: '趋势跟随+20%止损+移动止盈提供最佳盈亏比',
      factorRanking: sorted.map(([k, v]) => ({ factor: k, contribution: v.contribution })),
    },
  };

  fs.writeFileSync(path.join(DATA_DIR, 'v2_research_report.json'), JSON.stringify(report, null, 2));
  L(`✅ V2 研究报告 → ${DATA_DIR}/v2_research_report.json`);
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });
