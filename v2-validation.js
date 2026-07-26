#!/usr/bin/env node
/**
 * Lifecycle Radar V2 — 验证脚本
 * 任务2-6 一体化输出。不动核心逻辑。
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [val] ${m}`); }

function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ 任务2: 收益来源审计 ═══
function profitAttribution(data, role) {
  const trades = data.filter(p => p.trading_role === role && p.outcome?.return_30d !== null);
  if (!trades.length) return null;

  const pnls = trades.map(p => p.outcome.return_30d * 100);
  const sorted = [...trades].sort((a,b) => (b.outcome.return_30d||0) - (a.outcome.return_30d||0));
  const top10 = sorted.slice(0, Math.min(10, sorted.length));
  const totalPnL = pnls.reduce((s,v)=>s+v,0);
  const top10Contribution = top10.reduce((s,p) => s + (p.outcome.return_30d||0)*100, 0) / totalPnL * 100;

  // 收益分布
  const buckets = { '<-50%':0, '-50~-20':0, '-20~0':0, '0~20':0, '20~50':0, '50~100':0, '100~500':0, '500+':0 };
  pnls.forEach(r => {
    if (r < -50) buckets['<-50%']++;
    else if (r < -20) buckets['-50~-20']++;
    else if (r < 0) buckets['-20~0']++;
    else if (r < 20) buckets['0~20']++;
    else if (r < 50) buckets['20~50']++;
    else if (r < 100) buckets['50~100']++;
    else if (r < 500) buckets['100~500']++;
    else buckets['500+']++;
  });

  // 连胜/连败
  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const pnl of pnls) {
    if (pnl > 0) { cw++; cl = 0; maxCW = Math.max(maxCW, cw); }
    else { cl++; cw = 0; maxCL = Math.max(maxCL, cl); }
  }

  const wins = pnls.filter(r => r > 0);
  const losses = pnls.filter(r => r <= 0);

  return {
    role,
    totalTrades: trades.length,
    totalPnL: totalPnL.toFixed(0) + '%',
    top10Contribution: top10Contribution.toFixed(1) + '%',
    maxSinglePnL: (Math.max(...pnls)).toFixed(0) + '%',
    maxSingleLoss: (Math.min(...pnls)).toFixed(0) + '%',
    avgReturn: avg(pnls).toFixed(0) + '%',
    medianReturn: median(pnls).toFixed(0) + '%',
    avgWin: avg(wins).toFixed(0) + '%',
    avgLoss: avg(losses).toFixed(0) + '%',
    winDistribution: buckets,
    maxConsecutiveWins: maxCW,
    maxConsecutiveLosses: maxCL,
    concentrationWarning: top10Contribution > 70 ? '⚠️ 高危：前10笔贡献>' + top10Contribution.toFixed(0) + '%' : top10Contribution > 50 ? '⚠️ 注意：前10笔贡献过半' : '✅ 收益分散良好',
  };
}

// ═══ 任务3: Walk Forward 测试 ═══
function walkForward(data, role) {
  const trades = data.filter(p => p.trading_role === role && p.outcome?.return_30d !== null)
    .sort((a,b) => a.prediction_date.localeCompare(b.prediction_date));
  if (trades.length < 20) return null;

  const windows = [];
  // 找到数据的时间边界
  const dates = trades.map(t => t.prediction_date).sort();
  const firstDate = new Date(dates[0]);
  const lastDate = new Date(dates[dates.length - 1]);
  const totalDays = (lastDate - firstDate) / 86400000;

  // 分3个窗口
  const windowSize = Math.floor(totalDays / 3);
  for (let w = 0; w < 3; w++) {
    const wStart = new Date(firstDate.getTime() + w * windowSize * 86400000);
    const wEnd = new Date(firstDate.getTime() + (w + 1) * windowSize * 86400000);
    const segment = trades.filter(t => {
      const d = new Date(t.prediction_date);
      return d >= wStart && d < wEnd;
    });
    if (segment.length < 3) continue;

    const rets = segment.map(t => t.outcome.return_30d * 100);
    const wins = rets.filter(r => r > 0);

    // 简单夏普
    const avgRet = avg(rets);
    const variance = rets.reduce((s,v) => s + (v-avgRet)**2, 0) / rets.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (avgRet / std) : 0;

    // 最大回撤
    let cum = 0, peak = 0, maxDD = 0;
    for (const r of rets) { cum += r; if (cum > peak) peak = cum; const dd = (peak - cum) / (peak||1); if (dd > maxDD) maxDD = dd; }

    windows.push({
      period: `${wStart.toISOString().slice(0,10)} → ${wEnd.toISOString().slice(0,10)}`,
      signals: segment.length,
      winRate: (wins.length / segment.length * 100).toFixed(1) + '%',
      avgReturn: avgRet.toFixed(0) + '%',
      sharpe: sharpe.toFixed(2),
      maxDrawdown: (maxDD * 100).toFixed(1) + '%',
    });
  }

  // 稳定性检查
  const winRates = windows.map(w => parseFloat(w.winRate));
  const winRateStd = Math.sqrt(winRates.reduce((s,v) => s + (v-avg(winRates))**2, 0) / winRates.length);
  const stable = winRateStd < 15;

  return { windows, stable, note: stable ? '✅ 各时间段表现稳定' : `⚠️ 胜率波动${winRateStd.toFixed(1)}%，不稳定` };
}

// ═══ 任务4: BTC环境过滤 ═══
function btcRegimeFilter(data, role) {
  const trades = data.filter(p => p.trading_role === role && p.outcome?.return_30d !== null);
  if (!trades.length) return null;

  // 基于BTC预测的价格做近似regime分类
  // 用整体BTC趋势而非逐日判断
  const btcPreds = data.filter(p => p.symbol === 'BTC' && p.outcome?.return_30d !== null)
    .sort((a,b) => a.prediction_date.localeCompare(b.prediction_date));
  
  // 按季度分BTC环境
  const quarters = {};
  for (const bp of btcPreds) {
    const d = new Date(bp.prediction_date);
    const q = `${d.getFullYear()}-Q${Math.floor(d.getMonth()/3)+1}`;
    if (!quarters[q]) quarters[q] = [];
    quarters[q].push(bp.outcome.return_30d);
  }

  // 标记每个季度BTC状态
  const qLabels = {};
  for (const [q, rets] of Object.entries(quarters)) {
    const qRet = avg(rets) * 100;
    if (qRet > 15) qLabels[q] = 'bull';
    else if (qRet < -10) qLabels[q] = 'bear';
    else qLabels[q] = 'sideways';
  }

  // 分组统计
  const groups = { bull: [], bear: [], sideways: [] };
  for (const t of trades) {
    const d = new Date(t.prediction_date);
    const q = `${d.getFullYear()}-Q${Math.floor(d.getMonth()/3)+1}`;
    const regime = qLabels[q] || 'unknown';
    if (groups[regime]) groups[regime].push(t.outcome.return_30d * 100);
  }

  const result = {};
  for (const [r, rets] of Object.entries(groups)) {
    if (rets.length < 2) continue;
    const wins = rets.filter(v => v > 0);
    result[r] = {
      samples: rets.length,
      winRate: (wins.length / rets.length * 100).toFixed(1) + '%',
      avgReturn: avg(rets).toFixed(0) + '%',
      maxDD: Math.min(...rets).toFixed(0) + '%',
    };
  }

  const recommendation = [];
  if (result.bull && parseFloat(result.bull.winRate) > 50) recommendation.push('bull环境适合交易');
  if (result.bear && parseFloat(result.bear.winRate) < 40) recommendation.push('⚠ bear环境建议降低仓位或暂停');
  if (result.sideways && parseFloat(result.sideways.winRate) < 45) recommendation.push('sideways环境谨慎参与');

  return { result, recommendation };
}

// ═══ 任务5: 资金曲线 ═══
function equityCurve(data, role, positionPct) {
  const trades = data.filter(p => p.trading_role === role && p.outcome?.return_30d !== null)
    .sort((a,b) => a.prediction_date.localeCompare(b.prediction_date));
  if (!trades.length) return null;

  const position = positionPct / 100;
  let equity = 100000;
  const curve = [{ trade: 0, equity: 100000 }];
  let peak = 100000, maxDD = 0;

  const returns = [];
  for (let i = 0; i < trades.length; i++) {
    const ret = (trades[i].outcome.return_30d || 0) * position;
    equity *= (1 + ret);
    returns.push(ret);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
    if (i % Math.max(1, Math.floor(trades.length / 25)) === 0) {
      curve.push({ trade: i + 1, equity: Number(equity.toFixed(0)) });
    }
  }
  curve.push({ trade: trades.length, equity: Number(equity.toFixed(0)) });

  const totalRet = (equity / 100000 - 1) * 100;
  const annualRet = totalRet / (trades.length * 30 / 365); // 近似年化
  const avgRet = avg(returns) * 100;
  const std = Math.sqrt(returns.reduce((s,v) => s + (v - avgRet/100) ** 2, 0) / returns.length);
  const sharpe = std > 0 ? (avgRet / 100 / std) * Math.sqrt(365 / 30) : 0;

  return {
    positionPct: positionPct + '%',
    trades: trades.length,
    finalEquity: Number(equity.toFixed(0)),
    totalReturn: totalRet.toFixed(1) + '%',
    annualizedReturn: annualRet.toFixed(1) + '%',
    sharpe: sharpe.toFixed(2),
    maxDrawdown: (maxDD * 100).toFixed(1) + '%',
    curve: curve.filter((_,i) => i % Math.max(1, Math.floor(curve.length/10)) === 0),
  };
}

// ═══ 主流程 ═══
async function main() {
  L('🔬 Lifecycle Radar V2 验证');
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'historical_predictions.json'), 'utf8'));
  const roles = ['趋势跟随', '启动跟踪'];

  // ═══ 任务2: 收益来源审计 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('任务2: 收益来源审计 (Profit Attribution)');
  console.log('═'.repeat(65));

  for (const role of roles) {
    const attr = profitAttribution(data, role);
    if (!attr) continue;
    console.log(`\n${role}:`);
    console.log(`  总交易: ${attr.totalTrades} | 总收益: ${attr.totalPnL}`);
    console.log(`  前10笔贡献: ${attr.top10Contribution} | ${attr.concentrationWarning}`);
    console.log(`  最大单笔: +${attr.maxSinglePnL} / ${attr.maxSingleLoss}`);
    console.log(`  均收益: ${attr.avgReturn} | 中位收益: ${attr.medianReturn}`);
    console.log(`  均盈: ${attr.avgWin} | 均亏: ${attr.avgLoss}`);
    console.log(`  最大连胜: ${attr.maxConsecutiveWins} | 最大连败: ${attr.maxConsecutiveLosses}`);
    console.log(`  收益分布: ${JSON.stringify(attr.winDistribution)}`);
  }

  // ═══ 任务3: Walk Forward ═══
  console.log('\n' + '═'.repeat(65));
  console.log('任务3: Walk Forward 测试');
  console.log('═'.repeat(65));

  for (const role of roles) {
    const wf = walkForward(data, role);
    if (!wf) continue;
    console.log(`\n${role} (${wf.note}):`);
    console.log('  时间段                    信号   胜率     均收益   夏普    最大DD');
    console.log('  ──────────────────────────────────────────────────────');
    for (const w of wf.windows) {
      console.log(`  ${w.period.padEnd(24)} ${w.signals.toString().padEnd(5)} ${w.winRate.padEnd(7)} ${w.avgReturn.padEnd(8)} ${w.sharpe.padEnd(7)} ${w.maxDrawdown}`);
    }
  }

  // ═══ 任务4: BTC环境过滤 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('任务4: BTC环境过滤');
  console.log('═'.repeat(65));

  for (const role of roles) {
    const btc = btcRegimeFilter(data, role);
    if (!btc) continue;
    console.log(`\n${role} 按BTC环境: `);
    console.log('  环境        样本   胜率     均收益   最大DD');
    console.log('  ──────────────────────────────────────');
    for (const [r, s] of Object.entries(btc.result)) {
      console.log(`  ${r.padEnd(10)} ${s.samples.toString().padEnd(5)} ${s.winRate.padEnd(7)} ${s.avgReturn.padEnd(8)} ${s.maxDD}`);
    }
    if (btc.recommendation.length) {
      console.log('  建议:');
      btc.recommendation.forEach(r => console.log('    ' + r));
    }
  }

  // ═══ 任务5: 资金曲线 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('任务5: 模拟资金曲线');
  console.log('═'.repeat(65));

  const positions = [5, 10, 20];
  for (const role of roles) {
    console.log(`\n${role} (初始$100,000):`);
    console.log('  仓位    交易    最终资金    总收益    年化     夏普    最大DD');
    console.log('  ──────────────────────────────────────────────────────────');
    for (const pct of positions) {
      const eq = equityCurve(data, role, pct);
      if (!eq) continue;
      console.log(`  ${pct.toString().padEnd(5)}%  ${eq.trades.toString().padEnd(6)} $${(eq.finalEquity/1000).toFixed(0)}K     ${eq.totalReturn.padEnd(8)} ${eq.annualizedReturn.padEnd(8)} ${eq.sharpe.padEnd(7)} ${eq.maxDrawdown}`);
    }
  }

  // ═══ 任务6: 过拟合判定 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('任务6: 过拟合风险评估');
  console.log('═'.repeat(65));

  const trendAttr = profitAttribution(data, '趋势跟随');
  const trendWF = walkForward(data, '趋势跟随');

  const checks = [];
  
  // 检查1: 收益集中度
  if (trendAttr) {
    const conc = parseFloat(trendAttr.top10Contribution);
    checks.push({ check: '收益集中度(前10笔)', status: conc > 70 ? 'FAIL' : conc > 50 ? 'WARN' : 'PASS', value: trendAttr.top10Contribution });
  }

  // 检查2: Walk Forward稳定性
  if (trendWF) {
    checks.push({ check: '时间稳定性', status: trendWF.stable ? 'PASS' : 'WARN', value: trendWF.note });
  }

  // 检查3: 均收益vs中位收益
  if (trendAttr) {
    const avgR = parseFloat(trendAttr.avgReturn);
    const medR = parseFloat(trendAttr.medianReturn);
    const ratio = medR > 0 ? avgR / medR : 999;
    checks.push({ check: '均值/中位比', status: ratio > 3 ? 'FAIL' : ratio > 1.5 ? 'WARN' : 'PASS', value: ratio.toFixed(1) + 'x' });
  }

  // 检查4: 样本数量
  const trendSamples = data.filter(p => p.trading_role === '趋势跟随' && p.outcome?.return_30d !== null).length;
  checks.push({ check: '样本数量(>50)', status: trendSamples > 50 ? 'PASS' : 'WARN', value: trendSamples + ' 条' });

  // 检查5: 盈亏比
  if (trendAttr) {
    const avgW = parseFloat(trendAttr.avgWin);
    const avgL = Math.abs(parseFloat(trendAttr.avgLoss));
    const pf = avgL > 0 ? avgW / avgL : 99;
    checks.push({ check: '盈亏比(>2)', status: pf > 2 ? 'PASS' : pf > 1.5 ? 'WARN' : 'FAIL', value: pf.toFixed(2) });
  }

  console.log('\n检查项目              结果    数值');
  console.log('──────────────────────────────────────');
  checks.forEach(c => console.log(`${c.check.padEnd(22)} ${(c.status==='PASS'?'✅':c.status==='WARN'?'⚠️ ':'❌').padEnd(7)} ${c.value}`));

  const fails = checks.filter(c => c.status === 'FAIL').length;
  const warns = checks.filter(c => c.status === 'WARN').length;
  const passes = checks.filter(c => c.status === 'PASS').length;

  console.log('\n过拟合风险: ' + (fails > 0 ? '❌ 高风险' : warns > 1 ? '⚠️ 中等风险，可进入有限实盘' : '✅ 低风险，可以进入实盘测试'));
  console.log('进入实盘建议: ' + (fails === 0 ? '✅ 可以，建议小仓位(<5%)开始' : '❌ 建议先修复FAIL项'));

  // ═══ 保存 ═══
  const report = {
    generatedAt: new Date().toISOString(),
    modelVersion: 'lifecycle-v1.1 (FROZEN)',
    profitAttribution: {
      趋势跟随: profitAttribution(data, '趋势跟随'),
      启动跟踪: profitAttribution(data, '启动跟踪'),
    },
    walkForward: {
      趋势跟随: walkForward(data, '趋势跟随'),
      启动跟踪: walkForward(data, '启动跟踪'),
    },
    btcRegime: {
      趋势跟随: btcRegimeFilter(data, '趋势跟随'),
      启动跟踪: btcRegimeFilter(data, '启动跟踪'),
    },
    equityCurves: {
      趋势跟随: [5,10,20].map(p => equityCurve(data, '趋势跟随', p)).filter(Boolean),
      启动跟踪: [5,10,20].map(p => equityCurve(data, '启动跟踪', p)).filter(Boolean),
    },
    overfittingRisk: { checks, fails, warns, passes, verdict: fails > 0 ? 'HIGH_RISK' : warns > 1 ? 'MODERATE' : 'LOW' },
  };

  fs.writeFileSync(path.join(DATA_DIR, 'v2_validation_report.json'), JSON.stringify(report, null, 2));
  L(`✅ 验证报告 → ${DATA_DIR}/v2_validation_report.json`);
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
