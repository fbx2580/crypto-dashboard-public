// =====================================================================
// 市场状态识别 + 预测分析引擎
// Regime Detection & Trading Signal Analysis
// =====================================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── Config ───
const SYMBOLS = [
  { name: 'SOL', coinGeckoId: 'solana' },
  { name: 'BTC', coinGeckoId: 'bitcoin' },
  { name: 'ETH', coinGeckoId: 'ethereum' },
];

const DAYS = 14; // How much history to analyze
const CACHE_DIR = path.join(__dirname, 'public', 'analysis');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Data Fetching ───
async function fetchOHLC(coinId, days = DAYS) {
  const cacheFile = path.join(CACHE_DIR, `${coinId}_${days}d.json`);
  
  // Check cache (fresh for 10 min)
  if (fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < 10 * 60 * 1000) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  }

  try {
    // Try 4h candles first
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;
    const res = await axios.get(url, { timeout: 15000 });
    const raw = res.data;
    
    // Format: [timestamp_ms, open, high, low, close]
    const candles = raw.map(c => ({
      time: Math.floor(c[0] / 1000),
      open: c[1], high: c[2], low: c[3], close: c[4],
    }));
    
    fs.writeFileSync(cacheFile, JSON.stringify(candles));
    console.log(`  ✓ Fetched ${candles.length} candles for ${coinId}`);
    return candles;
  } catch (err) {
    console.error(`  ✗ Failed to fetch ${coinId}: ${err.message}`);
    return [];
  }
}

// ─── Technical Indicators ───

// Simple Moving Average
function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

// ATR: Average True Range
function ATR(candles, period = 14) {
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr.push(candles[i].high - candles[i].low); continue; }
    const prev = candles[i - 1];
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - prev.close);
    const lc = Math.abs(candles[i].low - prev.close);
    tr.push(Math.max(hl, hc, lc));
  }
  return SMA(tr, period);
}

// ADX: Average Directional Index
function ADX(candles, period = 14) {
  const n = candles.length;
  const plusDM = [0], minusDM = [0];
  const tr = [candles[0].high - candles[0].low];
  
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    
    let pDM = 0, mDM = 0;
    if (upMove > downMove && upMove > 0) pDM = upMove;
    if (downMove > upMove && downMove > 0) mDM = downMove;
    plusDM.push(pDM);
    minusDM.push(mDM);
    
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }
  
  const smoothPDM = SMA(plusDM, period);
  const smoothMDM = SMA(minusDM, period);
  const smoothTR = SMA(tr, period);
  
  const dx = [];
  for (let i = 0; i < n; i++) {
    if (!smoothPDM[i] || !smoothMDM[i] || !smoothTR[i] || smoothTR[i] === 0) {
      dx.push(null); continue;
    }
    const pDI = 100 * smoothPDM[i] / smoothTR[i];
    const nDI = 100 * smoothMDM[i] / smoothTR[i];
    const diDiff = Math.abs(pDI - nDI);
    const diSum = pDI + nDI;
    dx.push(diSum > 0 ? 100 * diDiff / diSum : 0);
  }
  
  return SMA(dx, period);
}

// RSI
function RSI(data, period = 14) {
  const rsi = [null];
  let gains = 0, losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    gains += Math.max(diff, 0);
    losses += Math.max(-diff, 0);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  
  // Pad with nulls
  while (rsi.length < data.length) rsi.unshift(null);
  return rsi;
}

// Bollinger Band Width (volatility indicator)
function BBWidth(candles, period = 20) {
  const closes = candles.map(c => c.close);
  const sma = SMA(closes, period);
  const width = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1 || sma[i] === null) { width.push(null); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - sma[i]) ** 2;
    const std = Math.sqrt(sumSq / period);
    const bbw = (4 * std) / sma[i] * 100; // Band width as % of price
    width.push(bbw);
  }
  return width;
}

// ─── Regime Classification ───
function classifyRegime(candles) {
  if (candles.length < 30) return { regime: '数据不足', confidence: 0, details: {} };
  
  const closes = candles.map(c => c.close);
  const atr = ATR(candles, 14);
  const adx = ADX(candles, 14);
  const rsi = RSI(closes, 14);
  const bbw = BBWidth(candles, 20);
  const sma50 = SMA(closes, Math.min(50, candles.length));
  
  const latest = candles[candles.length - 1];
  const lastATR = atr[atr.length - 1] || 0;
  const lastADX = adx[adx.length - 1] || 0;
  const lastRSI = rsi[rsi.length - 1] || 50;
  const lastBBW = bbw[bbw.length - 1] || 0;
  const lastSMA50 = sma50[sma50.length - 1] || latest.close;
  
  // Volatility percentile (how extreme is current vol vs history)
  const validBBW = bbw.filter(v => v !== null);
  const volPercentile = validBBW.length > 0
    ? (validBBW.filter(v => v <= lastBBW).length / validBBW.length * 100)
    : 50;
  
  // ADX percentile
  const validADX = adx.filter(v => v !== null);
  const adxPercentile = validADX.length > 0
    ? (validADX.filter(v => v <= lastADX).length / validADX.length * 100)
    : 50;
  
  // Price position vs SMA
  const pricePosition = ((latest.close - lastSMA50) / lastSMA50) * 100;
  
  // ─── Regime Rules ───
  let regime = '震荡';
  let confidence = 50;
  let signals = [];
  let direction = '中性';
  let directionConfidence = 0;
  
  // 1. Extreme volatility
  if (volPercentile > 90) {
    regime = '极端行情';
    confidence = Math.min(volPercentile, 95);
    signals.push(`波动率处于历史 ${volPercentile.toFixed(0)}% 分位，极高`);
    
    if (pricePosition > 5) {
      direction = '偏空（极端拉涨后易回调）';
      directionConfidence = 60;
    } else if (pricePosition < -5) {
      direction = '偏多（极端杀跌后易反弹）';
      directionConfidence = 60;
    }
    
  // 2. Strong trend
  } else if (adxPercentile > 70 && lastADX > 25) {
    const isUp = lastRSI > 50;
    regime = isUp ? '单边上涨' : '单边下跌';
    confidence = Math.min(adxPercentile, 90);
    signals.push(`ADX ${lastADX.toFixed(1)}，趋势强度处于 ${adxPercentile.toFixed(0)}% 分位`);
    
    direction = isUp ? '偏多（趋势中）' : '偏空（趋势中）';
    directionConfidence = Math.min(lastADX / 50 * 70, 75);
    
    // Trend exhaustion warning
    if (isUp && lastRSI > 75) {
      signals.push(`⚠️ RSI ${lastRSI.toFixed(0)}，超买区域，注意趋势衰竭`);
      directionConfidence -= 15;
    }
    if (!isUp && lastRSI < 25) {
      signals.push(`⚠️ RSI ${lastRSI.toFixed(0)}，超卖区域，可能反弹`);
      directionConfidence = Math.max(directionConfidence - 15, 0);
    }
    
  // 3. Ranging / Chopping
  } else {
    regime = '震荡';
    confidence = 100 - adxPercentile;
    signals.push(`ADX ${lastADX.toFixed(1)}，无明显趋势`);
    
    if (volPercentile < 20) {
      signals.push('⏳ 波动率极低，正在蓄力，可能出方向');
      direction = '待定（蓄力中，突破方向需确认）';
      directionConfidence = 30;
    } else {
      // Check if near range boundaries
      const recentHigh = Math.max(...closes.slice(-20));
      const recentLow = Math.min(...closes.slice(-20));
      const rangePos = (latest.close - recentLow) / (recentHigh - recentLow) * 100;
      
      if (rangePos > 85) {
        direction = '偏空（震荡区间上沿）';
        directionConfidence = 50;
        signals.push(`处于震荡区间上沿(${rangePos.toFixed(0)}%)，关注阻力`);
      } else if (rangePos < 15) {
        direction = '偏多（震荡区间下沿）';
        directionConfidence = 50;
        signals.push(`处于震荡区间下沿(${rangePos.toFixed(0)}%)，关注支撑`);
      } else {
        direction = '中性（震荡中段，观望）';
        directionConfidence = 20;
      }
    }
  }
  
  return {
    regime,
    confidence,
    adx: lastADX,
    rsi: lastRSI,
    volPercentile,
    pricePosition,
    signals,
    direction,
    directionConfidence,
    currentPrice: latest.close,
    timestamp: latest.time,
  };
}

// ─── Volume Analysis ───
function analyzeVolume(candles) {
  if (candles.length < 10) return {};
  
  const volumes = candles.map(c => ({ vol: c.close * (c.high - c.low + c.close - c.open), time: c.time }));
  const avgVol = volumes.reduce((s, v) => s + v.vol, 0) / volumes.length;
  const lastVol = volumes[volumes.length - 1].vol;
  const recent5 = volumes.slice(-5).reduce((s, v) => s + v.vol, 0) / 5;
  
  const volRatio = lastVol / avgVol;
  const volTrend = recent5 / avgVol;
  
  let status = 'normal';
  let msg = `平均量 ${(avgVol / 1e6).toFixed(1)}M，当前 ${(lastVol / 1e6).toFixed(1)}M`;
  
  if (volRatio > 3) {
    status = 'surge';
    msg = `🔴 放量 ${volRatio.toFixed(1)}x 当前量 ${(lastVol / 1e6).toFixed(1)}M`;
  } else if (volRatio > 2) {
    status = 'increased';
    msg = `🟡 量增 ${volRatio.toFixed(1)}x 当前量 ${(lastVol / 1e6).toFixed(1)}M`;
  } else if (volTrend > 1.5) {
    msg = `📈 近5期量能上升 ${volTrend.toFixed(1)}x`;
  }
  
  return { volRatio, volTrend, avgVol, lastVol, status, msg };
}

// ─── Main Analysis ───
async function analyzeAll() {
  console.log('\n' + '='.repeat(60));
  console.log('   市场状态识别 · 多因子分析');
  console.log('='.repeat(60));
  
  const results = [];
  
  for (const sym of SYMBOLS) {
    console.log(`\n📊 ${sym.name} (${sym.coinGeckoId})`);
    console.log('-'.repeat(40));
    
    const candles = await fetchOHLC(sym.coinGeckoId, DAYS);
    if (candles.length < 20) {
      console.log('  数据不足，跳过');
      continue;
    }
    
    const regime = classifyRegime(candles);
    const vol = analyzeVolume(candles);
    
    console.log(`  当前价格: $${regime.currentPrice?.toFixed(2) || '—'}`);
    console.log(`  市场状态: ${regime.regime} (置信度 ${regime.confidence}%)`);
    console.log(`  方向判断: ${regime.direction} (${regime.directionConfidence}%)`);
    console.log(`  ADX: ${regime.adx?.toFixed(1) || '—'}  |  RSI: ${regime.rsi?.toFixed(0) || '—'}`);
    console.log(`  波动率: ${regime.volPercentile?.toFixed(0) || '—'}% 分位`);
    console.log(`  量能: ${vol.msg || '—'}`);
    
    if (regime.signals?.length > 0) {
      console.log(`  信号:`);
      regime.signals.forEach(s => console.log(`    • ${s}`));
    }
    
    results.push({
      symbol: sym.name,
      price: regime.currentPrice,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
      direction: regime.direction,
      directionConfidence: regime.directionConfidence,
      adx: regime.adx,
      rsi: regime.rsi,
      volStatus: vol.status,
      signals: regime.signals,
      timestamp: new Date().toISOString(),
    });
  }
  
  // Save analysis results
  const outputFile = path.join(CACHE_DIR, 'latest_analysis.json');
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  
  console.log('\n' + '='.repeat(60));
  console.log(`  分析结果已保存: ${outputFile}`);
  console.log('='.repeat(60));
  
  return results;
}

// Run if executed directly
if (require.main === module) {
  analyzeAll().catch(console.error);
}

module.exports = { analyzeAll, classifyRegime, analyzeVolume, fetchOHLC };
