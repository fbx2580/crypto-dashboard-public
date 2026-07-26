#!/usr/bin/env node
/**
 * 生命周期诊断模型 V2
 * 
 * 解决 V1 的静态判断问题：不仅看"现在是什么状态"，
 * 而是判断"这个币已经走到了生命周期哪一步"。
 * 
 * 核心改进：
 * 1. lifecycle_history  — 历史阶段轨迹（区分刚发现 vs 已完成启动）
 * 2. accumulation_status — 稀筹结束判断（进行中/已完成/疑似结束）
 * 3. trading_role       — 当前交易角色（底部发现/启动跟踪/趋势跟随/高位防守/反弹交易/观望）
 * 4. second_wave_potential — 二次上涨潜力（存在/不存在/等待确认）
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');
const OUTPUT_FILE = path.join(DATA_DIR, 'lifecycle_diagnosis.json');

function L(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] [lifecycle] ${m}`); }

// ═══ 工具函数 ═══
async function getJSON(url, params = {}) {
  return (await axios.get(url, { params, timeout: 15000 })).data;
}

async function getKlines(symbol, limit = 365) {
  const symWithUSDT = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
  let raw;
  // 先尝试合约API（山寨币通常在合约市场更全）
  try {
    raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: symWithUSDT, interval: '1d', limit });
  } catch (e1) {
    // 回退现货
    try {
      raw = await getJSON(`${BINANCE_SPOT}/klines`, { symbol: symWithUSDT, interval: '1d', limit });
    } catch (e2) {
      throw e2;
    }
  }
  return raw.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7]),
  }));
}

function ema(data, period) {
  const k = 2 / (period + 1);
  const out = [];
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) sum += data[i];
  out.push(sum / Math.min(period, data.length));
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);
  const out = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * 13 + (d > 0 ? d : 0)) / 14;
    al = (al * 13 + (d < 0 ? -d : 0)) / 14;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function atr(klines, period = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
  }
  const atrVals = [];
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i];
  atrVals.push(sum / Math.min(period, trs.length));
  for (let i = 1; i < trs.length; i++) {
    atrVals.push((atrVals[i - 1] * (period - 1) + trs[i]) / period);
  }
  return atrVals;
}

// ═══ 第一阶段：检测生命周期阶段 ═══
//
// 核心问题：对于 XNY 类币，绝对低点之后有 V 形反弹，那不是吸筹。
// 真正的吸筹在反弹稳定之后：持续的地量、窄幅横盘。
//
// 步骤：
//   1. 找绝对低点 → 跳过 V 形反弹（等 MA30 走平）
//   2. 反弹稳定后找最长地量横盘段 = 吸筹区
//   3. 吸筹后第一次放量突破 = 启动
//   4. 启动后的大窗口阶段检测
//
function detectLifecyclePhases(klines) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  if (n < 60) return [];

  const price = closes[n - 1];
  const totalAvgVol = vols.reduce((s, v) => s + v, 0) / n;

  const absLow = Math.min(...lows);
  const absLowIdx = lows.indexOf(absLow);
  const absHigh = Math.max(...highs);
  
  L(`  极值：低$${absLow.toFixed(6)}@${absLowIdx}d 高$${absHigh.toFixed(6)} 现$${price.toFixed(6)}`);

  const phases = [];

  // ═══ 1. 跳过 V 形反弹，找稳定点 ═══
  // 从 absLowIdx+30 开始向后，找 MA30 变化率 <10% 的第一个点
  let stablePoint = -1;
  for (let i = absLowIdx + 30; i < Math.min(n, absLowIdx + 150); i++) {
    if (i < 60) continue;
    const a = closes.slice(i - 29, i + 1).reduce((s, c) => s + c, 0) / 30;
    const b = closes.slice(i - 59, i - 29).reduce((s, c) => s + c, 0) / 30;
    const chg = b > 0 ? Math.abs(a - b) / b : 1;
    if (chg < 0.10) { stablePoint = i - 20; break; }
  }
  if (stablePoint < 0 || stablePoint >= n) stablePoint = Math.min(absLowIdx + 30, n - 16);
  if (stablePoint < 0 || stablePoint >= n) stablePoint = Math.max(0, n - 60);
  // 确保不越界
  stablePoint = Math.min(stablePoint, n - 16);
  L(`  稳定点：${stablePoint < n ? new Date(klines[stablePoint].time).toISOString().slice(0,10) : 'N/A'}`);

  // ═══ 2. 从稳定点找吸筹区（到首次放量突破为止） ═══
  let accStart = Math.min(stablePoint, n - 1);
  let accEnd = Math.min(stablePoint + 30, n - 1);
  let breakoutIdx = -1;

  const baseVol = vols.slice(stablePoint, Math.min(n, stablePoint + 45)).reduce((s, v) => s + v, 0) /
    Math.max(1, Math.min(45, n - stablePoint));

  for (let i = stablePoint + 30; i < n; i++) {
    const r3v = vols.slice(Math.max(0, i - 2), i + 1).reduce((s, v) => s + v, 0) / 3;
    const surge = baseVol > 0 && r3v > baseVol * 2.0;
    const gain21 = closes[i] / closes[Math.max(0, i - 21)] - 1;
    const aboveAcc = closes[i] > closes[accStart] * 1.8;
    if (surge && (gain21 > 0.20 || aboveAcc) && breakoutIdx < 0) {
      breakoutIdx = i;
      L(`  突破@${new Date(klines[i].time).toISOString().slice(0,10)} 量${(r3v/baseVol).toFixed(1)}x`);
    }
    if (breakoutIdx < 0) accEnd = i;
  }
  if (breakoutIdx > 0) accEnd = Math.max(accEnd, breakoutIdx - 7);

  const accDays = accEnd - accStart + 1;
  const accAvgVol = vols.slice(accStart, accEnd + 1).reduce((s, v) => s + v, 0) / accDays;
  const accVolRatio = totalAvgVol > 0 ? accAvgVol / totalAvgVol : 1;
  const accRange = (Math.max(...highs.slice(accStart, accEnd + 1)) - Math.min(...lows.slice(accStart, accEnd + 1))) /
    Math.min(...lows.slice(accStart, accEnd + 1));

  L(`  吸筹区：${new Date(klines[accStart].time).toISOString().slice(0,10)}→${new Date(klines[accEnd].time).toISOString().slice(0,10)} ${accDays}天 量比${accVolRatio.toFixed(2)} 振幅${(accRange*100).toFixed(0)}%`);

  if (accDays >= 15) {
    phases.push({
      phase: 'accumulation',
      startIdx: accStart, endIdx: accEnd,
      startDate: new Date(klines[accStart].time).toISOString().slice(0, 10),
      endDate: new Date(klines[accEnd].time).toISOString().slice(0, 10),
      segReturn: closes[accEnd] / closes[accStart] - 1,
      volRatio: accVolRatio, segRange: accRange,
      priceVsAbsLow: (closes[accEnd] - absLow) / absLow,
      accLow: Math.min(...lows.slice(accStart, accEnd + 1)),
      accHigh: Math.max(...highs.slice(accStart, accEnd + 1)),
    });
  }

  // ═══ 3. 启动阶段 ═══
  const afterAcc = breakoutIdx > 0 ? Math.max(accEnd + 1, breakoutIdx - 5) : accEnd + 1;
  let launchFound = false, launchStart = -1, launchEnd = -1;

  for (let i = afterAcc; i < Math.min(n, afterAcc + 90); i++) {
    if (i < afterAcc + 3) continue;
    const r14 = closes[i] / closes[Math.max(0, i - 14)] - 1;
    const v8 = vols.slice(Math.max(0, i - 7), i + 1).reduce((s, v) => s + v, 0) / 8;
    const vr = accAvgVol > 0 ? v8 / accAvgVol : 1;
    if (r14 > 0.15 && vr > 1.5 && closes[i] > closes[accEnd] * 1.10) {
      launchStart = i - 7; launchEnd = i; launchFound = true;
      L(`  启动：${new Date(klines[Math.max(0,launchStart)].time).toISOString().slice(0,10)} 量比${vr.toFixed(1)}x +${(r14*100).toFixed(0)}%`);
      break;
    }
  }

  if (launchFound) {
    let peak = launchEnd;
    for (let i = launchEnd + 1; i < Math.min(n, launchEnd + 45); i++) {
      if (closes[i] > closes[peak]) peak = i;
      if (1 - closes[i] / closes[peak] > 0.35) { launchEnd = i; break; }
      launchEnd = i;
    }
    phases.push({
      phase: 'launch', startIdx: Math.max(0, launchStart), endIdx: launchEnd,
      startDate: new Date(klines[Math.max(0, launchStart)].time).toISOString().slice(0, 10),
      endDate: new Date(klines[launchEnd].time).toISOString().slice(0, 10),
      segReturn: closes[launchEnd] / closes[Math.max(0, launchStart)] - 1,
      volRatio: vols.slice(Math.max(0, launchStart), launchEnd + 1).reduce((s, v) => s + v, 0) / (launchEnd - Math.max(0, launchStart) + 1) / totalAvgVol,
      segRange: 0, priceVsAbsLow: (closes[launchEnd] - absLow) / absLow,
    });
  }

  // ═══ 4. 启动后的阶段 ═══
  const post = launchFound ? launchEnd + 1 : afterAcc;
  if (post < n - 10) {
    let ws = post;
    while (ws < n - 30) {
      const we = Math.min(ws + 45, n);
      const segC = closes.slice(ws, we), segH = highs.slice(ws, we), segL = lows.slice(ws, we);
      const segV = vols.slice(ws, we);
      const sr = segC[segC.length - 1] / segC[0] - 1;
      const segR = segL[0] > 0 ? (Math.max(...segH) - Math.min(...segL)) / segL[0] : 0;
      const sv = segV.reduce((s, v) => s + v, 0) / segV.length;
      const svr = accAvgVol > 0 ? sv / accAvgVol : 1;

      let phase;
      if (sr > 0.15) phase = 'trend';
      else if (sr < -0.40) phase = 'decline';
      else if (segR < 0.40 && svr > 0.3) phase = 'consolidation';
      else if (sr < -0.10) phase = 'decline';
      else phase = 'consolidation';

      phases.push({ phase, startIdx: ws, endIdx: we - 1,
        startDate: new Date(klines[ws].time).toISOString().slice(0, 10),
        endDate: new Date(klines[we - 1].time).toISOString().slice(0, 10),
        segReturn: sr, volRatio: svr, segRange: segR,
        priceVsAbsLow: (segC[segC.length - 1] - absLow) / absLow,
      });
      ws += 22;
    }
  }

  // 合并
  const final = [];
  for (const p of phases) {
    if (final.length > 0 && final[final.length - 1].phase === p.phase) {
      final[final.length - 1].endIdx = p.endIdx;
      final[final.length - 1].endDate = p.endDate;
    } else { final.push({ ...p }); }
  }
  return final;
}

// ═══ 第二阶段：稀筹结束判断 ═══
function checkAccumulationStatus(klines, phases) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  const price = closes[n - 1];

  const absLow = Math.min(...lows);
  const range60Low = Math.min(...lows.slice(-60));
  const range60High = Math.max(...highs.slice(-60));

  // 1. 价格：是否脱离历史低点区域
  const priceVsLow = (price - absLow) / absLow;
  const priceVsRange60 = range60High > range60Low ? (price - range60Low) / (range60High - range60Low) : 0.5;

  // 2. 成交量：是否从低活跃进入活跃
  const volNow = vols.slice(-30).reduce((s, v) => s + v, 0) / 30;
  const volEarlier = vols.slice(-90, -30).reduce((s, v) => s + v, 0) / 60;
  const volTransition = volEarlier > 0 ? volNow / volEarlier : 1;

  // 3. 突破长期震荡区
  const range90High = Math.max(...highs.slice(-90, -30));
  const breakoutAboveRange = price > range90High * 1.05;

  // 4. 价格是否远离早期成本区
  const earlyCostLow = (Math.min(...lows.slice(0, Math.floor(n * 0.5))) + 
    Math.max(...highs.slice(0, Math.floor(n * 0.5)))) / 2;
  const farFromEarlyCost = price > earlyCostLow * 1.5;

  // 判断逻辑
  const reasons = [];
  let score = 0;

  if (priceVsLow > 0.50) { reasons.push('✓ 已脱离历史低位区域'); score += 3; }
  else if (priceVsLow > 0.20) { reasons.push('△ 部分脱离历史低位区域'); score += 1; }
  else { reasons.push('✗ 仍在历史低位区域附近'); }

  if (volTransition > 1.5) { reasons.push('✓ 成交活跃度提升'); score += 3; }
  else if (volTransition > 1.0) { reasons.push('△ 成交量略有回升'); score += 1; }
  else { reasons.push('✗ 成交量未明显变化'); }

  if (breakoutAboveRange) { reasons.push('✓ 已突破长期震荡区'); score += 3; }
  else if (priceVsRange60 > 0.7) { reasons.push('△ 价格接近震荡区上沿'); score += 1; }
  else { reasons.push('✗ 仍在震荡区内'); }

  if (farFromEarlyCost) { reasons.push('✓ 早期成本区已远离当前价格'); score += 2; }
  else { reasons.push('✗ 仍在早期成本区附近'); }

  // 阶段轨迹验证
  const hasAccum = phases.some(p => p.phase === 'accumulation');
  const hasLaunch = phases.some(p => p.phase === 'launch');
  const hasTrend = phases.some(p => p.phase === 'trend');

  let status, statusLabel;
  if (score >= 8) {
    status = 'completed';
    statusLabel = '已结束';
  } else if (score >= 4) {
    status = 'suspected_end';
    statusLabel = '疑似结束';
  } else {
    status = 'ongoing';
    statusLabel = '进行中';
  }

  // 特殊情况：即使分数不够，但如果已经历过启动+趋势，稀筹必然已结束
  if (hasLaunch && hasTrend && status !== 'completed') {
    status = 'completed';
    statusLabel = '已结束（已进入趋势阶段）';
    // 清除矛盾的负向原因
    const filtered = reasons.filter(r => !r.startsWith('✗') && !r.startsWith('△'));
    reasons.length = 0;
    reasons.push('✓ 生命轨迹确认：稀筹→启动→趋势');
    reasons.push(...filtered);
  }

  return {
    status,
    statusLabel,
    score,
    reasons,
    metrics: {
      priceVsLow: (priceVsLow * 100).toFixed(1) + '%',
      volTransition: volTransition.toFixed(2) + 'x',
      breakoutAboveRange,
      farFromEarlyCost,
    },
    phaseEvidence: { hasAccum, hasLaunch, hasTrend },
  };
}

// ═══ 第三阶段：当前交易角色 ═══
function determineTradingRole(klines, phases, accStatus) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const n = klines.length;
  const price = closes[n - 1];
  const ma60 = ema(closes, 60);
  const ma200 = ema(closes, Math.min(200, closes.length));
  const rs = rsi(closes, 14);

  const ma60Now = ma60[ma60.length - 1];
  const ma200Now = ma200[ma200.length - 1];
  const rsiNow = rs[rs.length - 1];
  const priceVsMA60 = (price - ma60Now) / ma60Now;
  const priceVsMA200 = (price - ma200Now) / ma200Now;

  const ath = Math.max(...closes);
  const priceVsATH = (price - ath) / ath;

  // 找最近的启动阶段
  const launchPhase = [...phases].reverse().find(p => p.phase === 'launch');
  const hasLaunchRecently = launchPhase && (n - launchPhase.startIdx) < 60;

  // 30天收益
  const ret30 = closes[n - 1] / closes[Math.max(0, n - 31)] - 1;

  // 成交量趋势
  const volRecent = vols.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const volPrior = vols.slice(-40, -20).reduce((s, v) => s + v, 0) / 20;
  const volTrend = volPrior > 0 ? volRecent / volPrior : 1;

  let role, description;

  // 如果有生命周期确认的稀筹结束（已走过启动+趋势），角色至少应该是跟踪/跟随
  if (accStatus.status === 'completed' && accStatus.phaseEvidence?.hasLaunch) {
    if (price > ma60Now) {
      role = '趋势跟随';
      description = '已完成稀筹→启动，当前在MA60上方整理。观察资金接力，MA60作为持仓参考';
    } else if (price < ma60Now && price > ma60Now * 0.9) {
      role = '反弹交易';
      description = '已完成启动但回调至MA60下方，关注MA60能否重新站上';
    } else {
      role = '趋势跟随';
      description = '已完成稀筹→启动的生命周期，关注趋势是否延续';
    }
  }
  // 如果还没走到上面那个分支，才用以下逐条判断
  else if (accStatus.status === 'ongoing' && priceVsMA200 < -0.15 && rsiNow < 45) {
    role = '底部观察';
    description = '价格进入低位区域，等待资金和趋势确认。非交易信号，仅观察。';
  }
  // ② 启动跟踪：刚突破，稀筹刚结束，或近期有启动信号
  else if ((hasLaunchRecently || accStatus.status === 'completed') && ret30 > 0.05 && ret30 < 0.50 && volTrend > 0.6) {
    role = '启动跟踪';
    description = '已确认启动信号，跟踪资金接力情况，关注回调加仓机会';
  }
  // ③ 趋势跟随：已启动完成，进入主升/整理后再攻
  else if (accStatus.status === 'completed' && price > ma60Now && volTrend > 0.5) {
    role = '趋势跟随';
    description = '已经不是低位吸筹机会，观察资金是否继续接力，关注MA60支撑';
  }
  // ④ 高位防守：价格大幅高于成本，有回调风险
  else if (priceVsATH > -0.15 && priceVsMA60 > 0.20 && rsiNow > 65) {
    role = '高位防守';
    description = '价格接近高点区域，注意止盈，警惕派发风险';
  }
  // ⑤ 反弹交易：下跌后企稳
  else if (ret30 > 0 && ret30 < 0.15 && accStatus.status === 'completed' && price < ma60Now && volTrend < 1.0) {
    role = '反弹交易';
    description = '趋势中回调，存在反弹机会但需严格止损';
  }
  // ⑥ 观望：情况不明
  else {
    role = '观望';
    description = '当前信号矛盾，建议等待更明确的趋势确认';
  }

  return {
    role,
    description,
    keyMetrics: {
      priceVsMA60: (priceVsMA60 * 100).toFixed(1) + '%',
      priceVsMA200: (priceVsMA200 * 100).toFixed(1) + '%',
      rsi14: rsiNow?.toFixed(0) || 'N/A',
      ret30d: (ret30 * 100).toFixed(1) + '%',
      volTrend: volTrend.toFixed(2) + 'x',
    },
  };
}

// ═══ 第四阶段：二次上涨潜力 ═══
function assessSecondWavePotential(klines, phases, accStatus) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  const price = closes[n - 1];

  // 正向因素
  const positives = [];
  const negatives = [];
  let posScore = 0, negScore = 0;

  // +1: 横盘时间充分（趋势后整理>30天）
  const consolidationPhases = phases.filter(p => p.phase === 'consolidation');
  const lastConsolidation = consolidationPhases[consolidationPhases.length - 1];
  if (lastConsolidation) {
    const consDays = lastConsolidation.endIdx - lastConsolidation.startIdx + 1;
    if (consDays >= 30) {
      positives.push(`横盘时间充分（${consDays}天）`);
      posScore += 2;
    } else if (consDays >= 15) {
      positives.push(`横盘整理中（${consDays}天）`);
      posScore += 1;
    }
  }

  // +2: 成交量没有明显衰竭（对比近期均值而非峰值）
  const volNow = vols.slice(-30).reduce((s, v) => s + v, 0) / 30;
  const volLast90 = vols.slice(-120, -30).reduce((s, v) => s + v, 0) / 90;
  const volVsPrior = volLast90 > 0 ? volNow / volLast90 : 1;
  if (volVsPrior > 0.8) {
    positives.push('成交量维持较好');
    posScore += 2;
  } else if (volVsPrior > 0.5) {
    positives.push('成交量有所萎缩但未枯竭');
    posScore += 1;
  }

  // +3: 未出现明显派发（价格未跌破MA60且没有高位放量滞涨）
  const ma60 = ema(closes, 60);
  const ma60Now = ma60[ma60.length - 1];
  const priceVsMA60 = (price - ma60Now) / ma60Now;

  if (priceVsMA60 > -0.05) {
    positives.push('价格维持在MA60上方');
    posScore += 1;
  }

  // -1: 高位放量滞涨
  const recent30Range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price;
  const volRecent30Avg = vols.slice(-30).reduce((s, v) => s + v, 0) / 30;
  const volPrior30Avg = vols.slice(-60, -30).reduce((s, v) => s + v, 0) / 30;
  if (recent30Range < 0.10 && volRecent30Avg > volPrior30Avg * 1.3 && price > ma60Now * 1.3) {
    negatives.push('高位放量滞涨');
    negScore += 3;
  }

  // -2: 跌破启动成本区
  const launchPhase = phases.find(p => p.phase === 'launch');
  if (launchPhase) {
    const launchCost = closes[launchPhase.startIdx];
    if (price < launchCost * 0.9) {
      negatives.push('已跌破启动成本区');
      negScore += 3;
    } else if (price < launchCost) {
      negatives.push('接近启动成本区');
      negScore += 1;
    }
  }

  // -3: 成交量急剧萎缩（对比近期均值）
  if (volVsPrior < 0.3) {
    negatives.push('成交量急剧萎缩');
    negScore += 2;
  }

  // -4: 跌回MA200
  const ma200 = ema(closes, Math.min(200, closes.length));
  const ma200Now = ma200[ma200.length - 1];
  if (price < ma200Now) {
    negatives.push('价格在MA200下方');
    negScore += 2;
  }

  // 综合判断
  const netScore = posScore - negScore;
  let potential;
  if (netScore >= 3) {
    potential = '存在';
  } else if (netScore >= 0) {
    potential = '等待确认';
  } else {
    potential = '不存在';
  }

  return {
    potential,
    netScore,
    positives,
    negatives,
    needs: posScore >= 3 && negatives.length > 0
      ? ['突破关键压力', '成交量重新放大', '确认资金回流']
      : potential === '等待确认'
        ? ['突破关键压力', '成交量重新放大']
        : [],
    risks: negatives.length > 0
      ? negatives.map(n => n.replace(/^-?\s*/, ''))
      : potential === '不存在'
        ? ['跌破启动成本区，可能重新进入沉淀阶段']
        : [],
  };
}

// ═══ 第五阶段：格式化输出 ═══
function formatDiagnosis(symbol, klines, phases, accStatus, tradingRole, secondWave) {
  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];
  const n = klines.length;

  // 阶段图标映射
  const phaseIcons = {
    accumulation: '🟢 稀筹阶段',
    launch: '🟡 启动阶段',
    trend: '🔵 趋势阶段',
    consolidation: '🟠 整理阶段',
    decline: '🔴 下跌阶段',
  };

  const phaseLabels = {
    accumulation: '稀筹阶段',
    launch: '启动阶段',
    trend: '趋势阶段',
    consolidation: '趋势整理阶段',
    decline: '下跌阶段',
  };

  // 当前阶段名
  const currentPhase = phases.length > 0 ? phases[phases.length - 1].phase : 'unknown';
  const currentLabel = phaseLabels[currentPhase] || '未知';

  // 已完成的阶段
  const completedPhases = phases.slice(0, -1).filter(p => p.phase !== currentPhase);

  // 去重（同一阶段只保留一次）
  const seen = new Set();
  const uniqueCompleted = [];
  for (const p of completedPhases) {
    if (!seen.has(p.phase)) {
      seen.add(p.phase);
      uniqueCompleted.push(p);
    }
  }

  // 构建历史轨迹
  const historyLines = [];
  for (const p of uniqueCompleted) {
    historyLines.push(`${phaseIcons[p.phase] || p.phase}（已完成）`);
  }
  // 添加当前阶段
  historyLines.push(`🟠 当前：${currentLabel}`);

  const historyView = historyLines.join('\n↓\n');

  // 稀筹状态
  const accStatusView = `${accStatus.statusLabel}\n\n原因：\n${accStatus.reasons.join('\n')}`;

  // 交易角色
  const roleView = `${tradingRole.role}\n\n说明：\n${tradingRole.description}`;

  // 二次上涨
  const swEmoji = secondWave.potential === '存在' ? '🟢' : secondWave.potential === '不存在' ? '🔴' : '🟡';
  const swLines = [`${swEmoji} ${secondWave.potential}`];
  swLines.push('');
  if (secondWave.positives.length > 0) {
    swLines.push('正向因素：');
    for (const p of secondWave.positives) swLines.push(`+ ${p}`);
  }
  if (secondWave.negatives.length > 0) {
    swLines.push('');
    swLines.push('负向因素：');
    for (const p of secondWave.negatives) swLines.push(`- ${p}`);
  }
  if (secondWave.needs.length > 0) {
    swLines.push('');
    swLines.push('需要：');
    for (const n of secondWave.needs) swLines.push(`+ ${n}`);
  }
  if (secondWave.risks.length > 0) {
    swLines.push('');
    swLines.push('风险：');
    for (const r of secondWave.risks) swLines.push(`⚠ ${r}`);
  }

  return {
    symbol,
    price,
    diagnosis: {
      lifecycle_history: {
        phases: uniqueCompleted.map(p => ({ phase: p.phase, label: phaseLabels[p.phase], status: '已完成', dateRange: `${p.startDate} → ${p.endDate}` })),
        current: { phase: currentPhase, label: currentLabel, status: '当前' },
        view: historyView,
      },
      accumulation_status: {
        status: accStatus.status,
        label: accStatus.statusLabel,
        score: accStatus.score,
        reasons: accStatus.reasons,
        metrics: accStatus.metrics,
      },
      trading_role: {
        role: tradingRole.role,
        description: tradingRole.description,
        metrics: tradingRole.keyMetrics,
      },
      second_wave_potential: {
        potential: secondWave.potential,
        score: secondWave.netScore,
        positives: secondWave.positives,
        negatives: secondWave.negatives,
        needs: secondWave.needs,
        risks: secondWave.risks,
      },
    },
    formatted: `
━━━━━━━━━━━━━━━━
${symbol}
━━━━━━━━━━━━━━━━

🔬 生命周期诊断

历史阶段：
${historyView}


稀筹状态：
${accStatusLabel(accStatus.statusLabel)}

原因：
${accStatus.reasons.join('\n')}


当前交易角色：
${tradingRole.role}

说明：
${tradingRole.description}


二次上涨可能：
${swEmoji} ${secondWave.potential}

${secondWave.positives.length > 0 ? '正向因素：\n' + secondWave.positives.map(p => '+ ' + p).join('\n') : ''}
${secondWave.negatives.length > 0 ? '\n负向因素：\n' + secondWave.negatives.map(p => '- ' + p).join('\n') : ''}
${secondWave.needs.length > 0 ? '\n需要：\n' + secondWave.needs.map(n => '+ ' + n).join('\n') : ''}
${secondWave.risks.length > 0 ? '\n风险：\n' + secondWave.risks.map(r => '⚠ ' + r).join('\n') : ''}
━━━━━━━━━━━━━━━━
`.trim(),
  };
}

function accStatusLabel(label) {
  return label;
}

// ═══ 评分引擎 V1.0 — 机会质量 + 交易风险 双维度 ═══
//
// 机会质量评分：这个币本身值不值得研究（0-100）
// 交易风险评分：当前时机风险多高（0-100，越高越危险）

function calcQualityScore(klines, phases, accStatus, tradingRole, secondWave) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  const price = closes[n - 1];
  const bonuses = [];
  let total = 0;

  // 1. 生命周期位置（30分）
  const roleScoreMap = { '底部观察': 15, '启动跟踪': 30, '趋势跟随': 28, '反弹交易': 18, '高位防守': 8, '观望': 10 };
  let posScore = roleScoreMap[tradingRole.role] || 10;
  if (accStatus.status === 'completed') { bonuses.push('生命周期转换完成'); posScore = Math.min(30, posScore + 2); }
  else if (accStatus.status === 'suspected_end') { bonuses.push('吸筹疑似结束'); posScore = Math.min(30, posScore + 1); }
  if (tradingRole.role === '底部观察') { bonuses.push('底部观察：非交易信号，等待确认'); }
  total += posScore;

  // 2. 资金活跃度（25分）
  let actScore = 0;
  const volNow = vols.slice(-30).reduce((s, v) => s + v, 0) / 30;
  const volPrior = vols.slice(-90, -30).reduce((s, v) => s + v, 0) / 60;
  const volRatio = volPrior > 0 ? volNow / volPrior : 1;
  if (volRatio > 2.0) { actScore += 15; bonuses.push('成交量显著放大(' + volRatio.toFixed(1) + 'x)'); }
  else if (volRatio > 1.5) { actScore += 12; bonuses.push('成交量明显提升'); }
  else if (volRatio > 1.2) { actScore += 8; bonuses.push('成交量温和增长'); }
  else if (volRatio > 0.9) { actScore += 5; }
  else { actScore += 2; }
  const atrVals = atr(klines, 14);
  const atrRatio = atrVals.slice(-14).reduce((s,v)=>s+v,0)/14 / (atrVals.slice(-60,-14).reduce((s,v)=>s+v,0)/46 || 1);
  if (atrRatio > 1.5) { actScore += 5; bonuses.push('波动率上升'); }
  else if (atrRatio > 1.1) { actScore += 3; }
  else { actScore += 2; }
  total += Math.min(25, actScore);

  // 3. 价格结构（20分）
  let structScore = 0;
  const ma20 = ema(closes, 20), ma60 = ema(closes, 60);
  if (price > ma20[ma20.length-1] && ma20[ma20.length-1] > ma60[ma60.length-1]) { structScore += 8; bonuses.push('多头排列'); }
  else if (price > ma60[ma60.length-1]) { structScore += 5; }
  else if (price > ma60[ma60.length-1] * 0.9) { structScore += 3; }
  else { structScore += 1; }
  const absLow = Math.min(...lows);
  const priceVsLow = (price - absLow) / absLow;
  if (priceVsLow > 0.50 && priceVsLow < 2.0) { structScore += 6; bonuses.push('已脱离底部区域'); }
  else if (priceVsLow > 0.20) { structScore += 3; }
  else { structScore += 1; }
  const recent30Range = (Math.max(...highs.slice(-30)) - Math.min(...lows.slice(-30))) / price;
  if (recent30Range < 0.15) { structScore += 6; bonuses.push('横盘稳定'); }
  else if (recent30Range < 0.30) { structScore += 3; }
  else { structScore += 1; }
  total += Math.min(20, structScore);

  // 4. 市场关注（15分）
  let attentionScore = 0;
  const absChange = Math.abs(((price - closes[Math.max(0, n - 2)]) / closes[Math.max(0, n - 2)] * 100) || 0);
  if (absChange > 5) attentionScore += 5;
  else if (absChange > 2) attentionScore += 3;
  else attentionScore += 1;
  const volChange24h = vols[n - 1] / (vols.slice(-7, -1).reduce((s,v)=>s+v,0)/6 || 1);
  if (volChange24h > 2) { attentionScore += 5; bonuses.push('24h成交量异常'); }
  else if (volChange24h > 1.5) { attentionScore += 3; }
  else attentionScore += 1;
  if (secondWave.potential === '存在') { attentionScore += 5; bonuses.push('二次上涨可能存在'); }
  else if (secondWave.potential === '等待确认') { attentionScore += 2; }
  total += Math.min(15, attentionScore);

  // 5. 流动性（10分）
  let liqScore = 0;
  const quoteVol = klines[n-1]?.quoteVolume || 0;
  if (quoteVol > 10e6) liqScore = 10;
  else if (quoteVol > 1e6) liqScore = 8;
  else if (quoteVol > 100e3) liqScore = 5;
  else if (quoteVol > 50e3) liqScore = 2;
  else liqScore = 0;
  total += liqScore;

  return { score: Math.min(100, Math.round(total)), bonuses, breakdown: { position: posScore, activity: Math.min(25, actScore), structure: Math.min(20, structScore), attention: Math.min(15, attentionScore), liquidity: liqScore } };
}

function calcRiskScore(klines, phases, accStatus, tradingRole) {
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const n = klines.length;
  const price = closes[n - 1];
  const absLow = Math.min(...lows);
  const ath = Math.max(...highs);
  const priceVsLow = (price - absLow) / absLow;
  const priceVsATH = (price - ath) / ath;

  // ═══ 下跌风险（0-100） ═══
  let downRisk = 0;
  const downRisks = [];

  // MA60方向
  const ma60 = ema(closes, 60);
  const ma60Now = ma60[ma60.length - 1];
  const ma60Prev = ma60[Math.max(0, ma60.length - 30)];
  const ma60Slope = ma60Prev > 0 ? (ma60Now - ma60Prev) / ma60Prev : 0;
  if (ma60Slope < -0.10) { downRisk += 30; downRisks.push('MA60快速下降'); }
  else if (ma60Slope < -0.05) { downRisk += 20; downRisks.push('MA60下降中'); }
  else if (ma60Slope < 0) { downRisk += 10; }

  // 价格位置 vs MA60
  if (price < ma60Now * 0.9) { downRisk += 25; downRisks.push('价格远低于MA60'); }
  else if (price < ma60Now) { downRisk += 15; }

  // 30天新低
  const recent30Low = Math.min(...lows.slice(-30));
  const prior30Low = Math.min(...lows.slice(-60, -30));
  if (recent30Low < prior30Low * 0.95) { downRisk += 25; downRisks.push('近期持续创新低'); }

  // 成交量衰减
  const volNow = vols.slice(-30).reduce((s,v)=>s+v,0)/30;
  const volPrior = vols.slice(-90,-30).reduce((s,v)=>s+v,0)/60;
  const volRatio = volPrior > 0 ? volNow / volPrior : 1;
  if (volRatio < 0.5) { downRisk += 20; downRisks.push('成交量急剧萎缩'); }
  else if (volRatio < 0.7) { downRisk += 10; }

  downRisk = Math.min(100, downRisk);

  // ═══ 追高风险（0-100） ═══
  let chaseRisk = 0;
  const chaseRisks = [];

  if (priceVsLow > 3) { chaseRisk += 35; chaseRisks.push('距低点涨幅超300%'); }
  else if (priceVsLow > 2) { chaseRisk += 25; chaseRisks.push('已有较大涨幅'); }
  else if (priceVsLow > 1) { chaseRisk += 15; }

  if (priceVsATH > -0.10) { chaseRisk += 30; chaseRisks.push('接近历史高点'); }
  else if (priceVsATH > -0.20) { chaseRisk += 20; }

  // 放量滞涨
  const ret7 = closes[n - 1] / closes[Math.max(0, n - 8)] - 1;
  if (volRatio > 1.5 && Math.abs(ret7) < 0.03) { chaseRisk += 20; chaseRisks.push('放量滞涨'); }

  // 高波动
  const trs = [];
  for (let i = 1; i < n; i++) trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  let sum = 0;
  for (let i = 0; i < 14 && i < trs.length; i++) sum += trs[i];
  const atrVals = [sum/Math.min(14,trs.length)];
  for (let i = 1; i < trs.length; i++) atrVals.push((atrVals[i-1]*13+trs[i])/14);
  const atrPct = atrVals.slice(-14).reduce((s,v)=>s+v,0)/14/price;
  if (atrPct > 0.08) { chaseRisk += 15; chaseRisks.push('高波动'); }

  chaseRisk = Math.min(100, chaseRisk);

  return {
    downside_risk: { score: Math.round(downRisk), risks: downRisks },
    chase_risk: { score: Math.round(chaseRisk), risks: chaseRisks },
    score: Math.round((downRisk + chaseRisk) / 2),
    risks: [...downRisks, ...chaseRisks],
  };
}

// ═══ 确认条件 / 失效条件 生成 ═══
function generateConditions(klines, phases, accStatus, tradingRole, secondWave) {
  const confirmation = [];
  const invalid = [];
  const role = tradingRole.role;

  if (role === '底部观察') {
    confirmation.push('成交量开始温和放大', '价格不再创新低', '形成底部结构（横盘>30天）', 'MA60走平或向上');
    invalid.push('价格跌破近期低点', '成交量继续萎缩至枯竭', '大盘环境恶化', 'MA60持续下降');
  } else if (role === '启动跟踪') {
    confirmation.push('突破关键压力位', '成交量持续放大', '回踩确认支撑');
    invalid.push('跌破启动成本区', '放量滞涨', '突破后快速回落');
  } else if (role === '趋势跟随') {
    confirmation.push('MA60保持向上', '回调不破MA60', '成交量维持活跃');
    invalid.push('跌破MA60且无法收回', '成交持续萎缩至地量', '出现明显派发信号');
  } else if (role === '高位防守') {
    confirmation.push('出现顶部结构确认', '成交量背离', '资金流出加速');
    invalid.push('继续创新高且量价配合', '突破前高且回踩不破');
  } else if (role === '反弹交易') {
    confirmation.push('重新站上MA20', '成交量恢复', '出现阳线吞没');
    invalid.push('继续下跌破前低', '反弹缩量', '反弹不过前高');
  } else {
    confirmation.push('出现明确方向信号', '成交量异常变化', '突破近期震荡区间');
    invalid.push('长期无方向', '成交量持续低迷', '市场结构恶化');
  }

  // 二波相关
  if (secondWave.potential === '存在' || secondWave.potential === '等待确认') {
    confirmation.push('突破整理区间上沿');
    invalid.push('跌破整理区间下沿');
  }

  return { confirmation_conditions: confirmation, invalid_conditions: invalid };
}

// ═══ 主诊断函数 ═══
async function diagnose(symbol) {
  L(`分析 ${symbol}...`);
  let klines;
  try {
    klines = await getKlines(symbol, 365);
  } catch (e) {
    L(`  ⚠ K线拉取失败: ${e.message}`);
    return null;
  }
  if (klines.length < 60) {
    L(`  ⚠ 数据不足（${klines.length}根）`);
    return null;
  }

  const phases = detectLifecyclePhases(klines);
  const accStatus = checkAccumulationStatus(klines, phases);
  const tradingRole = determineTradingRole(klines, phases, accStatus);
  const secondWave = assessSecondWavePotential(klines, phases, accStatus);
  const result = formatDiagnosis(symbol, klines, phases, accStatus, tradingRole, secondWave);

  // ═══ V1.0 评分 + 条件 ═══
  const quality = calcQualityScore(klines, phases, accStatus, tradingRole, secondWave);
  const risk = calcRiskScore(klines, phases, accStatus, tradingRole);
  const conditions = generateConditions(klines, phases, accStatus, tradingRole, secondWave);
  result.diagnosis.scoring = {
    model_version: 'lifecycle-v1.1',
    score_version: 'score-v1.1',
    opportunity_quality_score: quality,
    trading_risk_score: risk,
    ...conditions,
  };

  L(`  ✅ ${symbol}: ${phases.length}个阶段 | 稀筹${accStatus.statusLabel} | 角色${tradingRole.role} | 质量${quality.score}分 风险${risk.score}分`);
  L(`  轨迹: ${phases.map(p => p.phase).join(' → ')}`);
  return result;
}

// ═══ 批量诊断 ═══
async function batchDiagnose(symbols, resultsArray) {
  const results = resultsArray || [];
  for (let i = 0; i < symbols.length; i++) {
    const result = await diagnose(symbols[i]);
    if (result) results.push(result);
    if (i < symbols.length - 1) await new Promise(r => setTimeout(r, 200)); // rate limit
  }
  return results;
}

// ═══ 主入口 ═══
//
// 三种运行模式：
//   1. node lifecycle-diagnosis-v2.js                  → 全市场扫描
//   2. node lifecycle-diagnosis-v2.js XNY BTC ETH       → 指定币种诊断
//   3. node lifecycle-diagnosis-v2.js --from-signals     → 从 accumulation_signals.json 读取
//
async function main() {
  // 只在直接运行时执行，require 时不执行
  if (require.main !== module) return;
  const t0 = Date.now();
  L('🔬 生命周期诊断 V2 — 全市场扫描模式');

  const args = process.argv.slice(2);
  const { fetchAllSymbols, fetchTickers, filterByLiquidity, fetchFundingRates } = require('./market-scanner');

  // 扫描日志
  const scanLog = {
    startedAt: new Date().toISOString(),
    totalFetched: 0,
    afterFilter: 0,
    success: 0,
    failed: 0,
    failures: [],
    byRole: {},
  };

  let targets = [];

  // ── 模式1: 指定币种 ──
  if (args.length > 0 && !args.includes('--from-signals')) {
    targets = args;
    L(`指定币种: ${targets.join(', ')}`);
  }
  // ── 模式2: 从信号文件读取 ──
  else if (args.includes('--from-signals')) {
    const sigFile = path.join(DATA_DIR, 'accumulation_signals.json');
    if (fs.existsSync(sigFile)) {
      const data = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
      targets = (data.signals || []).map(s => s.symbol);
      L(`从信号文件读取 ${targets.length} 个币种`);
    }
  }
  // ── 模式3: 全市场扫描（默认） ──
  else {
    L('📡 获取币安全量 USDT 交易对...');
    const result = await fetchAllSymbols({ includeSpot: true, includeFutures: true });
    const allSymbols = result.symbols;
    scanLog.totalFetched = allSymbols.length;
    scanLog.marketSources = { spot: result.spotCount, futures: result.futuresCount };
    L(`  共 ${allSymbols.length} 个（现货${result.spotCount} 合约${result.futuresCount}）`);

    // 批量获取 ticker 数据
    L('📊 获取 24h 数据...');
    const [futuresTickers, spotTickers, fundingRates] = await Promise.all([
      fetchTickers([], true),
      fetchTickers([], false),
      fetchFundingRates(),
    ]);
    const allTickers = { ...spotTickers, ...futuresTickers };
    L(`  ticker: ${Object.keys(allTickers).length} 条`);

    // 基础过滤
    const minVol = process.env.MIN_VOLUME_24H ? parseFloat(process.env.MIN_VOLUME_24H) : 50000;
    const { filtered, skipped } = filterByLiquidity(allSymbols, allTickers, minVol);
    scanLog.afterFilter = filtered.length;
    scanLog.skipped = skipped;
    L(`  通过 ${filtered.length} 个（低量${skipped.lowVol} 无数据${skipped.noData}）`);

    // 附加 ticker 和资金费率
    targets = filtered.map(f => {
      const sym = f.baseAsset;
      const t = f.ticker;
      return {
        symbol: sym,
        symbolRaw: f.symbol,
        market: f.market,
        hasFutures: f.hasFutures !== false,
        hasSpot: f.hasSpot !== false || f.market === 'spot',
        price: t.price,
        change24h: t.change24h,
        volume24h: t.volume24h,
        fundingRate: fundingRates[f.symbol] || 0,
      };
    });
  }

  if (targets.length === 0) {
    L('无目标币种');
    process.exit(0);
  }

  // ═══ 全量诊断（优先级评分替代硬截断） ═══
  const isFullScan = typeof targets[0] === 'object'; // 全市场扫描时 targets 是对象数组
  const symbolList = isFullScan ? targets.map(t => t.symbol) : targets;

  // 扫描覆盖报告
  const coverageReport = {
    scan_time: new Date().toISOString(),
    binance_symbols_total: scanLog.totalFetched || symbolList.length,
    ticker_success_count: isFullScan ? (scanLog.afterFilter + (scanLog.skipped?.lowVol || 0) + (scanLog.skipped?.noData || 0)) : symbolList.length,
    liquidity_pass_count: isFullScan ? scanLog.afterFilter : symbolList.length,
    lifecycle_analyzed_count: 0,
    lifecycle_skipped_count: 0,
    skipped_symbols: [],
    unscanned_symbols: [],
  };

  let batch = symbolList;
  let skippedForLater = [];

  if (isFullScan && targets.length > 0) {
    // ═══ 优先级评分（替代 MAX_SCAN 硬截断） ═══
    const { calcPriorityScore } = require('./market-scanner');

    // 给每个币打分
    const scored = targets.map(t => ({
      ...t,
      priorityScore: calcPriorityScore(
        { volume24h: t.volume24h, change24h: t.change24h, high24h: 0, low24h: 0, price: t.price, trades: 0 },
        t.fundingRate
      ),
    }));

    // 按优先级降序排列
    scored.sort((a, b) => b.priorityScore - a.priorityScore);

    const MAX_ANALYZE = parseInt(process.env.MAX_SCAN || '0') || 300;
    const toAnalyze = scored.slice(0, MAX_ANALYZE);
    const unscanned = scored.slice(MAX_ANALYZE);

    batch = toAnalyze.map(t => t.symbol);
    skippedForLater = unscanned.map(t => ({
      symbol: t.symbol,
      priorityScore: t.priorityScore,
      volume24h: t.volume24h,
      change24h: t.change24h,
      reason: `优先级${t.priorityScore}分，低于当前扫描阈值（前${MAX_ANALYZE}名入选）`,
    }));

    // 更新覆盖报告
    coverageReport.lifecycle_skipped_count = unscanned.length;
    coverageReport.unscanned_symbols = skippedForLater;
    coverageReport.liquidity_bypassed = (scanLog.skipped?.lowVol || 0) + (scanLog.skipped?.noData || 0);

    L(`  优先级排序完成: 高优先 ${toAnalyze.length} 个 → 暂缓 ${unscanned.length} 个`);
    if (unscanned.length > 0) {
      L(`  低分样本: ${unscanned.slice(0, 3).map(u => u.symbol + '(' + u.priorityScore + '分)').join(', ')}...`);
    }
  }

  L(`\n🔍 开始诊断 ${batch.length} 个币种...`);

  const results = [];
  let done = 0;
  for (let i = 0; i < batch.length; i++) {
    const sym = batch[i];
    try {
      const result = await diagnose(sym);
      if (result) {
        // 全市场扫描时附加市场数据
        if (isFullScan && targets[i]) {
          result.marketData = {
            volume24h: targets[i].volume24h,
            change24h: targets[i].change24h,
            fundingRate: targets[i].fundingRate,
            market: targets[i].market,
          };
        }
        results.push(result);
        scanLog.success++;
        const role = result.diagnosis.trading_role.role;
        scanLog.byRole[role] = (scanLog.byRole[role] || 0) + 1;
      } else {
        scanLog.failed++;
        scanLog.failures.push({ symbol: sym, reason: '数据不足或K线拉取失败' });
      }
    } catch (e) {
      scanLog.failed++;
      const reason = e.message?.includes('400') ? '交易对不存在(400)' :
                     e.message?.includes('timeout') ? '请求超时' :
                     e.message?.slice(0, 60);
      scanLog.failures.push({ symbol: sym, reason });
    }
    done++;
    if (done % 10 === 0) {
      L(`  进度 ${done}/${batch.length} | ✅${scanLog.success} ❌${scanLog.failed}`);
    }
    if (i < batch.length - 1) await new Promise(r => setTimeout(r, 150));
  }

  // ═══ 阶段分类 ═══
  const categories = {
    accumulation: { label: '🟢 吸筹发现', items: [] },
    launch: { label: '🟡 等待突破', items: [] },
    trend: { label: '🟠 趋势跟踪', items: [] },
    defense: { label: '🔴 高位风险', items: [] },
    bounce: { label: '🔵 反弹交易', items: [] },
    watch: { label: '⚪ 观望', items: [] },
  };

  for (const r of results) {
    const role = r.diagnosis.trading_role.role;
    if (role === '底部观察') categories.accumulation.items.push(r);
    else if (role === '启动跟踪') categories.launch.items.push(r);
    else if (role === '趋势跟随') categories.trend.items.push(r);
    else if (role === '高位防守') categories.defense.items.push(r);
    else if (role === '反弹交易') categories.bounce.items.push(r);
    else categories.watch.items.push(r);
  }

  // 每类按二波潜力排序
  for (const cat of Object.values(categories)) {
    cat.items.sort((a, b) => {
      const waveOrder = { '存在': 3, '等待确认': 2, '不存在': 1 };
      return (waveOrder[b.diagnosis.second_wave_potential.potential] || 0) -
             (waveOrder[a.diagnosis.second_wave_potential.potential] || 0);
    });
  }

  // ═══ 输出报告 ═══
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  scanLog.durationSec = dur;
  scanLog.completedAt = new Date().toISOString();

  console.log('\n' + '═'.repeat(60));
  console.log('🔬 生命周期诊断 V2 — 扫描报告');
  console.log('═'.repeat(60));

  if (isFullScan) {
    console.log(`\n📡 全市场: ${scanLog.totalFetched} 交易对 → 过滤后 ${scanLog.afterFilter} → 诊断 ${scanLog.success}`);
  }

  console.log(`\n⏱ 耗时: ${dur}s | ✅ ${scanLog.success} | ❌ ${scanLog.failed}`);

  // 阶段分布
  console.log('\n📊 阶段分布:');
  for (const [key, cat] of Object.entries(categories)) {
    if (cat.items.length > 0) {
      const top3 = cat.items.slice(0, 3).map(r => r.symbol).join(', ');
      console.log(`  ${cat.label}: ${cat.items.length}个  (${top3}${cat.items.length > 3 ? '...' : ''})`);
    }
  }

  // 重点展示：稀筹已完成 + 二波存在的币
  const hotList = results.filter(r =>
    r.diagnosis.accumulation_status.status === 'completed' &&
    r.diagnosis.second_wave_potential.potential === '存在'
  );
  if (hotList.length > 0) {
    console.log(`\n🔥 稀筹完成 + 二波存在 (${hotList.length}个):`);
    for (const r of hotList.slice(0, 10)) {
      console.log(`  ${r.symbol.padEnd(8)} $${r.price?.toFixed(4) || 'N/A'} 角色:${r.diagnosis.trading_role.role}`);
    }
  }

  // 失败原因汇总
  if (scanLog.failures.length > 0) {
    console.log(`\n⚠ 失败 ${scanLog.failures.length} 个:`);
    const byReason = {};
    for (const f of scanLog.failures) {
      const key = f.reason.slice(0, 40);
      byReason[key] = (byReason[key] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  // ═══ 保存 ═══
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 诊断数据
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDiagnosed: results.length,
    scanLog: isFullScan ? {
      totalFetched: scanLog.totalFetched,
      afterFilter: scanLog.afterFilter,
      success: scanLog.success,
      failed: scanLog.failed,
      durationSec: dur,
    } : undefined,
    categories: Object.fromEntries(
      Object.entries(categories).map(([k, v]) => [k, { label: v.label, count: v.items.length }])
    ),
    results: results.map(r => ({
      symbol: r.symbol,
      price: r.price,
      diagnosis: r.diagnosis,
      marketData: r.marketData,
    })),
  }, null, 2));
  L(`✅ 保存 ${results.length} 个诊断 → ${OUTPUT_FILE}`);

  // 扫描日志
  const logFile = path.join(DATA_DIR, 'lifecycle_scan_log.json');
  fs.writeFileSync(logFile, JSON.stringify(scanLog, null, 2));
  L(`✅ 扫描日志 → ${logFile}`);

  // ═══ 扫描覆盖报告 ═══
  coverageReport.lifecycle_analyzed_count = scanLog.success;
  if (isFullScan) {
    const covFile = path.join(DATA_DIR, 'market_scan_report.json');
    if (scanLog.skipped) {
      coverageReport.skipped_by_liquidity = { lowVol: scanLog.skipped.lowVol || 0, noData: scanLog.skipped.noData || 0 };
    }
    // 合并所有跳过原因到 skipped_symbols
    coverageReport.skipped_symbols = [
      ...(skippedForLater || []),
    ];
    fs.writeFileSync(covFile, JSON.stringify(coverageReport, null, 2));
    L(`✅ 覆盖报告 → ${covFile}`);
    console.log(`\n📡 扫描覆盖: ${coverageReport.binance_symbols_total}总 → ${coverageReport.liquidity_pass_count}通过 → ${coverageReport.lifecycle_analyzed_count}分析 → ${coverageReport.lifecycle_skipped_count}暂缓`);
  }

  // ═══ 保存预测快照（回测用） ═══
  if (results.length > 0) {
    try {
      const { savePredictions } = require('./lifecycle-backtest');
      savePredictions(results, new Date().toISOString());
    } catch (e) {
      L(`⚠ 预测记录失败: ${e.message}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });

// ═══ 导出供 server.js 调用 ═══
module.exports = { diagnose, batchDiagnose, detectLifecyclePhases, checkAccumulationStatus, determineTradingRole, assessSecondWavePotential };
