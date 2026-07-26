#!/usr/bin/env node
/**
 * V4 Factor Map — 逐个因子有效性测试
 * 不分箱优化，不调参，只输出统计事实
 */
const fs = require('fs');
const path = require('path');
const CACHE_DIR = path.join(__dirname, 'public', 'data', 'klines_cache');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [v4] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function pct(arr) { return arr.length ? (arr.filter(v=>v>0).length/arr.length*100).toFixed(1)+'%' : 'N/A'; }

// ═══ 从缓存K线提取因子+未来收益 ═══
function extractData(klines, symbol) {
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const n = klines.length;
  const rows = [];

  for (let i = 200; i < n - 90; i += 14) {
    const price = closes[i];
    if (price <= 0) continue;

    // === 因子计算（只用 i 之前的数据） ===
    const slice = (start, end) => klines.slice(Math.max(0, i - start), i + 1 - end);

    // F1: 价格位置
    const absLow = Math.min(...lows.slice(0, i + 1));
    const ath = Math.max(...highs.slice(0, i + 1));
    const priceVsLow = (price - absLow) / absLow;
    const priceVsATH = (price - ath) / ath;

    // F2: Higher Low（近60天低点趋势）
    const lows60 = [];
    for (let j = 60; j >= 5; j -= 5) {
      lows60.push(Math.min(...lows.slice(Math.max(0, i - j), i + 1)));
    }
    let hlCount = 0;
    for (let j = 1; j < lows60.length; j++) {
      if (lows60[j] > lows60[j-1] * 1.01) hlCount++;
    }
    const hasHigherLow = hlCount >= lows60.length * 0.4;

    // F3: 下跌衰竭（新低幅度递减）
    const recentLows = [];
    for (let j = i; j >= Math.max(0, i - 90); j--) {
      if (lows[j] < Math.min(...lows.slice(Math.max(0, j - 3), j))) recentLows.push(lows[j]);
    }
    let exhaustion = false;
    if (recentLows.length >= 2) {
      const magnitudes = [];
      for (let j = 1; j < recentLows.length; j++) {
        magnitudes.push((recentLows[j-1] - recentLows[j]) / recentLows[j-1]);
      }
      exhaustion = magnitudes[magnitudes.length - 1] < avg(magnitudes) * 0.6;
    }

    // F4: 波动收缩
    const tr = (j) => Math.max(highs[j]-lows[j], Math.abs(highs[j]-closes[j-1]), Math.abs(lows[j]-closes[j-1]));
    const atr14 = avg(Array.from({length: 14}, (_, k) => tr(i - k))) / price;
    const atr60 = avg(Array.from({length: 46}, (_, k) => tr(i - 14 - k))) / price;
    const volContracting = atr14 < atr60 * 0.8;

    // F5: 上涨量 vs 下跌量
    let upVol = 0, downVol = 0;
    for (let j = 1; j <= 30; j++) {
      const chg = closes[i - j + 1] - closes[i - j];
      if (chg > 0) upVol += vols[i - j + 1];
      else downVol += vols[i - j + 1];
    }
    const upDownVolRatio = downVol > 0 ? upVol / downVol : upVol > 0 ? 2 : 1;

    // F6: 创新低
    const newLow30 = Math.min(...lows.slice(i - 29, i + 1)) <= Math.min(...lows.slice(i - 59, i - 29)) * 0.95;

    // F7: 突破前高
    const priorHigh = Math.max(...highs.slice(i - 60, i - 14));
    const breakthrough = price > priorHigh * 1.03;

    // F8: 连续上涨
    let upDays = 0;
    for (let j = i; j > Math.max(0, i - 5); j--) {
      if (closes[j] > closes[j - 1]) upDays++; else break;
    }

    // F9: 横盘天数
    let rangeDays = 0;
    for (let j = i; j >= Math.max(0, i - 60); j--) {
      const r = (Math.max(...highs.slice(Math.max(0, j - 14), j + 1)) - Math.min(...lows.slice(Math.max(0, j - 14), j + 1))) / closes[j];
      if (r < 0.20) rangeDays++; else break;
    }

    // F10: 卖压（日均跌幅）
    let totalDown = 0, downCount = 0;
    for (let j = 1; j <= 20; j++) {
      const chg = (closes[i - j + 1] - closes[i - j]) / closes[i - j];
      if (chg < 0) { totalDown += Math.abs(chg); downCount++; }
    }
    const sellingPressure = downCount > 0 ? totalDown / downCount : 0;

    // F11: 距MA200（简单近似）
    const ma200 = avg(closes.slice(Math.max(0, i - 199), i + 1));
    const aboveMA200 = price > ma200;

    // === 未来收益 ===
    const ret7d = i + 7 < n ? (closes[i + 7] - price) / price : null;
    const ret30d = i + 30 < n ? (closes[i + 30] - price) / price : null;
    const maxProfit30 = i + 30 < n ? (Math.max(...highs.slice(i + 1, i + 31)) - price) / price : null;
    const maxLoss30 = i + 30 < n ? (Math.min(...lows.slice(i + 1, i + 31)) - price) / price : null;

    // BTC 环境（近似：用时间周期）
    const date = new Date(klines[i].time);
    const y = date.getFullYear(), m = date.getMonth();
    let regime = 'sideways';
    if ((y === 2025 && m >= 9) || (y === 2026 && m <= 3)) regime = 'bull';
    else if (y === 2025 && m >= 4 && m <= 8) regime = 'bear';

    rows.push({
      symbol, date: date.toISOString().slice(0, 10), price,
      // 因子
      priceVsLow, priceVsATH, hasHigherLow, exhaustion,
      volContracting, upDownVolRatio, newLow30, breakthrough,
      upDays, rangeDays, sellingPressure, aboveMA200,
      // 结果
      ret7d, ret30d, maxProfit30, maxLoss30,
      // 环境
      regime,
    });
  }
  return rows;
}

// ═══ 因子测试 ═══
function testFactor(rows, factorKey, isBool, regime, horizon) {
  let group;
  if (isBool) {
    group = rows.filter(r => r[factorKey] === true && r[regime] === (regime === 'all' ? r[regime] : regime) && r[`ret${horizon}d`] !== null);
  } else {
    const vals = rows.filter(r => r[`ret${horizon}d`] !== null).map(r => r[factorKey]);
    const med = median(vals);
    group = rows.filter(r => r[factorKey] > med && r[regime] === (regime === 'all' ? r[regime] : regime) && r[`ret${horizon}d`] !== null);
  }
  if (group.length < 20) return null;

  const rets = group.map(r => r[`ret${horizon}d`] * 100);
  const wins = rets.filter(r => r > 0);
  const tw = wins.reduce((s,v)=>s+v,0);
  const tl = Math.abs(rets.filter(r=>r<=0).reduce((s,v)=>s+v,0));
  const sorted = [...rets].sort((a,b)=>b-a);
  const wt10 = avg(sorted.slice(Math.ceil(sorted.length * 0.1)));

  return {
    samples: rets.length,
    winRate: pct(rets),
    pf: tl > 0 ? (tw/tl).toFixed(2) : 'N/A',
    medRet: median(rets).toFixed(1) + '%',
    avgRet: avg(rets).toFixed(1) + '%',
    maxDD: Math.min(...rets).toFixed(0) + '%',
    withoutTop10: wt10.toFixed(1) + '%',
  };
}

// ═══ 分类 ═══
function classify(results) {
  if (!results || results.length < 2) return { class: 'E', label: '样本不足' };
  const valid = results.filter(r => r && parseFloat(r.pf) > 1.5 && parseFloat(r.medRet) > 0);
  const envDependent = results.filter(r => r && parseFloat(r.pf) > 1.5);
  
  if (results.every(r => r && parseFloat(r.pf) > 1.5 && parseFloat(r.medRet) > 0))
    return { class: 'A', label: '稳定有效' };
  if (envDependent.length >= 2 && valid.length >= 1)
    return { class: 'B', label: '环境依赖' };
  if (results.some(r => r && parseFloat(r.pf) > 1.5))
    return { class: 'C', label: '状态描述(偶有效)' };
  return { class: 'D', label: '无统计优势' };
}

// ═══ 主流程 ═══
async function main() {
  L('V4 Factor Map — 逐个因子有效性测试');

  const cacheFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  L(`缓存: ${cacheFiles.length} 币种`);

  // 提取数据
  let allData = [];
  for (let ci = 0; ci < cacheFiles.length; ci++) {
    const sym = cacheFiles[ci].replace('.json', '');
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, cacheFiles[ci]), 'utf8'));
      if (!c.klines || c.klines.length < 300) continue;
      allData.push(...extractData(c.klines, sym));
    } catch(e) {}
    if ((ci + 1) % 100 === 0) L(`  提取 ${ci + 1}/${cacheFiles.length} | ${allData.length}条`);
  }
  L(`总数据: ${allData.length}条`);

  // ═══ 因子测试矩阵 ═══
  const factors = [
    { key: 'hasHigherLow', label: 'Higher Low', isBool: true },
    { key: 'breakthrough', label: '突破前高', isBool: true },
    { key: 'volContracting', label: '波动收缩', isBool: true },
    { key: 'exhaustion', label: '下跌衰竭', isBool: true },
    { key: 'newLow30', label: '创新低(反向)', isBool: false }, // false=未创新低
    { key: 'upDays', label: '连涨≥3天', isBool: false },
    { key: 'rangeDays', label: '横盘>20天', isBool: false },
    { key: 'sellingPressure', label: '卖压低(反向)', isBool: false },
    { key: 'upDownVolRatio', label: '涨量>跌量', isBool: false },
    { key: 'aboveMA200', label: '高于MA200', isBool: true },
    { key: 'priceVsLow', label: '距低点<100%', isBool: false },
  ];

  const regimes = ['all', 'bull', 'bear', 'sideways'];
  const horizon = 30;

  console.log('\n' + '═'.repeat(80));
  console.log('V4 因子有效性地图 (30日)');
  console.log('═'.repeat(80));

  console.log('\n因子                Bull              Bear              Sideways          All               分类');
  console.log('──────────────────────────────────────────────────────────────────────────────────────────');

  const factorMap = [];

  for (const f of factors) {
    const results = [];
    let row = f.label.padEnd(18);

    for (const regime of ['bull', 'bear', 'sideways']) {
      const r = testFactor(allData, f.key, f.isBool, regime, horizon);
      if (r) {
        results.push(r);
        const icon = parseFloat(r.pf) > 1.5 && parseFloat(r.medRet) > 0 ? '✅' : parseFloat(r.pf) > 1.0 ? '⚠️' : '❌';
        row += `${icon}${r.pf}/${r.medRet}`.padEnd(18);
      } else {
        row += '--'.padEnd(18);
      }
    }

    // all environments
    const allR = testFactor(allData, f.key, f.isBool, 'all', horizon);
    if (allR) results.push(allR);
    const cls = classify(results);
    row += cls.label.padEnd(16);

    console.log(row);
    factorMap.push({ factor: f.label, results, classification: cls });
  }

  // ═══ 分池测试 ═══
  const top30 = [...new Set(allData.map(r => r.symbol))].slice(0, 30);
  const top100 = [...new Set(allData.map(r => r.symbol))].slice(0, 100);
  
  console.log('\n' + '═'.repeat(80));
  console.log('分池测试 (Higher Low 因子)');
  console.log('═'.repeat(80));

  for (const [label, pool] of [['Top30', top30], ['Top100', top100], ['All300', null]]) {
    const data = pool ? allData.filter(r => pool.includes(r.symbol)) : allData;
    const r = testFactor(data, 'hasHigherLow', true, 'all', 30);
    if (r) {
      console.log(`${label.padEnd(10)} ${r.samples}样本 | 胜率${r.winRate} | PF=${r.pf} | 中位${r.medRet} | 无Top10:${r.withoutTop10}`);
    }
  }

  // ═══ 最终结论 ═══
  console.log('\n' + '═'.repeat(80));
  console.log('V4 Factor Map 结论');
  console.log('═'.repeat(80));

  const classes = {};
  factorMap.forEach(f => {
    const c = f.classification.class;
    if (!classes[c]) classes[c] = [];
    classes[c].push(f.factor);
  });

  for (const [cls, facts] of Object.entries(classes)) {
    const label = { A: '稳定有效', B: '环境依赖', C: '状态描述', D: '无统计优势', E: '样本不足' }[cls] || cls;
    console.log(`\n${cls}类 (${label}): ${facts.join(', ')}`);
  }

  const aCount = (classes['A'] || []).length;
  const totalFactors = factorMap.length;
  console.log(`\n有效因子: ${aCount}/${totalFactors} (${(aCount/totalFactors*100).toFixed(0)}%)`);

  // 保存
  fs.writeFileSync(path.join(DATA_DIR, 'v4_factor_map.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDataPoints: allData.length,
    factorMap: factorMap.map(f => ({
      factor: f.factor,
      class: f.classification.class,
      label: f.classification.label,
      bestRegime: f.results.reduce((best, r) => r && parseFloat(r.pf) > parseFloat(best?.pf || '0') ? r : best, null),
    })),
    recommendation: {
      keep: classes['A'] || [],
      keepForFilter: classes['B'] || [],
      deprecate: classes['D'] || [],
    },
    architecture: {
      layer1: 'BTC Regime → 选择策略',
      layer2: '策略 → 对应有效因子',
      layer3: '执行 → 入场+止损+仓位',
    },
  }, null, 2));
  L('✅ V4 因子地图已保存');
}

main().catch(e => { L('FAIL: ' + e.message); console.error(e); process.exit(1); });
