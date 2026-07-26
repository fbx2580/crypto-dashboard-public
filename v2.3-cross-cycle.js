#!/usr/bin/env node
/**
 * Lifecycle Radar V2.3 — 全市场扩展验证
 * 目标：扩大样本，跨周期验证，回答"模型是否只适用于牛市"
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [v2.3] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

async function getJSON(url, params = {}, timeout = 10000) {
  return (await axios.get(url, { params, timeout })).data;
}

// ═══ 全市场 K线获取 ═══
async function fetchAllKlines(symbol, days = 730) {
  const sym = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
  try {
    const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: sym, interval: '1d', limit: days + 30 });
    if (!raw || raw.length < 100) return null;
    return raw.map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
      volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
    }));
  } catch(e) { return null; }
}

// ═══ V2.2 简化诊断（只用核心逻辑） ═══
function quickDiagnose(klines) {
  const n = klines.length;
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const price = closes[n - 1];

  // 简单 EMA
  function ema(d, p) {
    const k = 2/(p+1), o = [];
    let s = 0;
    for (let i = 0; i < p && i < d.length; i++) s += d[i];
    o.push(s / Math.min(p, d.length));
    for (let i = 1; i < d.length; i++) o.push(d[i]*k + o[i-1]*(1-k));
    return o;
  }

  const ma20 = ema(closes, 20), ma60 = ema(closes, 60);
  const ma60Now = ma60[ma60.length-1], ma60Prev = ma60[Math.max(0, ma60.length-30)];
  const absLow = Math.min(...lows), ath = Math.max(...highs);
  const priceVsLow = (price - absLow) / absLow;
  const priceVsATH = (price - ath) / ath;
  const vol30 = vols.slice(-30).reduce((s,v)=>s+v,0)/30;
  const vol90 = vols.slice(-90).reduce((s,v)=>s+v,0)/90;
  const volRatio = vol90 > 0 ? vol30 / vol90 : 1;
  const ret30 = closes[n-1]/closes[Math.max(0,n-31)]-1;

  // 角色判定（V2.2核心简化版）
  const inLowZone = priceVsLow < 2.0;
  const range30 = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price;
  const inRange = range30 < 0.40;
  const ma60Up = ma60Now >= ma60Prev;
  const ma60Flat = Math.abs(ma60Now - ma60Prev) / ma60Prev < 0.05;
  const trendOK = ma60Up || ma60Flat;
  const volOK = volRatio >= 0.6;

  // 启动检测
  const launchRet = closes[n-1]/closes[Math.max(0,n-14)]-1;
  const launchVol = vols.slice(-7).reduce((s,v)=>s+v,0)/7 / (vols.slice(-21,-7).reduce((s,v)=>s+v,0)/14 || 1);
  const isLaunch = launchRet > 0.15 && launchVol > 1.5;

  // 角色
  let role;
  if (inLowZone && inRange && trendOK && volOK) role = '底部观察';
  else if (isLaunch && price > ma60Now && volRatio > 1.0) role = '启动跟踪';
  else if (price > ma60Now && volRatio > 0.5 && ret30 > -0.05) role = '趋势跟随';
  else if (priceVsATH > -0.15 && price > ma60Now * 1.1) role = '高位防守';
  else role = '观望';

  return { role, price, absLow, priceVsLow, volRatio, ma60Up, ret30, dataDays: n };
}

// ═══ 周期分类 ═══
function classifyPeriod(dateStr) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = d.getMonth();
  if (y === 2022 || (y === 2023 && m < 3)) return '2022_bear';
  if (y === 2023 && m >= 3 && y === 2023 && m < 10) return '2023_recovery';
  if ((y === 2023 && m >= 10) || (y === 2024 && m < 6)) return '2024_bull_start';
  return '2025_current';
}

// ═══ 主流程 ═══
async function main() {
  L('🔬 Lifecycle Radar V2.3 — 全市场扩展验证');

  // 1. 获取全量合约列表
  L('获取合约列表...');
  let symbols = [];
  try {
    const info = await getJSON(`${BINANCE_FAPI}/exchangeInfo`);
    for (const s of (info.symbols || [])) {
      if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || s.contractType !== 'PERPETUAL') continue;
      const skip = new Set(['USDC','DAI','TUSD','BUSD','USDP','FDUSD','USDE']);
      if (skip.has(s.baseAsset)) continue;
      symbols.push(s.baseAsset);
    }
  } catch(e) { L('合约列表失败: '+e.message); process.exit(1); }

  L(`全量合约: ${symbols.length} 个`);

  // 2. 采样策略：按成交量取Top 100 + 均匀采样50
  // 先获取ticker排序
  let tickers = {};
  try {
    const raw = await getJSON(`${BINANCE_FAPI}/ticker/24hr`);
    for (const t of (raw || [])) tickers[t.symbol] = parseFloat(t.quoteVolume || 0);
  } catch(e) {}

  const scored = symbols.map(s => {
    const vol = tickers[s + 'USDT'] || 0;
    return { symbol: s, volume: vol };
  });
  scored.sort((a,b) => b.volume - a.volume);
  
  // Top 80 + 均匀采样20（共100个）
  const top80 = scored.slice(0, 80);
  const rest = scored.slice(80);
  const step = Math.max(1, Math.floor(rest.length / 20));
  const sampled = rest.filter((_,i) => i % step === 0).slice(0, 20);
  const targets = [...top80, ...sampled];
  
  L(`目标: ${targets.length} 个币种 (Top80 + 均匀20)`);

  // 3. 逐币分析
  const predictions = [];
  const INTERVAL = 14; // 14天采样
  const MAX_DAYS = 730;

  let done = 0, failed = 0;
  for (const t of targets) {
    const klines = await fetchAllKlines(t.symbol, MAX_DAYS);
    if (!klines) { failed++; continue; }

    const n = klines.length;
    // 从第200天开始采样（需要足够的MA数据）
    for (let i = 200; i < n - 35; i += INTERVAL) {
      const pastKlines = klines.slice(0, i + 1);
      const predDate = new Date(klines[i].time).toISOString().slice(0, 10);
      
      try {
        const diag = quickDiagnose(pastKlines);
        if (diag.role === '观望') continue; // 跳过观望

        const futureKlines = klines.slice(i + 1);
        const entryPrice = pastKlines[pastKlines.length - 1].close;

        // 7天结果
        const d7 = futureKlines.slice(0, 7);
        const r7d = d7.length >= 5 ? (d7[d7.length-1].close - entryPrice) / entryPrice : null;

        // 30天结果
        const d30 = futureKlines.slice(0, 30);
        const r30d = d30.length >= 20 ? (d30[d30.length-1].close - entryPrice) / entryPrice : null;

        // 60天结果
        const d60 = futureKlines.slice(0, 60);
        const r60d = d60.length >= 40 ? (d60[d60.length-1].close - entryPrice) / entryPrice : null;

        const maxProfit30 = d30.length > 0 ? (Math.max(...d30.map(k => k.high)) - entryPrice) / entryPrice : null;
        const maxDD30 = d30.length > 0 ? (Math.min(...d30.map(k => k.low)) - entryPrice) / entryPrice : null;

        predictions.push({
          symbol: t.symbol,
          prediction_date: predDate,
          price_at_prediction: entryPrice,
          role: diag.role,
          period: classifyPeriod(predDate),
          dataDays: diag.dataDays,
          outcome_7d: r7d,
          outcome_30d: r30d,
          outcome_60d: r60d,
          max_profit_30d: maxProfit30,
          max_drawdown_30d: maxDD30,
        });
      } catch(e) {}
    }

    done++;
    if (done % 10 === 0) L(`  进度 ${done}/${targets.length} | 预测 ${predictions.length} | 失败 ${failed}`);
    await new Promise(r => setTimeout(r, 150));
  }

  L(`完成: ${predictions.length} 条预测 (${done}币种/${failed}失败)`);

  if (predictions.length === 0) { L('❌ 无有效预测'); process.exit(0); }

  // 4. ═══ 按周期分组统计 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('任务1+2: 全市场扩展 + 周期拆分');
  console.log('═'.repeat(65));

  console.log(`\n总预测: ${predictions.length} | 币种: ${[...new Set(predictions.map(p=>p.symbol))].length}`);
  console.log(`时间范围: ${predictions[0]?.prediction_date} → ${predictions[predictions.length-1]?.prediction_date}`);

  const periods = ['2022_bear', '2023_recovery', '2024_bull_start', '2025_current'];
  const roleLabels = { '趋势跟随': 'Trend', '启动跟踪': 'Launch', '底部观察': 'Bottom' };

  console.log('\n跨周期表现:\n');
  console.log('周期            角色      样本   胜率30d  中位30d  PF30d   胜率60d  中位60d  最大DD');
  console.log('────────────────────────────────────────────────────────────────────────');

  for (const period of periods) {
    let first = true;
    for (const [role, label] of Object.entries(roleLabels)) {
      const group = predictions.filter(p => p.period === period && p.role === role && p.outcome_30d !== null);
      if (group.length < 5) continue;

      const ret30 = group.map(p => p.outcome_30d * 100);
      const ret60 = group.filter(p => p.outcome_60d !== null).map(p => p.outcome_60d * 100);
      const win30 = ret30.filter(r => r > 0);
      const win60 = ret60.filter(r => r > 0);
      const tw30 = win30.reduce((s,v)=>s+v,0);
      const tl30 = Math.abs(ret30.filter(r=>r<=0).reduce((s,v)=>s+v,0));
      const pf30 = tl30 > 0 ? (tw30/tl30).toFixed(2) : 'N/A';
      const dd30 = Math.min(...ret30).toFixed(0) + '%';

      const periodLabel = first ? period : '';
      console.log(
        `${periodLabel.padEnd(14)} ${label.padEnd(8)} ${group.length.toString().padEnd(6)} ${(win30.length/group.length*100).toFixed(0).padEnd(4)}%   ${median(ret30).toFixed(0).padEnd(5)}%  ${pf30.padEnd(7)} ${win60.length > 0 ? (win60.length/ret60.length*100).toFixed(0)+'%' : 'N/A'.padEnd(5)} ${ret60.length > 0 ? median(ret60).toFixed(0)+'%' : 'N/A'.padEnd(5)} ${dd30}`
      );
      first = false;
    }
  }

  // 5. ═══ 周期有效性判定 ═══
  console.log('\n' + '═'.repeat(65));
  console.log('V2.3 跨周期验证结论');
  console.log('═'.repeat(65));

  const trendAll = predictions.filter(p => p.role === '趋势跟随' && p.outcome_30d !== null);
  const trendPeriods = {};
  for (const p of trendAll) {
    if (!trendPeriods[p.period]) trendPeriods[p.period] = [];
    trendPeriods[p.period].push(p.outcome_30d * 100);
  }

  console.log('\n趋势跟随 跨周期:');
  let allPositive = true;
  for (const [period, rets] of Object.entries(trendPeriods)) {
    const ws = rets.filter(r => r > 0);
    const tw = ws.reduce((s,v)=>s+v,0);
    const tl = Math.abs(rets.filter(r=>r<=0).reduce((s,v)=>s+v,0));
    const pf = tl > 0 ? tw/tl : 99;
    const ok = pf > 1.5 && (ws.length/rets.length*100) > 45;
    if (!ok) allPositive = false;
    console.log(`  ${period}: ${rets.length}样本 | PF=${pf.toFixed(1)} | 胜率${(ws.length/rets.length*100).toFixed(0)}% | ${ok?'✅ 有效':'⚠️ 失效'}`);
  }

  console.log('\n2. 模型是否只适用于牛市？');
  if (allPositive) {
    console.log('  ✅ 跨周期有效。趋势跟随在所有周期PF>1.5');
  } else {
    console.log('  ⚠️ 部分周期失效。建议在失效周期降低仓位或暂停交易');
  }

  console.log('\n3. 最弱周期:');
  const worst = Object.entries(trendPeriods).sort((a,b) => {
    const aW = a[1].filter(r=>r>0);
    const aL = Math.abs(a[1].filter(r=>r<=0).reduce((s,v)=>s+v,0));
    const aPf = aL > 0 ? aW.reduce((s,v)=>s+v,0)/aL : 99;
    const bW = b[1].filter(r=>r>0);
    const bL = Math.abs(b[1].filter(r=>r<=0).reduce((s,v)=>s+v,0));
    const bPf = bL > 0 ? bW.reduce((s,v)=>s+v,0)/bL : 99;
    return aPf - bPf;
  })[0];
  if (worst) console.log(`  ${worst[0]}: 建议小仓位或暂停`);

  console.log(`\n4. 总覆盖: ${predictions.length}条预测 | ${[...new Set(predictions.map(p=>p.symbol))].length}币种`);

  // 保存
  const report = {
    generatedAt: new Date().toISOString(),
    totalPredictions: predictions.length,
    uniqueSymbols: [...new Set(predictions.map(p => p.symbol))].length,
    periodAnalysis: periods.map(period => {
      const group = predictions.filter(p => p.period === period && p.role === '趋势跟随' && p.outcome_30d !== null);
      const rets = group.map(p => p.outcome_30d * 100);
      const ws = rets.filter(r => r > 0);
      const tw = ws.reduce((s,v)=>s+v,0); const tl = Math.abs(rets.filter(r=>r<=0).reduce((s,v)=>s+v,0));
      return { period, samples: group.length, winRate: (ws.length/group.length*100), pf: tl>0?tw/tl:99, medianReturn: median(rets) };
    }),
    crossCycleVerdict: allPositive ? '跨周期有效' : '部分周期失效',
    predictions: predictions.slice(0, 5000), // 限制文件大小
  };
  fs.writeFileSync(path.join(DATA_DIR, 'v2.3_cross_cycle_report.json'), JSON.stringify(report, null, 2));
  L(`✅ V2.3 报告 → ${DATA_DIR}/v2.3_cross_cycle_report.json`);
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });
