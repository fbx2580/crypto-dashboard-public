#!/usr/bin/env node
/**
 * Bottom Detection V2 候选模型 & 对比回测
 *
 * 不改 V1，只新增 V2 并对比。
 * V2 Conservative: 严格过滤假阳性
 * V2 Balanced: 平衡胜率和发现数量
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://api.binance.com/fapi/v1';
const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [bdv2] ${m}`); }

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

// ═══ V2 底部检测 ═══
function isBottomV2(klines, mode = 'balanced') {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  const price = closes[n - 1];

  const ma20 = ema(closes, 20), ma60 = ema(closes, 60);
  const ma20Now = ma20[ma20.length - 1], ma60Now = ma60[ma60.length - 1];
  const ma20Prev = ma20[Math.max(0, ma20.length - 15)];
  const ma60Prev = ma60[Math.max(0, ma60.length - 30)];

  // 1. 趋势过滤
  const ma60Still = Math.abs(ma60Now - ma60Prev) / ma60Prev;
  const ma60Direction = ma60Now >= ma60Prev ? 'up' : ma60Still < 0.05 ? 'flat' : 'down';
  const inDowntrend = price < ma20Now && ma20Now < ma60Now;

  // Conservative: MA60必须走平或向上
  // Balanced: MA60不能快速下降
  const trendOK_cons = ma60Direction !== 'down';
  const trendOK_bal = ma60Direction !== 'down' || ma60Still < 0.08;

  // 2. 下跌结束确认
  const recent30Low = Math.min(...lows.slice(-30));
  const prior30Low = Math.min(...lows.slice(-60, -30));
  const stillNewLow = recent30Low <= prior30Low * 0.97;
  const lowStructure = (() => {
    const recentLows = [];
    for (let i = 30; i >= 15; i--) {
      if (lows[i] <= Math.min(...lows.slice(i - 5, i + 5)) && i < n - 5) recentLows.push(lows[i]);
    }
    return recentLows.length >= 2 && recentLows[0] > recentLows[recentLows.length - 1];
  })();

  const declineEnd_cons = !stillNewLow || lowStructure;
  const declineEnd_bal = !stillNewLow;

  // 3. 成交量确认
  const vol30 = vols.slice(-30).reduce((s,v)=>s+v,0)/30;
  const vol90 = vols.slice(-90).reduce((s,v)=>s+v,0)/90;
  const volRatio = vol90 > 0 ? vol30 / vol90 : 1;

  const volOK_cons = volRatio >= 0.8;
  const volOK_bal = volRatio >= 0.6;

  // 4. 波动收缩
  const trs = [];
  for (let i = 1; i < n; i++) trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  let sum = 0;
  for (let i = 0; i < 14 && i < trs.length; i++) sum += trs[i];
  const atrVals = [sum / Math.min(14, trs.length)];
  for (let i = 1; i < trs.length; i++) atrVals.push((atrVals[i-1]*13+trs[i])/14);
  const atrNow = atrVals.slice(-14).reduce((s,v)=>s+v,0)/14/price;
  const atrPrior = atrVals.slice(-60,-14).reduce((s,v)=>s+v,0)/46/price;
  const atrRatio = atrPrior > 0 ? atrNow / atrPrior : 1;

  const atrOK_cons = atrRatio < 0.8;
  const atrOK_bal = atrRatio < 1.0;

  // 5. 原有条件
  const absLow = Math.min(...lows);
  const priceVsLow = (price - absLow) / absLow;
  const inLowZone = priceVsLow < 2.0;
  const range30 = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price;
  const inRange = range30 < 0.40;

  // 综合判定
  const baseOK = inLowZone && inRange;

  if (mode === 'conservative') {
    return baseOK && trendOK_cons && declineEnd_cons && volOK_cons && atrOK_cons;
  } else {
    return baseOK && trendOK_bal && declineEnd_bal && (volOK_bal || atrOK_bal);
  }

  return false;
}

// ═══ V2 角色判定（复用V1其他逻辑，只替换底部发现） ═══
function determineRoleV2(klines, phases, accStatus, mode) {
  const closes = klines.map(k => k.close);
  const n = klines.length;
  const price = closes[n - 1];
  const ma60 = ema(closes, 60);
  const ma200 = ema(closes, Math.min(200, closes.length));
  const ma60Now = ma60[ma60.length - 1];
  const ma200Now = ma200[ma200.length - 1];
  const rsiVals = (() => {
    const period = 14;
    if (closes.length < period + 1) return [50];
    const out = [50];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
    out.push(losses === 0 ? 100 : 100 - 100 / (1 + gains / losses));
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gains = (gains * 13 + (d > 0 ? d : 0)) / 14;
      losses = (losses * 13 + (d < 0 ? -d : 0)) / 14;
      out.push(losses === 0 ? 100 : 100 - 100 / (1 + gains / losses));
    }
    return out;
  })();
  const rsiNow = rsiVals[rsiVals.length - 1];
  const priceVsMA200 = (price - ma200Now) / ma200Now;
  const ret30 = closes[n - 1] / closes[Math.max(0, n - 31)] - 1;
  const vols = klines.map(k => k.volume);
  const volRecent = vols.slice(-20).reduce((s,v)=>s+v,0)/20;
  const volPrior = vols.slice(-40,-20).reduce((s,v)=>s+v,0)/20;
  const volTrend = volPrior > 0 ? volRecent / volPrior : 1;
  const ath = Math.max(...klines.map(k => k.high));
  const priceVsATH = (price - ath) / ath;

  // 使用V2底部检测替代V1
  if (isBottomV2(klines, mode) && priceVsMA200 < -0.10 && rsiNow < 55) return '底部发现';
  if (accStatus.status === 'completed' && accStatus.phaseEvidence?.hasLaunch) {
    if (price > ma60Now) return '趋势跟随';
  }
  if (accStatus.status === 'completed' && price > ma60Now && volTrend > 0.5) return '趋势跟随';
  const launchPhase = [...phases].reverse().find(p => p.phase === 'launch');
  if (launchPhase && accStatus.status !== 'ongoing' && ret30 > 0.05 && ret30 < 0.50 && volTrend > 0.6) return '启动跟踪';
  if (priceVsATH > -0.15 && price > ma60Now * 1.2 && rsiNow > 65) return '高位防守';
  if (ret30 > 0 && ret30 < 0.15 && accStatus.status === 'completed' && price < ma60Now && volTrend < 1.0) return '反弹交易';
  return '观望';
}

// ═══ 主流程 ═══
async function main() {
  L('🔬 Bottom Detection V2 对比回测');

  // 加载 V1 历史数据
  const v1Data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'historical_predictions.json'), 'utf8'));
  L(`V1 总预测: ${v1Data.length}`);

  // 取V1的预测日期和币种，用V2重新判定
  const symbols = [...new Set(v1Data.map(p => p.symbol))];
  L(`V2 回放: ${symbols.length} 币种`);

  // 用V1的预测日期（节省API请求）
  // 对每个币种，拉取完整K线，然后逐预测日期用V2判定
  const v2Results = [];

  for (let si = 0; si < Math.min(symbols.length, 50); si++) {
    const sym = symbols[si];
    const symPreds = v1Data.filter(p => p.symbol === sym);
    if (symPreds.length === 0) continue;

    // 拉取完整K线
    let fullKlines;
    try {
      const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: sym + 'USDT', interval: '1d', limit: 400 });
      if (!raw || raw.length < 100) continue;
      fullKlines = raw.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
      }));
    } catch(e) {
      try {
        const raw = await getJSON(`${BINANCE_SPOT}/klines`, { symbol: sym + 'USDT', interval: '1d', limit: 400 });
        if (!raw || raw.length < 100) continue;
        fullKlines = raw.map(k => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5]), quoteVolume: parseFloat(k[7]),
        }));
      } catch(e2) { continue; }
    }

    for (const pred of symPreds) {
      const predMs = new Date(pred.prediction_date).getTime();
      const pastKlines = fullKlines.filter(k => k.time <= predMs);
      if (pastKlines.length < 60) continue;

      try {
        const { detectLifecyclePhases, checkAccumulationStatus } = require('./lifecycle-diagnosis-v2');
        const phases = detectLifecyclePhases(pastKlines);
        const accStatus = checkAccumulationStatus(pastKlines, phases);

        const roleCons = determineRoleV2(pastKlines, phases, accStatus, 'conservative');
        const roleBal = determineRoleV2(pastKlines, phases, accStatus, 'balanced');

        const outcome = pred.outcome;

        v2Results.push({
          symbol: sym,
          prediction_date: pred.prediction_date,
          price_at_prediction: pred.price_at_prediction,
          v1_role: pred.trading_role,
          v2_role_conservative: roleCons,
          v2_role_balanced: roleBal,
          outcome,
        });
      } catch(e) {}
    }

    if ((si + 1) % 10 === 0) L(`  进度 ${si+1}/${Math.min(symbols.length, 50)}`);
    await new Promise(r => setTimeout(r, 200));
  }

  L(`V2 完成: ${v2Results.length} 条对比`);

  // ═══ 统计对比 ═══
  const stats = (data, roleKey) => {
    const bottom = data.filter(p => p[roleKey] === '底部发现' && p.outcome?.return_30d !== null);
    if (bottom.length === 0) return null;
    const ret30 = bottom.map(p => p.outcome.return_30d);
    const wins = ret30.filter(r => r > 0).length;
    const return30 = bottom.map(p => p.outcome.return_30d * 100);
    const maxDD = bottom.map(p => (p.outcome.max_drawdown_30d || 0) * 100);
    return {
      samples: bottom.length,
      winRate: (wins / bottom.length * 100).toFixed(1) + '%',
      avgReturn30d: (return30.reduce((s,v)=>s+v,0) / return30.length).toFixed(1) + '%',
      medianReturn30d: (return30.sort((a,b)=>a-b)[Math.floor(return30.length/2)]).toFixed(1) + '%',
      avgMaxDD30d: (maxDD.reduce((s,v)=>s+v,0) / maxDD.length).toFixed(1) + '%',
    };
  };

  const v1Stats = stats(v2Results, 'v1_role');
  const v2ConsStats = stats(v2Results, 'v2_role_conservative');
  const v2BalStats = stats(v2Results, 'v2_role_balanced');

  // 计算假阳性减少
  const v1Bottom = v2Results.filter(p => p.v1_role === '底部发现').length;
  const v2ConsBottom = v2Results.filter(p => p.v2_role_conservative === '底部发现').length;
  const v2BalBottom = v2Results.filter(p => p.v2_role_balanced === '底部发现').length;

  console.log('\n═══════════════════════════════════════════');
  console.log('Bottom Detection V1 vs V2 对比报告');
  console.log('═══════════════════════════════════════════\n');

  console.log('指标                     V1             V2 Conservative   V2 Balanced');
  console.log('────────────────────────────────────────────────────────────────');
  const printRow = (label, v1, v2c, v2b) => {
    console.log(`${label.padEnd(24)} ${(v1||'N/A').toString().padEnd(14)} ${(v2c||'N/A').toString().padEnd(17)} ${v2b||'N/A'}`);
  };

  printRow('底部发现样本', v1Bottom, v2ConsBottom, v2BalBottom);
  printRow('30天胜率', v1Stats?.winRate, v2ConsStats?.winRate, v2BalStats?.winRate);
  printRow('30天均收益', v1Stats?.avgReturn30d, v2ConsStats?.avgReturn30d, v2BalStats?.avgReturn30d);
  printRow('30天中位收益', v1Stats?.medianReturn30d, v2ConsStats?.medianReturn30d, v2BalStats?.medianReturn30d);
  printRow('30天均最大回撤', v1Stats?.avgMaxDD30d, v2ConsStats?.avgMaxDD30d, v2BalStats?.avgMaxDD30d);

  console.log('');
  console.log('假阳性减少:');
  console.log(`  V2 Conservative: ${v1Bottom > 0 ? ((1 - v2ConsBottom/v1Bottom)*100).toFixed(0) : 'N/A'}% (${v1Bottom} → ${v2ConsBottom})`);
  console.log(`  V2 Balanced:     ${v1Bottom > 0 ? ((1 - v2BalBottom/v1Bottom)*100).toFixed(0) : 'N/A'}% (${v1Bottom} → ${v2BalBottom})`);

  // 判定
  console.log('');
  console.log('结论:');
  function assess(name, stats, reduction) {
    if (!stats) return `  ${name}: 数据不足`;
    const wr = parseFloat(stats.winRate);
    const ar = parseFloat(stats.avgReturn30d);
    const md = parseFloat(stats.medianReturn30d || '0');
    if (wr > 40 && ar > 0) return `  ${name}: ✅ 有效提升 (胜率${stats.winRate}, 均收益${stats.avgReturn30d})`;
    if (wr > 30 && md > -10) return `  ${name}: ⚠️ 部分改善`;
    return `  ${name}: ❌ 仍需优化`;
  }
  console.log(assess('V2 Conservative', v2ConsStats));
  console.log(assess('V2 Balanced', v2BalStats));

  // 保存报告
  const report = {
    generatedAt: new Date().toISOString(),
    totalPredictions: v2Results.length,
    comparison: {
      V1: v1Stats ? { ...v1Stats, samples: v1Bottom } : null,
      'V2 Conservative': v2ConsStats ? { ...v2ConsStats, samples: v2ConsBottom, falsePositiveReduction: v1Bottom > 0 ? ((1 - v2ConsBottom/v1Bottom)*100).toFixed(1)+'%' : 'N/A' } : null,
      'V2 Balanced': v2BalStats ? { ...v2BalStats, samples: v2BalBottom, falsePositiveReduction: v1Bottom > 0 ? ((1 - v2BalBottom/v1Bottom)*100).toFixed(1)+'%' : 'N/A' } : null,
    },
    recommendation: {
      conservative: v2ConsStats && parseFloat(v2ConsStats.winRate) > 35 ? 'REPLACE_V1' : 'NEEDS_OPTIMIZATION',
      balanced: v2BalStats && parseFloat(v2BalStats.winRate) > 30 ? 'REPLACE_V1' : 'NEEDS_OPTIMIZATION',
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, 'bottom_detection_v2_backtest_report.json'), JSON.stringify(report, null, 2));
  L(`✅ 报告 → ${DATA_DIR}/bottom_detection_v2_backtest_report.json`);
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });
