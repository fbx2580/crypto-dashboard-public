#!/usr/bin/env node
/**
 * Lifecycle Radar V3 — 领先因子研究
 * 
 * 核心问题：100%+ 大涨之前，发生了什么？
 * 方法：从缓存K线找所有大涨案例，分析前30/60天状态
 */
const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, 'public', 'data', 'klines_cache');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [v3] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ 找大涨案例并分析前状态 ═══
function findBigMoves(klines, symbol) {
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const n = klines.length;
  const moves = [];

  for (let i = 200; i < n - 30; i++) {
    const future30 = closes[i + 29]; // 30天后收盘
    const futureMax = Math.max(...highs.slice(i, i + 30));
    const futureMin = Math.min(...lows.slice(i, i + 30));
    const price = closes[i];
    const ret30 = (future30 - price) / price;
    const maxGain = (futureMax - price) / price;
    const maxLoss = (futureMin - price) / price;

    // 大涨100%+
    const isBigWin = maxGain > 1.0;
    // 大跌50%+（对比组）
    const isBigLoss = maxLoss < -0.50;

    if (isBigWin || isBigLoss) {
      // === 分析前60天状态 ===
      const pre60 = klines.slice(Math.max(0, i - 60), i + 1);
      const preCloses = pre60.map(k => k.close);
      const preHighs = pre60.map(k => k.high);
      const preLows = pre60.map(k => k.low);
      const preVols = pre60.map(k => k.volume);
      const preN = pre60.length;
      const prePrice = preCloses[preN - 1];

      // === 领先因子 ===

      // 1. Higher Low 结构（低点抬高）
      const recentLows = [];
      for (let j = 60; j >= 15; j--) {
        const seg = lows.slice(Math.max(0, i - j - 5), Math.min(i, i - j + 5));
        if (seg.length >= 3) recentLows.push(Math.min(...seg));
      }
      recentLows.reverse();
      let higherLowCount = 0, lowerLowCount = 0;
      for (let j = 1; j < recentLows.length; j++) {
        if (recentLows[j] > recentLows[j-1] * 1.02) higherLowCount++;
        else if (recentLows[j] < recentLows[j-1] * 0.98) lowerLowCount++;
      }
      const hasHigherLow = higherLowCount > lowerLowCount;

      // 2. 下跌衰竭（新低幅度减少）
      const lows60 = preLows.slice(-60);
      const newLowMagnitudes = [];
      for (let j = 1; j < lows60.length; j++) {
        if (lows60[j] < lows60[j - 1]) {
          newLowMagnitudes.push((lows60[j - 1] - lows60[j]) / lows60[j - 1]);
        }
      }
      const declineExhaustion = newLowMagnitudes.length >= 2 &&
        newLowMagnitudes[newLowMagnitudes.length - 1] < avg(newLowMagnitudes) * 0.7;

      // 3. 波动收缩（前30天 vs 前60-30天）
      const atr30 = (() => {
        const trs = [];
        for (let j = 1; j < Math.min(30, preN); j++) {
          trs.push(Math.max(preHighs[preN - j] - preLows[preN - j],
            Math.abs(preHighs[preN - j] - preCloses[preN - j - 1]),
            Math.abs(preLows[preN - j] - preCloses[preN - j - 1])));
        }
        return avg(trs) / (prePrice || 1);
      })();
      const atrPrior = (() => {
        const trs = [];
        for (let j = 30; j < Math.min(60, preN); j++) {
          trs.push(Math.max(preHighs[preN - j] - preLows[preN - j],
            Math.abs(preHighs[preN - j] - preCloses[preN - j - 1]),
            Math.abs(preLows[preN - j] - preCloses[preN - j - 1])));
        }
        return avg(trs) / (prePrice || 1);
      })();
      const volContracting = atr30 < atrPrior * 0.85;

      // 4. 成交量：上涨量 vs 下跌量
      let upVol = 0, downVol = 0, upDays = 0, downDays = 0;
      for (let j = 1; j < Math.min(30, preN); j++) {
        const change = preCloses[preN - j] - preCloses[preN - j - 1];
        const vol = preVols[preN - j];
        if (change > 0) { upVol += vol; upDays++; }
        else { downVol += vol; downDays++; }
      }
      const upDownVolRatio = downVol > 0 ? upVol / downVol : 1;
      const upVolConcentration = upDays > 0 && downDays > 0 ? (upVol / upDays) / (downVol / downDays) : 1;

      // 5. 卖压：近30天下跌日的平均跌幅
      let totalDownPct = 0, downCount = 0;
      for (let j = 1; j < Math.min(30, preN); j++) {
        const chg = (preCloses[preN - j] - preCloses[preN - j - 1]) / preCloses[preN - j - 1];
        if (chg < 0) { totalDownPct += Math.abs(chg); downCount++; }
      }
      const avgDownPct = downCount > 0 ? totalDownPct / downCount : 0;

      // 6. 横盘天数（振幅<20%的连续天数）
      let rangeDays = 0;
      for (let j = preN - 1; j >= 0; j--) {
        const range30 = (Math.max(...preHighs.slice(Math.max(0, j - 29), j + 1)) -
          Math.min(...preLows.slice(Math.max(0, j - 29), j + 1))) / preCloses[j];
        if (range30 < 0.25) rangeDays++; else break;
      }

      // 7. 距前高跌幅
      const prior60High = Math.max(...preHighs.slice(0, Math.max(0, preN - 30)));
      const drawdownFromHigh = prior60High > 0 ? (prePrice - prior60High) / prior60High : 0;

      moves.push({
        symbol,
        date: new Date(klines[i].time).toISOString().slice(0, 10),
        type: isBigWin ? 'BIG_WIN' : 'BIG_LOSS',
        price, ret30, maxGain, maxLoss,
        // 领先因子
        hasHigherLow,
        higherLowCount,
        lowerLowCount,
        declineExhaustion,
        volContracting,
        upDownVolRatio,
        upVolConcentration,
        avgDownPct,
        rangeDays,
        drawdownFromHigh,
      });
    }
  }

  return moves;
}

// ═══ 主流程 ═══
async function main() {
  L('Lifecycle Radar V3 — 领先因子研究');

  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  L(`缓存: ${cacheFiles.length} 币种`);

  const allMoves = [];
  for (let ci = 0; ci < cacheFiles.length; ci++) {
    const sym = cacheFiles[ci].replace('.json', '');
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, cacheFiles[ci]), 'utf8'));
      if (!cached.klines || cached.klines.length < 230) continue;
      const moves = findBigMoves(cached.klines, sym);
      allMoves.push(...moves);
    } catch(e) {}
    if ((ci + 1) % 50 === 0) L(`  进度 ${ci + 1}/${cacheFiles.length} | ${allMoves.length}个案例`);
  }

  const bigWins = allMoves.filter(m => m.type === 'BIG_WIN');
  const bigLosses = allMoves.filter(m => m.type === 'BIG_LOSS');
  L(`大涨100%+: ${bigWins.length} | 大跌50%+: ${bigLosses.length}`);

  // ═══ 对比分析 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('大涨前 vs 大跌前 — 领先因子对比');
  console.log('═'.repeat(65));

  const factors = [
    { key: 'hasHigherLow', label: 'Higher Low结构', fmt: v => (v*100).toFixed(0)+'%' },
    { key: 'declineExhaustion', label: '下跌衰竭', fmt: v => (v*100).toFixed(0)+'%' },
    { key: 'volContracting', label: '波动收缩', fmt: v => (v*100).toFixed(0)+'%' },
    { key: 'upDownVolRatio', label: '上涨量/下跌量', fmt: v => v.toFixed(2)+'x' },
    { key: 'upVolConcentration', label: '上涨日量浓度', fmt: v => v.toFixed(2)+'x' },
    { key: 'avgDownPct', label: '平均日跌幅', fmt: v => (v*100).toFixed(1)+'%' },
    { key: 'rangeDays', label: '横盘天数', fmt: v => v.toFixed(0)+'天' },
    { key: 'drawdownFromHigh', label: '距前高跌幅', fmt: v => (v*100).toFixed(0)+'%' },
  ];

  console.log('\n因子                    大涨前(均值)   大跌前(均值)   差异度');
  console.log('─────────────────────────────────────────────────────────');
  const rankings = [];
  for (const f of factors) {
    const wv = bigWins.map(m => m[f.key]).filter(v => v !== null && !isNaN(v));
    const lv = bigLosses.map(m => m[f.key]).filter(v => v !== null && !isNaN(v));
    if (!wv.length || !lv.length) continue;
    const wAvg = avg(wv), lAvg = avg(lv);
    const diff = Math.abs(wAvg - lAvg);
    const sig = diff > Math.abs(lAvg) * 0.5 ? '★★★' : diff > Math.abs(lAvg) * 0.25 ? '★★' : '★';
    console.log(`${f.label.padEnd(24)} ${f.fmt(wAvg).padEnd(13)} ${f.fmt(lAvg).padEnd(13)} ${sig}`);
    rankings.push({ label: f.label, diff, sig, wAvg, lAvg });
  }
  rankings.sort((a,b) => b.diff - a.diff);

  // ═══ 分阶段分析 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('大涨前30天 vs 60天状态变化');
  console.log('═'.repeat(65));

  // 取大涨案例的前30天和前60天分开看
  const pre30Wins = bigWins.map(m => ({
    rangeDays: m.rangeDays, volContracting: m.volContracting,
    upDownVolRatio: m.upDownVolRatio, avgDownPct: m.avgDownPct,
  }));

  console.log('\n大涨案例前30天:');
  console.log(`  横盘中位: ${median(pre30Wins.map(m=>m.rangeDays)).toFixed(0)}天`);
  console.log(`  波动收缩: ${(pre30Wins.filter(m=>m.volContracting).length/bigWins.length*100).toFixed(0)}%`);
  console.log(`  涨量>跌量: ${(pre30Wins.filter(m=>m.upDownVolRatio>1).length/bigWins.length*100).toFixed(0)}%`);
  console.log(`  均日跌幅: ${avg(pre30Wins.map(m=>m.avgDownPct*100)).toFixed(1)}%`);

  // ═══ V3 设计建议 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('V3 领先因子排名');
  console.log('═'.repeat(65));

  console.log('\nTOP5 领先因子:');
  rankings.slice(0, 5).forEach((r, i) => {
    const wFmt = typeof r.wAvg === 'number' && r.wAvg < 1 ? (r.wAvg*100).toFixed(0)+'%' : r.wAvg.toFixed(2);
    console.log(`  ${i+1}. ${r.label.padEnd(20)} 大涨${wFmt} vs 大跌 — ${r.sig}`);
  });

  console.log('\nV3 模型建议:');
  console.log('  阶段A (准备): Higher Low确认 + 波动收缩 + 卖压减少');
  console.log('  阶段B (确认): 突破 + 回踩 + 上涨量 > 下跌量');
  console.log('  阶段C (趋势): 持仓管理');
  console.log('');
  console.log('  删除因子: MA20/60关系, 简单放量, 距ATH比例');
  console.log('  保留因子: Higher Low, 波动收缩, 涨跌量比, 卖压衰竭');
  console.log('  样本: 大涨' + bigWins.length + '例, 大跌' + bigLosses.length + '例');

  // 保存
  fs.writeFileSync(path.join(DATA_DIR, 'v3_leading_factors.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    bigWinCount: bigWins.length,
    bigLossCount: bigLosses.length,
    topFactors: rankings.slice(0, 5).map(r => ({ label: r.label, significance: r.sig })),
    v3Design: {
      phaseA: ['Higher Low确认', '波动收缩', '卖压减少(日均跌幅<2%)'],
      phaseB: ['突破+回踩不破', '上涨量>下跌量', '资金进入确认'],
      phaseC: ['趋势持仓管理'],
      delete: ['MA20/60交叉', '简单放量判断', '距ATH比例'],
      keep: ['Higher Low', '波动收缩', '涨跌量比', '卖压衰竭', '横盘天数'],
    },
  }, null, 2));
  L('✅ V3研究报告已保存');
}

main().catch(e => { L('FAIL: ' + e.message); process.exit(1); });
