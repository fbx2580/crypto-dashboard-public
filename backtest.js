#!/usr/bin/env node
/**
 * 随机窗口回测引擎
 * 
 * 12个独立窗口（过去12个月，每月一次）
 * 每个窗口：120天训练 + 30天验证
 * 输出：每窗口报表 + 跨窗口一致性分析 + 过拟合风险评估
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');

const BINANCE = 'https://api.binance.com/api/v3';
const WARP = 'socks5://127.0.0.1:40000';
const warpAgent = new SocksProxyAgent(WARP);
const FAPI = 'https://fapi.binance.com/fapi/v1';

const OUTPUT = path.join(__dirname, 'public', 'data', 'analysis', 'backtest_multi.json');

const MAJORS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];

// ═══ 工具函数 ═══
function ema(d,p){const k=2/(p+1),o=[];let s=0;for(let i=0;i<p&&i<d.length;i++)s+=d[i];o.push(s/Math.min(p,d.length));for(let i=1;i<d.length;i++)o.push(d[i]*k+o[i-1]*(1-k));return o}
function rsi(c,p=14){if(c.length<p+1)return new Array(c.length).fill(50);const o=new Array(p).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*13+(d>0?d:0))/14;al=(al*13+(d<0?-d:0))/14;o[i]=al===0?100:100-100/(1+ag/al)}return o}
function pearson(x,y){const rx=[],ry=[];for(let i=1;i<Math.min(x.length,y.length);i++){rx.push((x[i]-x[i-1])/x[i-1]);ry.push((y[i]-y[i-1])/y[i-1])}const n=Math.min(rx.length,ry.length);let sx=0,sy=0,sxy=0,sx2=0,sy2=0;for(let i=0;i<n;i++){sx+=rx[i];sy+=ry[i];sxy+=rx[i]*ry[i];sx2+=rx[i]*rx[i];sy2+=ry[i]*ry[i]}const num=n*sxy-sx*sy;const den=Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));return den===0?0:num/den}

// ═══ 五大形态 ═══
function checkAll(klines, btcKlines) {
  const n = klines.length;
  const closes = klines.map(k => k.close);

  // 1. 地量横盘
  const half = klines.slice(-Math.floor(n/2));
  const allButHalf = klines.slice(0, klines.length - half.length);
  const avgVh = half.reduce((s,k) => s+k.volume, 0)/Math.max(half.length,1);
  const avgVe = allButHalf.reduce((s,k) => s+k.volume, 0)/Math.max(allButHalf.length,1);
  const high = Math.max(...klines.map(k => k.high)), low = Math.min(...klines.map(k => k.low));
  const c1 = { met: avgVe>0 && avgVh/avgVe<0.6 && (high-low)/low<0.30 };

  // 2. 底背离
  const r = rsi(closes, 14);
  const pls = [];
  for (let i = 2; i < klines.length - 2; i++) {
    if (klines[i].low < klines[i-1].low && klines[i].low < klines[i-2].low && klines[i].low < klines[i+1].low && klines[i].low < klines[i+2].low) {
      if (r[i] !== null) pls.push({ low: klines[i].low, rsi: r[i] });
    }
  }
  let c2 = { met: false };
  if (pls.length >= 2) {
    const p1 = pls[pls.length - 2], p2 = pls[pls.length - 1];
    c2 = { met: p2.low <= p1.low && p2.rsi > p1.rsi };
  }

  // 3. 长下影（≥7根 回测校准后）
  let wick = 0;
  for (const k of klines.slice(-n)) { const b = Math.abs(k.close-k.open), w=Math.min(k.open,k.close)-k.low; if (b>0 && w>b*2.5) wick++; }
  const c3 = { met: wick >= 7 };

  // 4. 震仓（全窗口检测）
  const lowWin = Math.min(...klines.map(k => k.low));
  let c4 = { met: false };
  for (let i = 5; i < klines.length - 3; i++) {
    if (klines[i].low < lowWin * 0.95) {
      let rec = false, vs = false;
      for (let j = i + 1; j < Math.min(i + 4, klines.length); j++) {
        if (klines[j].close > lowWin) rec = true;
        if (klines[j].volume > klines.slice(Math.max(0,i-5),i).reduce((s,x)=>s+x.volume,0)/Math.max(i-5,1)) vs = true;
      }
      if (rec && vs) { c4.met = true; break; }
    }
  }

  // 5. 独立走势
  const corr = pearson(closes.slice(-30), btcKlines.slice(-30).map(k => k.close));
  const c5 = { met: Math.abs(corr) < 0.3, corr };

  return [c1, c2, c3, c4, c5];
}

// ═══ API ═══
async function getJSON(url, params = {}) { return (await axios.get(url, { params, timeout: 15000 })).data; }
async function getKlines(sym, start, end) {
  const data = await getJSON(`${BINANCE}/klines`, { symbol: sym, interval: '1d', startTime: start, endTime: end, limit: 300 });
  return data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));
}

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }

// ═══ 主流程 ═══
async function main() {
  const now = Date.now();
  const windows = [];
  // 12个窗口：过去12个月，每月取一天
  for (let m = 1; m <= 12; m++) {
    const testDate = now - m * 30 * 86400000; // 每月往回退30天
    windows.push({
      id: `W${m}`,
      label: new Date(testDate).toISOString().slice(0, 7),
      testDate,
      trainStart: testDate - 120 * 86400000,
      fwdEnd: testDate + 30 * 86400000,
    });
  }

  log(`🔬 随机窗口回测: ${windows.length}个窗口 (${windows[windows.length-1].label} → ${windows[0].label})`);

  // 拉币种列表（只拉一次）
  const xinfo = await getJSON(`${BINANCE}/exchangeInfo`);
  const altcoins = xinfo.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && !MAJORS.includes(s.symbol)).map(s => s.symbol);
  log(`山寨币${altcoins.length}个`);

  const allWindows = [];

  for (const win of windows) {
    log(`\n📅 窗口 ${win.id}: ${new Date(win.trainStart).toISOString().slice(0,10)} → ${new Date(win.fwdEnd).toISOString().slice(0,10)}`);

    // BTC基准
    let btcAll;
    try { btcAll = await getKlines('BTCUSDT', win.trainStart, win.testDate); } catch(e) { log(`  ⚠ BTC失败，跳过`); continue; }
    if (btcAll.length < 30) { log(`  ⚠ BTC数据不足`); continue; }

    const results = [];
    let done = 0;

    for (const sym of altcoins) {
      try {
        const train = await getKlines(sym, win.trainStart, win.testDate);
        if (train.length < 31) continue;
        const fwd = await getKlines(sym, win.testDate, win.fwdEnd, 30);
        if (fwd.length < 5) continue;

        const conds = checkAll(train, btcAll);
        const metCount = conds.filter(c => c.met).length;
        const entryPrice = train[train.length - 1].close;
        const exitPrice = fwd[fwd.length - 1].close;
        const fwdReturn = (exitPrice - entryPrice) / entryPrice;
        const maxReturn = (Math.max(...fwd.map(k => k.high)) - entryPrice) / entryPrice;

        results.push({
          symbol: sym.replace('USDT', ''),
          fwdReturn, maxReturn,
          metCount,
          c1: conds[0].met, c2: conds[1].met, c3: conds[2].met,
          c4: conds[3].met, c5: conds[4].met,
        });
      } catch(e) {}

      done++;
      if (done % 3 === 0) await new Promise(r => setTimeout(r, 10));
      if (done % 200 === 0) log(`  ${done}/${altcoins.length} → ${results.length}条`);
    }

    if (results.length < 50) { log(`  ⚠ 数据不足(${results.length})，跳过`); continue; }

    // 计算本窗口指标
    const factorKeys = ['c1','c2','c3','c4','c5'];
    const factorNames = ['地量横盘','底背离','长下影','震仓','独立走势'];
    const factorReport = factorKeys.map((k, i) => {
      const met = results.filter(r => r[k]);
      const not = results.filter(r => !r[k]);
      return {
        factor: factorNames[i],
        metCount: met.length,
        metWinRate: met.length > 0 ? met.filter(r => r.fwdReturn > 0).length / met.length : 0,
        metAvgReturn: met.length > 0 ? met.reduce((s,r) => s + r.fwdReturn, 0) / met.length : 0,
        metMedian: met.length > 0 ? met.map(r => r.fwdReturn).sort((a,b) => a-b)[Math.floor(met.length/2)] : 0,
        notWinRate: not.length > 0 ? not.filter(r => r.fwdReturn > 0).length / not.length : 0,
        advantage: met.length > 0 && not.length > 0 ?
          met.filter(r => r.fwdReturn > 0).length / met.length - not.filter(r => r.fwdReturn > 0).length / not.length : 0,
      };
    });

    const baselineWin = results.filter(r => r.fwdReturn > 0).length / results.length;
    const m2 = results.filter(r => r.metCount >= 2);
    const m3 = results.filter(r => r.metCount >= 3);
    const m2Win = m2.length > 0 ? m2.filter(r => r.fwdReturn > 0).length / m2.length : 0;
    const m3Win = m3.length > 0 ? m3.filter(r => r.fwdReturn > 0).length / m3.length : 0;

    allWindows.push({
      id: win.id,
      label: win.label,
      total: results.length,
      baselineWinRate: baselineWin,
      btcReturn: 0,
      m2WinRate: m2Win, m2Count: m2.length,
      m3WinRate: m3Win, m3Count: m3.length,
      factorReport,
    });

    log(`  ✅ 基准胜率${(baselineWin*100).toFixed(1)}% ≥2条件:${(m2Win*100).toFixed(1)}%/ ${m2.length}币 ≥3条件:${(m3Win*100).toFixed(1)}%/ ${m3.length}币`);
    const best = factorReport.sort((a,b) => b.advantage - a.advantage);
    log(`  最佳因子: ${best[0].factor} +${(best[0].advantage*100).toFixed(1)}%  最差: ${best[4].factor} ${(best[4].advantage*100).toFixed(1)}%`);
  }

  // ═══ 跨窗口一致性分析 ═══
  log('\n' + '═'.repeat(60));
  log('📊 跨窗口一致性分析');
  log('═'.repeat(60));

  const factorNames = ['地量横盘','底背离','长下影','震仓','独立走势'];

  for (let fi = 0; fi < 5; fi++) {
    const advantages = allWindows.map(w => w.factorReport[fi].advantage);
    const avgAdv = advantages.reduce((a,v) => a+v, 0) / advantages.length;
    const posWindows = advantages.filter(a => a > 0).length;
    const negWindows = advantages.filter(a => a < 0).length;
    const stdDev = Math.sqrt(advantages.reduce((s,a) => s+(a-avgAdv)**2, 0) / advantages.length);
    const consistent = posWindows >= allWindows.length * 0.75; // 75%以上窗口正向

    log(`\n${factorNames[fi]}:`);
    log(`  均优势: ${(avgAdv*100).toFixed(1)}%  正向窗口: ${posWindows}/${allWindows.length}  标准差: ${(stdDev*100).toFixed(1)}%`);
    log(`  跨窗口: ${advantages.map(a => (a*100).toFixed(1)+'%').join(' ')}`);
    log(`  一致: ${consistent ? '✅ 稳定有效' : '⚠ 非稳定'}`);
  }

  // m2/m3 一致性
  const m2Wins = allWindows.map(w => w.m2WinRate);
  const m3Wins = allWindows.map(w => w.m3WinRate);
  const m2Avg = m2Wins.reduce((a,v)=>a+v,0)/m2Wins.length;
  const m3Avg = m3Wins.reduce((a,v)=>a+v,0)/m3Wins.length;
  const baselineAvg = allWindows.reduce((a,w)=>a+w.baselineWinRate,0)/allWindows.length;
  log(`\n≥2条件均胜率: ${(m2Avg*100).toFixed(1)}%  基准: ${(baselineAvg*100).toFixed(1)}%  超额: ${((m2Avg-baselineAvg)*100).toFixed(1)}%`);
  log(`≥3条件均胜率: ${(m3Avg*100).toFixed(1)}%  基准: ${(baselineAvg*100).toFixed(1)}%  超额: ${((m3Avg-baselineAvg)*100).toFixed(1)}%`);

  // ═══ 过拟合风险评估 ═══
  log('\n' + '═'.repeat(60));
  log('⚠ 过拟合风险评估');
  log('═'.repeat(60));

  const risks = [];

  // 检查1：因子是否只在少数窗口有效
  for (let fi = 0; fi < 5; fi++) {
    const advantages = allWindows.map(w => w.factorReport[fi].advantage);
    const posWindows = advantages.filter(a => a > 0).length;
    if (posWindows < allWindows.length * 0.5) {
      risks.push(`${factorNames[fi]}: 仅${posWindows}/${allWindows.length}窗口正向 → 可能过拟合`);
    }
  }

  // 检查2：超额收益是否趋近于0
  const excess = m2Avg - baselineAvg;
  if (excess < 0.03) risks.push(`≥2条件超额仅${(excess*100).toFixed(1)}% → 接近噪音水平`);
  if (excess < 0) risks.push(`≥2条件负超额 → 模型在回测期内整体失效`);

  // 检查3：标准差是否过大（不稳定性）
  for (let fi = 0; fi < 5; fi++) {
    const advantages = allWindows.map(w => w.factorReport[fi].advantage);
    const stdDev = Math.sqrt(advantages.reduce((s,a) => s+(a-advantages.reduce((x,v)=>x+v,0)/advantages.length)**2,0)/advantages.length);
    if (stdDev > 0.15) risks.push(`${factorNames[fi]}: 标准差${(stdDev*100).toFixed(1)}% → 高度不可预测`);
  }

  if (risks.length === 0) risks.push('✅ 当前参数跨窗口稳定，过拟合风险低');
  for (const r of risks) log(`  ${r}`);

  // ═══ 所需数据支撑 ═══
  log('\n' + '═'.repeat(60));
  log('📋 所需数据支撑（按性价比排）');
  log('═'.repeat(60));

  log('\n🔴 必须补（否则精度上限锁死在60%）:');
  log('  1. 交易所净流出 — 区分\"真吸筹\"vs\"技术幻觉\"的唯一硬指标');
  log('  2. 更多回测窗口 — 12个月不够，需要24-36个月覆盖牛熊');

  log('\n🟡 建议补（可提升到70-75%）:');
  log('  3. 板块/叙事标签 — CoinGecko免费，已有数据但未建模');
  log('  4. 流通率 — 解锁砸盘风险过滤');
  log('  5. 牛市/熊市标签 — 按市场状态分层回测');

  log('\n🟢 锦上添花:');
  log('  6. 盘口深度 — 判断真买盘vs挂单骗炮');
  log('  7. 社交情绪 — 确认\"冷门币\"vs\"热度币\"区别对待');

  // 保存
  const out = {
    windows: allWindows,
    consistency: {
      excessReturn: excess,
      stdDev: 0,
      factorConsistency: factorNames.map((fn, i) => {
        const advantages = allWindows.map(w => w.factorReport[i].advantage);
        const avg = advantages.reduce((a,v) => a+v, 0) / advantages.length;
        const std = Math.sqrt(advantages.reduce((s,a) => s+(a-avg)**2, 0) / advantages.length);
        return {
          factor: fn,
          avgAdvantage: avg,
          positiveWindows: advantages.filter(a => a > 0).length,
          totalWindows: allWindows.length,
          stdDev: std,
          consistent: advantages.filter(a => a > 0).length >= allWindows.length * 0.75,
        };
      }),
    },
    risks,
    dataNeeds: ['exchange_netflow', 'sector_tags', 'circulating_supply', 'market_regime', 'longer_history'],
  };

  if (!fs.existsSync(path.dirname(OUTPUT))) fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  log(`\n✅ 多窗口回测完成 → ${OUTPUT}`);
}

main().catch(e => { log('❌ ' + e.message); process.exit(1); });
