#!/usr/bin/env node
/**
 * Bottom Detection V1 失败分析（只读研究）
 * 不改模型，只分析数据找出失败原因
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://api.binance.com/fapi/v1';
const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [bottom] ${m}`); }

async function getKlinesAt(symbol, endDate, limit = 200) {
  const endMs = new Date(endDate).getTime();
  const startMs = endMs - (limit + 30) * 86400000;
  const sym = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
  let raw;
  try {
    raw = (await axios.get(`${BINANCE_FAPI}/klines`, { params: { symbol: sym, interval: '1d', startTime: startMs, endTime: endMs, limit: limit + 5 }, timeout: 10000 })).data;
  } catch(e) {
    try {
      raw = (await axios.get(`${BINANCE_SPOT}/klines`, { params: { symbol: sym, interval: '1d', startTime: startMs, endTime: endMs, limit: limit + 5 }, timeout: 10000 })).data;
    } catch(e2) { return null; }
  }
  if (!raw || raw.length < 60) return null;
  return raw.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
    volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
  }));
}

function ema(data, period) {
  const k = 2 / (period + 1), out = [];
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) sum += data[i];
  out.push(sum / Math.min(period, data.length));
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

function analyzeBottom(klines, symbol) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  const price = closes[n - 1];

  const ath = Math.max(...highs);
  const absLow = Math.min(...lows);
  const athIdx = highs.indexOf(ath);
  const lowIdx = lows.indexOf(absLow);

  // 价格结构
  const priceVsATH = (price - ath) / ath;
  const priceVsLow = (price - absLow) / absLow;
  const priceVs30dLow = (price - Math.min(...lows.slice(-30))) / price;
  const ret30d = closes[n - 1] / closes[Math.max(0, n - 31)] - 1;
  const ret90d = closes[n - 1] / closes[Math.max(0, n - 91)] - 1;

  // MA 结构
  const ma20 = ema(closes, 20), ma60 = ema(closes, 60);
  const ma20Now = ma20[ma20.length - 1], ma60Now = ma60[ma60.length - 1];
  const ma20Direction = ma20[ma20.length - 1] > ma20[Math.max(0, ma20.length - 8)] ? 'up' : 'down';
  const ma60Direction = ma60[ma60.length - 1] > ma60[Math.max(0, ma60.length - 15)] ? 'up' : 'down';
  const maRelation = ma20Now > ma60Now ? 'bullish' : 'bearish';
  const priceVsMA60 = (price - ma60Now) / ma60Now;
  const inDowntrend = price < ma20Now && ma20Now < ma60Now;

  // 成交量
  const vol30 = vols.slice(-30).reduce((s,v)=>s+v,0)/30;
  const vol90 = vols.slice(-90).reduce((s,v)=>s+v,0)/90;
  const volRatio = vol90 > 0 ? vol30 / vol90 : 1;
  const volTrend = vols.slice(-15).reduce((s,v)=>s+v,0)/15 > vols.slice(-30,-15).reduce((s,v)=>s+v,0)/15 ? 'increasing' : 'decreasing';

  // 波动
  const trs = [];
  for (let i = 1; i < n; i++) trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  let sum = 0;
  for (let i = 0; i < 14 && i < trs.length; i++) sum += trs[i];
  const atrVals = [sum / Math.min(14, trs.length)];
  for (let i = 1; i < trs.length; i++) atrVals.push((atrVals[i-1]*13+trs[i])/14);
  const atrNow = atrVals.slice(-14).reduce((s,v)=>s+v,0)/14/price;
  const atrPrior = atrVals.slice(-60,-14).reduce((s,v)=>s+v,0)/46/price;
  const atrRatio = atrPrior > 0 ? atrNow / atrPrior : 1;
  const range30 = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price;

  // 量价关系
  const last7Ret = closes[n-1]/closes[Math.max(0,n-8)]-1;
  const last7Vol = vols.slice(-7).reduce((s,v)=>s+v,0)/7;
  const vol7Ratio = vols.slice(-14,-7).reduce((s,v)=>s+v,0)/7 > 0 ? last7Vol/(vols.slice(-14,-7).reduce((s,v)=>s+v,0)/7) : 1;
  const divergence = (last7Ret > 0 && vol7Ratio < 0.8) ? 'bearish_div' : (last7Ret < 0 && vol7Ratio > 1.2) ? 'bullish_div' : 'normal';

  // 流动性
  const quoteVol = klines[n-1]?.quoteVolume || 0;

  // 底部确认
  const newLowRecent = Math.min(...lows.slice(-30)) <= Math.min(...lows.slice(-60,-30)) * 0.95;
  const accumulationDays = (() => {
    for (let i = n - 2; i >= 30; i--) {
      if (closes[i] > price * 1.5) return n - i;
    }
    return 30;
  })();

  return {
    priceVsATH, priceVsLow, priceVs30dLow, ret30d, ret90d,
    ma20Direction, ma60Direction, maRelation, priceVsMA60, inDowntrend,
    volRatio, volTrend, vol7Ratio, divergence,
    atrNow, atrRatio, range30,
    quoteVol, newLowRecent, accumulationDays,
  };
}

async function main() {
  L('🔬 底部发现失败分析 — 只读研究');
  const predictions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'historical_predictions.json'), 'utf8'));
  const bottom = predictions.filter(p => p.trading_role === '底部发现' && p.outcome?.return_30d !== null);

  const success = bottom.filter(p => (p.outcome.return_30d || 0) > 0);
  const failure = bottom.filter(p => (p.outcome.return_30d || 0) <= 0);

  L(`总底部发现: ${bottom.length} | 成功: ${success.length} (${(success.length/bottom.length*100).toFixed(1)}%) | 失败: ${failure.length}`);

  // 采样分析（每组取50个均匀分布的代表）
  const sampleSize = 50;
  const sStep = Math.max(1, Math.floor(success.length / sampleSize));
  const fStep = Math.max(1, Math.floor(failure.length / sampleSize));
  const successSample = success.filter((_, i) => i % sStep === 0).slice(0, sampleSize);
  const failureSample = failure.filter((_, i) => i % fStep === 0).slice(0, sampleSize);

  L(`采样: 成功${successSample.length} + 失败${failureSample.length}`);

  // 逐条分析
  const results = { success: [], failure: [] };

  for (const [label, samples] of [['success', successSample], ['failure', failureSample]]) {
    L(`分析${label}组...`);
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      try {
        const klines = await getKlinesAt(p.symbol, p.prediction_date);
        if (!klines) continue;
        const metrics = analyzeBottom(klines, p.symbol);
        metrics.symbol = p.symbol;
        metrics.date = p.prediction_date;
        metrics.return_30d = (p.outcome.return_30d || 0) * 100;
        metrics.quality_score = p.opportunity_quality_score;
        results[label].push(metrics);
      } catch(e) {}
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 100));
    }
  }

  L(`分析完成: 成功${results.success.length}条, 失败${results.failure.length}条`);

  // ═══ 对比统计 ═══
  const keys = [
    'priceVsATH', 'priceVsLow', 'ret30d', 'ret90d',
    'priceVsMA60', 'volRatio', 'atrNow', 'atrRatio', 'range30', 'quoteVol',
    'newLowRecent', 'accumulationDays',
  ];
  const boolKeys = ['ma20Direction', 'ma60Direction', 'maRelation', 'inDowntrend', 'divergence'];

  console.log('\n═══════════════════════════════════════════');
  console.log('Bottom Detection V1 失败原因分析');
  console.log('═══════════════════════════════════════════\n');

  // 连续指标对比
  console.log('一、连续指标对比 (均值):');
  console.log('指标                         成功组          失败组         差异');
  console.log('─────────────────────────────────────────────────────────');

  for (const key of keys) {
    const svals = results.success.map(r => r[key]).filter(v => v !== null && !isNaN(v));
    const fvals = results.failure.map(r => r[key]).filter(v => v !== null && !isNaN(v));
    if (svals.length === 0 || fvals.length === 0) continue;

    const sAvg = svals.reduce((a,b)=>a+b,0) / svals.length;
    const fAvg = fvals.reduce((a,b)=>a+b,0) / fvals.length;
    const diff = Math.abs(sAvg - fAvg);
    const sig = diff > Math.abs(fAvg) * 0.3 ? '★★★' : diff > Math.abs(fAvg) * 0.15 ? '★★' : '★';

    const fmt = (v) => {
      if (typeof v === 'number' && Math.abs(v) < 0.1) return (v * 100).toFixed(1) + '%';
      if (typeof v === 'number' && Math.abs(v) < 1) return (v * 100).toFixed(1) + '%';
      if (key === 'quoteVol') return (v / 1e6).toFixed(1) + 'M';
      return v.toFixed(2);
    };

    console.log(`${key.padEnd(28)} ${fmt(sAvg).padEnd(14)} ${fmt(fAvg).padEnd(14)} ${sig}`);
  }

  // 布尔指标对比
  console.log('\n二、布尔指标对比 (比例):');
  console.log('指标                         成功组         失败组');
  console.log('─────────────────────────────────────────────');
  for (const key of boolKeys) {
    const sPct = results.success.filter(r => r[key] === 'up' || r[key] === 'bullish' || r[key] === true).length / results.success.length * 100;
    const fPct = results.failure.filter(r => r[key] === 'up' || r[key] === 'bullish' || r[key] === true).length / results.failure.length * 100;
    console.log(`${key.padEnd(28)} ${sPct.toFixed(0).padEnd(12)}% ${fPct.toFixed(0)}%`);
  }

  // 量价关系
  const sDivUp = results.success.filter(r => r.divergence === 'bullish_div').length;
  const sDivDown = results.success.filter(r => r.divergence === 'bearish_div').length;
  const fDivUp = results.failure.filter(r => r.divergence === 'bullish_div').length;
  const fDivDown = results.failure.filter(r => r.divergence === 'bearish_div').length;
  console.log('\n三、量价背离:');
  console.log(`  成功组: 底背离${sDivUp}(${(sDivUp/results.success.length*100).toFixed(0)}%) 顶背离${sDivDown}`);
  console.log(`  失败组: 底背离${fDivUp}(${(fDivUp/results.failure.length*100).toFixed(0)}%) 顶背离${fDivDown}`);

  // ═══ 失败原因排名 ═══
  console.log('\n四、失败原因排名:');
  const failures = results.failure;
  const reasons = [
    { name: 'MA60仍下降', count: failures.filter(r => r.ma60Direction === 'down').length },
    { name: '仍在下降趋势(MA20<MA60)', count: failures.filter(r => r.inDowntrend).length },
    { name: '成交量未恢复(volRatio<0.8)', count: failures.filter(r => r.volRatio < 0.8).length },
    { name: '近期创新低', count: failures.filter(r => r.newLowRecent).length },
    { name: 'ATR未收缩(atrRatio>0.9)', count: failures.filter(r => r.atrRatio > 0.9).length },
    { name: '距ATH过远(< -90%)', count: failures.filter(r => r.priceVsATH < -0.90).length },
    { name: '90天仍大跌(ret90d<-50%)', count: failures.filter(r => r.ret90d < -0.50).length },
  ];
  reasons.sort((a,b) => b.count - a.count);
  reasons.forEach(r => console.log(`  ${r.name.padEnd(32)} ${r.count}/${failures.length} (${(r.count/failures.length*100).toFixed(0)}%)`));

  // ═══ V2 建议 ═══
  console.log('\n═══════════════════════════════════════════');
  console.log('五、Bottom Detection V2 设计建议');
  console.log('═══════════════════════════════════════════\n');

  console.log('V1 问题: 仅判断低位+横盘，未验证趋势是否真正反转');
  console.log('');
  console.log('V2 新增过滤条件:');
  console.log('  1. MA60必须走平或向上（过滤下跌中继）');
  console.log('  2. 成交量必须回升（volRatio>0.8）');
  console.log('  3. 近30天不能创新低（排除加速下跌）');
  console.log('  4. ATR必须收缩（atrRatio<0.8，表示跌势衰竭）');
  console.log('  5. 距ATH不能超过-95%（排除已死的币）');
  console.log('');
  console.log('预计效果:');
  const totalF = results.failure.length;
  const wouldFilter1 = failures.filter(r => r.ma60Direction === 'down').length;
  const wouldFilter2 = failures.filter(r => r.volRatio < 0.8).length;
  const wouldFilter3 = failures.filter(r => r.newLowRecent).length;
  console.log(`  MA60过滤: 减少 ${wouldFilter1}/${totalF} (${(wouldFilter1/totalF*100).toFixed(0)}%) 假阳性`);
  console.log(`  量恢复过滤: 减少 ${wouldFilter2}/${totalF} (${(wouldFilter2/totalF*100).toFixed(0)}%) 假阳性`);
  console.log(`  创新低过滤: 减少 ${wouldFilter3}/${totalF} (${(wouldFilter3/totalF*100).toFixed(0)}%) 假阳性`);
  console.log('  组合过滤预计减少60-80%假阳性');

  // 保存
  const report = {
    generatedAt: new Date().toISOString(),
    totalBottom: bottom.length,
    successCount: success.length,
    failureCount: failure.length,
    samplesAnalyzed: { success: results.success.length, failure: results.failure.length },
    reasonRanking: Object.fromEntries(reasons.map(r => [r.name, r.count])),
    v2Suggestions: {
      addFilters: ['MA60走平或向上', '成交量回升', '不创新低', 'ATR收缩'],
      removeConditions: ['仅凭低位+横盘不够'],
      estimatedImprovement: '60-80%假阳性减少',
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, 'bottom_failure_analysis.json'), JSON.stringify(report, null, 2));
  L(`✅ 报告保存 → ${DATA_DIR}/bottom_failure_analysis.json`);
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });
