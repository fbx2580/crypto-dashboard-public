#!/usr/bin/env node
/**
 * Accumulation Radar — 山寨币底部吸筹雷达
 * 
 * 独立监测模块，不修改交易评分。
 * 基于回测验证的5维因子:
 *   回撤程度 + 时间 + 波动收缩 + 价格结构 + 流动性
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const BINANCE = 'https://api.binance.com/api/v3';
const DIR = path.join(__dirname, 'public', 'data', 'analysis');
const OUT = path.join(DIR, 'accumulation_radar.json');

function L(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] [radar] ${m}`); }

async function gj(u, p = {}) { return (await axios.get(u, { params: p, timeout: 15000 })).data; }

// ═══ 评分引擎 ═══
function radarScore(coin, hist) {
  const closes = hist.map(k => parseFloat(k[4]));
  const highs = hist.map(k => parseFloat(k[2]));
  const lows = hist.map(k => parseFloat(k[3]));
  const vols = hist.map(k => parseFloat(k[5]));
  const curPrice = closes[closes.length - 1];

  // ① 回撤评分 (0-25) — 从历史高点跌多少
  const ath = Math.max(...closes);
  const dd = (curPrice - ath) / ath;
  let ddScore = 0;
  if (dd >= -0.50 && dd < -0.30) ddScore = 15;      // 小跌，可能有庄
  else if (dd >= -0.70 && dd < -0.50) ddScore = 25; // 最佳吸筹区
  else if (dd < -0.70) ddScore = 10;                 // 跌太多，庄可能跑了
  else ddScore = 5;                                   // 跌太少

  // ② 时间评分 (0-25) — 60-75天最稳(回测验证),90天+递减
  const accDays = coin.accumDays || 0;
  let timeScore = 0;
  if (accDays >= 60 && accDays <= 75) timeScore = 25;      // 最佳区间(稳健性验证)
  else if (accDays >= 45 && accDays < 60) timeScore = 20;  // 接近甜点
  else if (accDays > 75 && accDays <= 90) timeScore = 20;   // 稍长但仍好
  else if (accDays > 90) timeScore = 15;                     // 递减(90天+过量吸筹可能反效果)
  else if (accDays >= 30) timeScore = 10;                    // 太短
  else timeScore = 5;

  // ③ 波动评分 (0-20) — ATR收缩
  const trs = [];
  for (let i = 1; i < hist.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atrNow = trs.slice(-30).reduce((s, v) => s + v, 0) / 30 / curPrice;
  const atrPrev = trs.slice(-60, -30).reduce((s, v) => s + v, 0) / 30 / curPrice;
  const volContraction = atrPrev > 0 ? (atrNow - atrPrev) / atrPrev : 0;
  let volScore = 0;
  if (volContraction < -0.15) volScore = 20;     // 显著收缩
  else if (volContraction < -0.05) volScore = 15; // 轻微收缩
  else if (volContraction < 0) volScore = 10;     // 持平
  else volScore = 5;                               // 扩张（不稳定）

  // ④ 价格结构评分 (0-20) — MA60位置 + MA200
  const ma60 = closes.slice(-Math.min(60, closes.length)).reduce((s, c) => s + c, 0) / Math.min(60, closes.length);
  const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((s, c) => s + c, 0) / 200 : ma60;
  const priceVsMA60 = (curPrice - ma60) / ma60;
  let structScore = 0;
  if (priceVsMA60 > -0.10 && priceVsMA60 < 0.05) structScore = 20;  // 贴近MA60，结构好
  else if (priceVsMA60 > -0.20 && priceVsMA60 < 0.10) structScore = 15;
  else structScore = 5;
  if (curPrice < ma200) structScore = Math.max(structScore - 5, 0); // MA200之下打折

  // ⑤ 流动性评分 (0-10)
  const mcap = coin.marketCap || 0;
  const vol24 = coin.quoteVolume || 0;
  let liqScore = 0;
  if (mcap > 100e6 && vol24 > 1e6) liqScore = 10;     // 大市值+活跃
  else if (mcap > 10e6 && vol24 > 500e3) liqScore = 8;
  else if (vol24 > 100e3) liqScore = 5;
  else liqScore = 2;

  // ═══ 风险扣分 ═══
  const risks = [];
  let riskDeduct = 0;
  // 死亡流动性
  if (mcap < 1e6 && vol24 < 50e3) { riskDeduct += 15; risks.push({ reason: '死亡流动性', deduct: 15, detail: '市值<1M+日量<50K' }); }
  else if (mcap < 5e6) { riskDeduct += 8; risks.push({ reason: '低流动性', deduct: 8, detail: '市值<5M' }); }
  // 极端下跌
  if (dd < -0.90) { riskDeduct += 10; risks.push({ reason: '极端下跌', deduct: 10, detail: '距高点>90%' }); }
  // BTC环境
  const regime = coin.marketRegime || 'neutral';
  if (regime === 'bear') { riskDeduct += 8; risks.push({ reason: 'BTC熊市', deduct: 8, detail: 'BTC弱势压制吸筹信号' }); }
  else if (regime === 'panic') { riskDeduct += 20; risks.push({ reason: 'BTC恐慌', deduct: 20, detail: '恐慌市暂停吸筹信号' }); }
  // 假信号风险(只看形态没链上确认)
  if (coin.metCount < 3 && coin.score < 40) { riskDeduct += 5; risks.push({ reason: '弱信号', deduct: 5, detail: '仅2条件+低分' }); }

  // 综合
  const total = Math.max(0, ddScore + timeScore + volScore + structScore + liqScore - riskDeduct);
  let tier = '普通';
  if (total >= 90) tier = '🔥 高关注';
  else if (total >= 70) tier = '⭐ 吸筹候选';
  else if (total >= 40) tier = '👀 观察';

  return {
    symbol: coin.symbol,
    total,
    tier,
    breakdown: {
      drawdown: { score: ddScore, value: dd, label: `${(dd * 100).toFixed(0)}%`, reason: dd >= -0.70 && dd < -0.30 ? '最佳吸筹区(-50~-70%)' : dd < -0.90 ? '腰斩以下风险高' : '回撤不足' },
      time: { score: timeScore, value: accDays, label: `${accDays}天`, reason: accDays >= 60 && accDays <= 75 ? '60-75天最稳(回测验证)' : accDays > 90 ? '90天+递减(过拟合风险)' : '吸筹不充分' },
      volatility: { score: volScore, value: volContraction, label: volContraction < 0 ? `收缩${(Math.abs(volContraction) * 100).toFixed(0)}%` : '无收缩', reason: volContraction < -0.10 ? 'ATR显著收缩(庄控盘)' : '未收缩' },
      structure: { score: structScore, value: priceVsMA60, label: `距MA60 ${(priceVsMA60 * 100).toFixed(0)}%`, reason: priceVsMA60 > -0.10 ? '接近MA60(结构良好)' : '远离均线(弱结构)' },
      liquidity: { score: liqScore, value: mcap, label: mcap > 1e9 ? `$${(mcap / 1e9).toFixed(1)}B` : mcap > 1e6 ? `$${(mcap / 1e6).toFixed(0)}M` : 'N/A', reason: mcap > 100e6 ? '流动性充足' : mcap < 1e6 ? '⚠ 接近僵尸币' : '可交易' },
    },
    risks,
    riskDeduct,
    price: coin.price,
    score: coin.score,
    accType: coin.accType,
    entryStatus: coin.entryStatus,
    marketRegime: regime,
  };
}

// ═══ 主流程 ═══
async function main() {
  L('🔭 吸筹雷达启动');

  // 读取信号
  const sigFile = path.join(__dirname, 'public', 'data', 'analysis', 'accumulation_signals.json');
  const data = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
  const signals = (data.signals || []).filter(s => s.metCount >= 2);
  L(`${signals.length}个≥2条件币`);

  // 逐币分析 (取前100个高分币，节省API)
  const targets = signals.sort((a, b) => b.score - a.score).slice(0, 100);
  const results = [];
  let done = 0;

  for (const s of targets) {
    try {
      const hist = await gj(`${BINANCE}/klines`, { symbol: s.symbol + 'USDT', interval: '1d', limit: 200 });
      if (hist.length < 60) continue;
      results.push(radarScore(s, hist));
    } catch (e) { }
    done++;
    if (done % 3 === 0) await new Promise(r => setTimeout(r, 10));
  }

  // 排序
  results.sort((a, b) => b.total - a.total);

  // 统计
  const tiers = {
    high: results.filter(r => r.total >= 90),
    candidate: results.filter(r => r.total >= 70 && r.total < 90),
    watch: results.filter(r => r.total >= 40 && r.total < 70),
  };

  L(`\n═══ 吸筹雷达 ═══`);
  L(`🔥 高关注(≥90): ${tiers.high.length}`);
  L(`⭐ 候选(70-89): ${tiers.candidate.length}`);
  L(`👀 观察(40-69): ${tiers.watch.length}`);

  if (tiers.high.length > 0) {
    L('\n高关注列表:');
    for (const r of [...tiers.high, ...tiers.candidate].slice(0, 10)) {
      const b = r.breakdown;
      L(`  ${r.total}分 ${r.symbol.padEnd(10)} 回撤${b.drawdown.label} ${b.time.label} ${b.volatility.label} ${b.structure.label}`);
    }
  }

  // 保存
  const out = {
    scannedAt: new Date().toISOString(),
    totalAnalyzed: results.length,
    tiers: { high: tiers.high.length, candidate: tiers.candidate.length, watch: tiers.watch.length },
    results,
  };
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  L(`\n✅ 雷达数据 → ${OUT}`);
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
