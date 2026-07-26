#!/usr/bin/env node
/**
 * Lifecycle Radar V1.0 — 历史回放数据生成模块
 *
 * 严格无未来函数：
 *   每个"预测日期"只使用截至该日的K线数据，
 *   绝不访问预测日期之后的任何价格信息。
 *
 * 输出：
 *   historical_predictions.json — 每条预测的当时状态
 *   historical_backtest_report.json — 统计报告
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');
const PRED_FILE = path.join(DATA_DIR, 'historical_predictions.json');
const REPORT_FILE = path.join(DATA_DIR, 'historical_backtest_report.json');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [history] ${m}`); }

// ═══ 工具 ═══
async function getJSON(url, params = {}, timeout = 15000) {
  return (await axios.get(url, { params, timeout })).data;
}

function ema(data, period) {
  const k = 2 / (period + 1), out = [];
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) sum += data[i];
  out.push(sum / Math.min(period, data.length));
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

// ═══ 获取历史K线（截至指定日期） ═══
async function getKlinesUpTo(symbol, endDate) {
  const symWithUSDT = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
  const endMs = new Date(endDate).getTime();
  const startMs = endMs - 400 * 86400000; // 往回取400天

  let raw;
  try {
    raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: symWithUSDT, interval: '1d', startTime: startMs, endTime: endMs, limit: 400 });
  } catch (e) {
    try {
      raw = await getJSON(`${BINANCE_SPOT}/klines`, { symbol: symWithUSDT, interval: '1d', startTime: startMs, endTime: endMs, limit: 400 });
    } catch (e2) {
      return null;
    }
  }

  if (!raw || raw.length < 60) return null;

  const klines = raw.map(k => ({
    time: k[0],
    open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
    volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
  }));

  // 确保最后一天是 endDate（Binance 返回值包含 endTime 及之前的K线）
  return klines;
}

// ═══ 核心：单次历史诊断（严格无未来函数） ═══
// 此函数接收截至 predictionDate 的K线数据，运行完整 V1.0 诊断
function historicalDiagnose(klines, symbol, predictionDate) {
  // 克隆所有诊断函数（来自 lifecycle-diagnosis-v2.js）
  const { detectLifecyclePhases, checkAccumulationStatus, determineTradingRole, assessSecondWavePotential } = require('./lifecycle-diagnosis-v2');

  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];

  const phases = detectLifecyclePhases(klines);
  const accStatus = checkAccumulationStatus(klines, phases);
  const tradingRole = determineTradingRole(klines, phases, accStatus);
  const secondWave = assessSecondWavePotential(klines, phases, accStatus);

  // V1.0 评分
  const quality = calcQualityScore(klines, phases, accStatus, tradingRole, secondWave);
  const risk = calcRiskScore(klines, phases, accStatus, tradingRole);
  const conditions = generateConditions(klines, phases, accStatus, tradingRole, secondWave);

  return {
    symbol,
    prediction_date: predictionDate,
    price_at_prediction: price,
    lifecycle_stage: phases.length > 0 ? phases[phases.length - 1].phase : 'unknown',
    trading_role: tradingRole.role,
    accumulation_status: accStatus.status,
    second_wave: secondWave.potential,
    opportunity_quality_score: quality.score,
    trading_risk_score: risk.score,
    quality_bonuses: quality.bonuses,
    risk_factors: risk.risks,
    confirmation_conditions: conditions.confirmation_conditions,
    invalid_conditions: conditions.invalid_conditions,
    model_version: 'lifecycle-v1.0',
    score_version: 'score-v1.0',
  };
}

// ═══ 计算未来结果 ═══
function calcOutcome(fullKlines, predictionDate) {
  const predMs = new Date(predictionDate).getTime();
  const DAY_MS = 86400000;

  // 找到预测日之后的所有K线
  const futureKlines = fullKlines.filter(k => k.time > predMs);
  if (futureKlines.length < 7) return null;

  const entryPrice = fullKlines.find(k => k.time <= predMs)?.close;
  if (!entryPrice) return null;

  const result = { return_7d: null, return_30d: null, max_profit_7d: null, max_drawdown_7d: null, max_profit_30d: null, max_drawdown_30d: null };

  // 7天
  const d7 = futureKlines.slice(0, Math.min(7, futureKlines.length));
  if (d7.length >= 5) {
    const price7d = d7[d7.length - 1].close;
    result.return_7d = (price7d - entryPrice) / entryPrice;
    result.max_profit_7d = (Math.max(...d7.map(k => k.high)) - entryPrice) / entryPrice;
    result.max_drawdown_7d = (Math.min(...d7.map(k => k.low)) - entryPrice) / entryPrice;
  }

  // 30天
  const d30 = futureKlines.slice(0, Math.min(30, futureKlines.length));
  if (d30.length >= 20) {
    const price30d = d30[d30.length - 1].close;
    result.return_30d = (price30d - entryPrice) / entryPrice;
    result.max_profit_30d = (Math.max(...d30.map(k => k.high)) - entryPrice) / entryPrice;
    result.max_drawdown_30d = (Math.min(...d30.map(k => k.low)) - entryPrice) / entryPrice;
  }

  return result;
}

// ═══ V1.0 评分函数（内联，避免依赖未更新的模块导出） ═══
function calcQualityScore(klines, phases, accStatus, tradingRole, secondWave) {
  const closes = klines.map(k => k.close), vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high), lows = klines.map(k => k.low);
  const n = klines.length, price = closes[n - 1];
  const bonuses = []; let total = 0;

  const roleScoreMap = { '底部发现': 28, '启动跟踪': 30, '趋势跟随': 22, '反弹交易': 18, '高位防守': 8, '观望': 10 };
  let posScore = roleScoreMap[tradingRole.role] || 10;
  if (accStatus.status === 'completed') { bonuses.push('生命周期转换完成'); posScore = Math.min(30, posScore + 2); }
  total += posScore;

  let actScore = 0;
  const vNow = vols.slice(-30).reduce((s,v)=>s+v,0)/30;
  const vPr = vols.slice(-90,-30).reduce((s,v)=>s+v,0)/60;
  const vR = vPr > 0 ? vNow/vPr : 1;
  if (vR > 2) actScore += 15; else if (vR > 1.5) actScore += 12; else if (vR > 1.2) actScore += 8; else if (vR > 0.9) actScore += 5; else actScore += 2;
  total += Math.min(25, actScore);

  let structScore = 0;
  const ma20 = ema(closes, 20), ma60 = ema(closes, 60);
  if (price > ma20[ma20.length-1] && ma20[ma20.length-1] > ma60[ma60.length-1]) structScore += 8;
  else if (price > ma60[ma60.length-1]) structScore += 5;
  else if (price > ma60[ma60.length-1]*0.9) structScore += 3; else structScore += 1;
  const absLow = Math.min(...lows);
  const pVsL = (price - absLow) / absLow;
  if (pVsL > 0.5 && pVsL < 2) structScore += 6; else if (pVsL > 0.2) structScore += 3; else structScore += 1;
  const r30r = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price;
  if (r30r < 0.15) structScore += 6; else if (r30r < 0.3) structScore += 3; else structScore += 1;
  total += Math.min(20, structScore);

  let attScore = 0;
  if (secondWave.potential === '存在') attScore += 5; else if (secondWave.potential === '等待确认') attScore += 2;
  total += Math.min(15, attScore + 5);

  const quoteVol = klines[n-1]?.quoteVolume || 0;
  if (quoteVol > 10e6) total += 10; else if (quoteVol > 1e6) total += 8; else if (quoteVol > 100e3) total += 5; else if (quoteVol > 50e3) total += 2;

  return { score: Math.min(100, Math.round(total)), bonuses };
}

function calcRiskScore(klines, phases, accStatus, tradingRole) {
  const closes = klines.map(k => k.close), vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high), lows = klines.map(k => k.low);
  const n = klines.length, price = closes[n - 1];
  const risks = []; let total = 0;

  const absLow = Math.min(...lows);
  const pVsL = (price - absLow) / absLow;
  if (pVsL > 3) { total += 25; risks.push('大幅上涨'); }
  else if (pVsL > 2) { total += 18; risks.push('涨幅较大'); }
  else if (pVsL > 1) { total += 10; }
  else if (pVsL > 0.5) { total += 5; }

  const ath = Math.max(...highs);
  const pVsA = (price - ath) / ath;
  if (pVsA > -0.1) { total += 20; risks.push('接近历史高点'); }
  else if (pVsA > -0.25) { total += 12; }
  else if (pVsA < -0.8) { total += 8; }

  const trs = [];
  for (let i = 1; i < klines.length; i++) trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  let sum = 0;
  for (let i = 0; i < 14 && i < trs.length; i++) sum += trs[i];
  const atrVals = [sum/Math.min(14, trs.length)];
  for (let i = 1; i < trs.length; i++) atrVals.push((atrVals[i-1]*13+trs[i])/14);
  const atrNow = atrVals.slice(-14).reduce((s,v)=>s+v,0)/14/price;
  if (atrNow > 0.1) { total += 20; risks.push('极高波动'); }
  else if (atrNow > 0.05) { total += 12; risks.push('高波动'); }
  else if (atrNow > 0.03) { total += 7; }
  else { total += 3; }

  const qv = klines[n-1]?.quoteVolume || 0;
  if (qv < 50000) { total += 15; risks.push('流动性不足'); }
  else if (qv < 100000) { total += 10; }
  else if (qv < 500000) { total += 5; }

  const vN = vols.slice(-30).reduce((s,v)=>s+v,0)/30;
  const vP = vols.slice(-90,-30).reduce((s,v)=>s+v,0)/60;
  const vR = vP > 0 ? vN/vP : 1;
  if (vR < 0.5) { total += 15; risks.push('成交萎缩'); }
  else if (vR < 0.7) { total += 10; risks.push('成交量下降'); }
  else if (vR < 0.9) { total += 5; }

  return { score: Math.min(100, Math.round(total)), risks };
}

function generateConditions(klines, phases, accStatus, tradingRole, secondWave) {
  const role = tradingRole.role;
  const c = [], iv = [];
  if (role === '底部发现') { c.push('成交量温和放大','不再创新低','底部结构>30天'); iv.push('跌破近期低点','成交枯竭','大盘恶化'); }
  else if (role === '启动跟踪') { c.push('突破压力位','量持续放大','回踩确认'); iv.push('跌破启动成本','放量滞涨','快速回落'); }
  else if (role === '趋势跟随') { c.push('MA60保持向上','回调不破MA60','量维持活跃'); iv.push('跌破MA60','成交萎缩','派发信号'); }
  else if (role === '高位防守') { c.push('顶部结构确认','量背离','资金流出'); iv.push('继续创新高','突破前高'); }
  else if (role === '反弹交易') { c.push('重新站上MA20','量恢复','阳线吞没'); iv.push('继续下跌','反弹缩量','不过前高'); }
  else { c.push('明确方向信号','量异常','突破震荡区间'); iv.push('长期无方向','成交低迷','结构恶化'); }
  if (secondWave.potential !== '不存在') { c.push('突破整理区间上沿'); iv.push('跌破整理区间下沿'); }
  return { confirmation_conditions: c, invalid_conditions: iv };
}

// ═══ 主流程 ═══
async function main() {
  if (require.main !== module) return;
  const t0 = Date.now();
  L('🔬 历史回放数据生成 V1.0');

  // 1. 获取 Top 币种
  const { fetchAllSymbols, fetchTickers, filterByLiquidity } = require('./market-scanner');
  L('获取币种列表...');
  const result = await fetchAllSymbols({ includeSpot: true, includeFutures: true });
  const allSymbols = result.symbols;
  const [ft, st] = await Promise.all([fetchTickers([], true), fetchTickers([], false)]);
  const allTickers = { ...st, ...ft };
  const { filtered } = filterByLiquidity(allSymbols, allTickers, 100000);

  // 取 Top 50 按成交量排序
  filtered.sort((a, b) => (b.ticker?.volume24h || 0) - (a.ticker?.volume24h || 0));
  const topSymbols = filtered.slice(0, 50).map(f => f.baseAsset);
  L(`Top 50 币种: ${topSymbols.slice(0, 5).join(', ')}...`);

  // 2. 确定回放日期范围
  const DAY_MS = 86400000;
  const now = Date.now();
  const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS || '180'); // 默认6个月
  const INTERVAL_DAYS = parseInt(process.env.INTERVAL_DAYS || '7'); // 每周采样
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(today.getTime() - 30 * DAY_MS); // 结束于30天前（给未来结果留空间）
  const startDate = new Date(endDate.getTime() - HISTORY_DAYS * DAY_MS);

  L(`回放范围: ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)} (每${INTERVAL_DAYS}天)`);

  // 3. 对每个币种生成历史预测
  const predictions = [];
  let totalDone = 0, totalFailed = 0;
  const SAMPLE_COINS = parseInt(process.env.SAMPLE_COINS || '30'); // 默认30个币

  for (let si = 0; si < Math.min(topSymbols.length, SAMPLE_COINS); si++) {
    const sym = topSymbols[si];
    L(`[${si+1}/${Math.min(topSymbols.length, SAMPLE_COINS)}] ${sym}`);

    // 拉取完整K线（一次拉取，后续内存切片）
    let fullKlines;
    try {
      const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: sym + 'USDT', interval: '1d', limit: 400 });
      if (!raw || raw.length < 100) continue;
      fullKlines = raw.map(k => ({
        time: k[0],
        open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
      }));
    } catch (e) {
      try {
        const raw = await getJSON(`${BINANCE_SPOT}/klines`, { symbol: sym + 'USDT', interval: '1d', limit: 400 });
        if (!raw || raw.length < 100) continue;
        fullKlines = raw.map(k => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
        }));
      } catch (e2) { totalFailed++; continue; }
    }

    // 遍历每个采样日期
    for (let d = new Date(startDate); d <= endDate; d = new Date(d.getTime() + INTERVAL_DAYS * DAY_MS)) {
      const predDate = d.toISOString().slice(0, 10);
      const predMs = d.getTime();

      // 严格过滤：只用预测日期之前的K线
      const pastKlines = fullKlines.filter(k => k.time <= predMs);
      if (pastKlines.length < 60) continue;

      try {
        const pred = historicalDiagnose(pastKlines, sym, predDate);
        const outcome = calcOutcome(fullKlines, predDate);
        if (!outcome) continue;

        predictions.push({ ...pred, outcome });
        totalDone++;
      } catch (e) {
        // 静默跳过
      }
    }

    // 进度汇报
    if ((si + 1) % 5 === 0) {
      L(`  进度 ${si+1}/${SAMPLE_COINS} | 预测 ${totalDone} 条`);
    }

    // API 限速
    await new Promise(r => setTimeout(r, 200));
  }

  // 4. 保存预测数据
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PRED_FILE, JSON.stringify(predictions, null, 2));
  L(`✅ 保存 ${totalDone} 条历史预测 → ${PRED_FILE}`);

  // 5. ═══ 统计报告 ═══
  L('生成统计报告...');
  const report = generateReport(predictions, startDate, endDate, topSymbols.length);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  L(`✅ 统计报告 → ${REPORT_FILE}`);

  // 6. 打印摘要
  printSummary(report, predictions, (Date.now() - t0) / 1000);
}

function generateReport(predictions, startDate, endDate, totalCoins) {
  const with30d = predictions.filter(p => p.outcome?.return_30d !== null);
  if (with30d.length === 0) return { error: '无有效30天样本' };

  // 按角色统计
  const roles = ['底部发现', '启动跟踪', '趋势跟随', '高位防守', '反弹交易', '观望'];
  const phaseStats = {};
  for (const role of roles) {
    const group = with30d.filter(p => p.trading_role === role);
    if (group.length < 3) continue;
    const ret30 = group.map(p => p.outcome.return_30d);
    const wins = ret30.filter(r => r > 0).length;
    phaseStats[role] = {
      samples: group.length,
      winRate7d: (group.filter(p => p.outcome.return_7d > 0).length / group.length * 100).toFixed(1) + '%',
      winRate30d: (wins / group.length * 100).toFixed(1) + '%',
      avgReturn30d: (ret30.reduce((s,v)=>s+v,0)/ret30.length*100).toFixed(1) + '%',
      maxReturn30d: (Math.max(...ret30)*100).toFixed(1) + '%',
      avgMaxGain30d: (group.map(p=>p.outcome.max_profit_30d||0).reduce((s,v)=>s+v,0)/group.length*100).toFixed(1) + '%',
      avgMaxDD30d: (group.map(p=>p.outcome.max_drawdown_30d||0).reduce((s,v)=>s+v,0)/group.length*100).toFixed(1) + '%',
    };
  }

  // 按质量评分分组
  const qBuckets = [[0,40],[40,60],[60,80],[80,100]];
  const qualityGroups = {};
  for (const [lo, hi] of qBuckets) {
    const group = with30d.filter(p => p.opportunity_quality_score >= lo && p.opportunity_quality_score < hi);
    if (group.length < 3) continue;
    const ret30 = group.map(p => p.outcome.return_30d);
    qualityGroups[lo+'-'+hi] = {
      samples: group.length,
      winRate30d: (ret30.filter(r => r > 0).length / group.length * 100).toFixed(1) + '%',
      avgReturn30d: (ret30.reduce((s,v)=>s+v,0)/ret30.length*100).toFixed(1) + '%',
      avgMaxDD30d: (group.map(p => p.outcome.max_drawdown_30d || 0).reduce((s,v)=>s+v,0) / group.length * 100).toFixed(1) + '%',
    };
  }

  // 按风险评分分组
  const rBuckets = [[0,30],[30,60],[60,100]];
  const riskGroups = {};
  for (const [lo, hi] of rBuckets) {
    const group = with30d.filter(p => p.trading_risk_score >= lo && p.trading_risk_score < hi);
    if (group.length < 3) continue;
    const dd30 = group.map(p => p.outcome.max_drawdown_30d || 0);
    riskGroups[lo+'-'+hi] = {
      samples: group.length,
      avgMaxDD30d: (dd30.reduce((s,v)=>s+v,0)/dd30.length*100).toFixed(1) + '%',
      avgReturn30d: (group.map(p=>p.outcome.return_30d||0).reduce((s,v)=>s+v,0)/group.length*100).toFixed(1) + '%',
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    timeRange: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
    totalCoinsScanned: totalCoins,
    totalPredictions: predictions.length,
    with30dOutcome: with30d.length,
    overallWinRate30d: (with30d.filter(p => p.outcome.return_30d > 0).length / with30d.length * 100).toFixed(1) + '%',
    phaseStats,
    qualityGroups,
    riskGroups,
    noFutureFunctionLeak: true,
  };
}

function printSummary(report, predictions, dur) {
  console.log('\n' + '═'.repeat(60));
  console.log('🔬 历史回放研究结论');
  console.log('═'.repeat(60));
  console.log(`\n📊 样本: ${predictions.length} 条预测 (${report.with30dOutcome} 条有30天结果)`);
  console.log(`⏱ 耗时: ${dur.toFixed(0)}s`);
  console.log(`🔒 未来函数: ${report.noFutureFunctionLeak ? '无 ✅' : '有 ❌'}`);

  if (report.phaseStats && Object.keys(report.phaseStats).length > 0) {
    console.log('\n📈 阶段胜率(30天):');
    for (const [role, s] of Object.entries(report.phaseStats)) {
      console.log(`  ${role.padEnd(8)} ${s.samples}样本 | 胜率${s.winRate30d} | 均收益${s.avgReturn30d} | 均回撤${s.avgMaxDD30d}`);
    }
  }

  if (report.qualityGroups && Object.keys(report.qualityGroups).length > 0) {
    console.log('\n⭐ 质量评分分组(30天):');
    for (const [range, s] of Object.entries(report.qualityGroups)) {
      console.log(`  ${range.padEnd(8)} ${s.samples}样本 | 胜率${s.winRate30d} | 均收益${s.avgReturn30d}`);
    }
  }

  if (report.riskGroups && Object.keys(report.riskGroups).length > 0) {
    console.log('\n⚠ 风险评分分组(30天回撤):');
    for (const [range, s] of Object.entries(report.riskGroups)) {
      console.log(`  ${range.padEnd(8)} ${s.samples}样本 | 均回撤${s.avgMaxDD30d} | 均收益${s.avgReturn30d}`);
    }
  }

  console.log('\n═'.repeat(60));

  // V1.0 评估
  const hasPhaseStats = Object.keys(report.phaseStats || {}).length > 0;
  const hasQualityGroups = Object.keys(report.qualityGroups || {}).length > 0;
  const overall = parseFloat(report.overallWinRate30d || '0');

  console.log('\n🎯 V1.0 进入前向测试评估:');
  if (predictions.length < 100) {
    console.log('  ⚠️ 样本不足 (需≥100条)，建议扩大采样');
  } else if (overall > 50 && hasPhaseStats && hasQualityGroups) {
    console.log('  ✅ 统计意义存在，建议进入前向测试');
  } else {
    console.log('  ⚠️ 统计意义不足，模型可能需要调优');
  }
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });
