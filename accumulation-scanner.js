#!/usr/bin/env node
/**
 * 山寨币底部吸筹扫描引擎 v2
 * 改进：多时间窗(30/60/90天) · 对敲过滤 · 动态阈值 · 吸筹时长/累计量
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Cloudflare WARP SOCKS5 代理，绕 Binance fapi IP封锁
const WARP_PROXY = 'socks5://127.0.0.1:40000';
const warpAgent = new SocksProxyAgent(WARP_PROXY);

const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');
const OUTPUT_FILE = path.join(DATA_DIR, 'accumulation_signals.json');

const MAJOR_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];
const STABLECOINS = new Set(['USDC','DAI','TUSD','BUSD','USDP','FDUSD','USDE','USDD','FRAX','LUSD','GUSD','MIM','USTC','sUSD','USDX','USR','EURS','EURC','AEUR','crvUSD','GHO','PYUSD','XUSD','BFUSD','USDS','USDCUSDT','DAIUSDT','TUSDUSDT','BUSDUSDT']);

// 动态稳定币检测：价格极稳（<1%波动）+ 价格接近$1
function isStablecoin(sym, klines) {
  if (STABLECOINS.has(sym.replace('USDT','').toUpperCase())) return true;
  if (klines.length < 10) return false;
  const last = klines[klines.length-1];
  const price = last.close;
  // 价格在$0.985~$1.015之间 + 日振幅<0.5% = 大概率稳定币
  const dayRange = last.high > 0 ? (last.high - last.low) / last.high : 0;
  if (Math.abs(price - 1.0) < 0.015 && dayRange < 0.005) return true;
  return false;
}

// ═══ 工具函数 ═══
async function getJSON(url, params = {}, useProxy = false) {
  const opts = { params, timeout: 15000 };
  if (useProxy) opts.httpsAgent = warpAgent;
  const res = await axios.get(url, opts);
  return res.data;
}
async function getDailyKlines(symbol, limit = 120, baseUrl = BINANCE_SPOT, useProxy = false) {
  const data = await getJSON(`${baseUrl}/klines`, { symbol, interval: '1d', limit }, useProxy);
  return data.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]),
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
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);
  const out = new Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
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
function pearson(xs, ys) {
  const rx = [], ry = [];
  for (let i = 1; i < Math.min(xs.length, ys.length); i++) { rx.push((xs[i] - xs[i-1]) / xs[i-1]); ry.push((ys[i] - ys[i-1]) / ys[i-1]); }
  const n = Math.min(rx.length, ry.length);
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) { sx += rx[i]; sy += ry[i]; sxy += rx[i] * ry[i]; sx2 += rx[i] * rx[i]; sy2 += ry[i] * ry[i]; }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

// ═══ 成交量分布（Volume Profile）═══
// 替代 min/max 区间，用量密集区作为真实吸筹区
function calcVolumeProfile(klines, nBins = 20) {
  const prices = klines.map(k => (k.high + k.low + k.close) / 3);
  const low = Math.min(...klines.map(k => k.low));
  const high = Math.max(...klines.map(k => k.high));
  const step = (high - low) / nBins;
  const bins = [];
  for (let i = 0; i < nBins; i++) {
    bins.push({ priceLow: low + i * step, priceHigh: low + (i + 1) * step, volume: 0 });
  }
  // 分配每根K线的成交量到所在价格带
  for (const k of klines) {
    const kLow = Math.min(k.open, k.close);
    const kHigh = Math.max(k.open, k.close);
    for (const bin of bins) {
      if (kHigh >= bin.priceLow && kLow <= bin.priceHigh) {
        const overlapLow = Math.max(kLow, bin.priceLow);
        const overlapHigh = Math.min(kHigh, bin.priceHigh);
        const ratio = (overlapHigh - overlapLow) / (kHigh - kLow || 1);
        bin.volume += k.volume * Math.max(0, Math.min(1, ratio));
      }
    }
  }
  // 找成交量最大的 60% 作为真实吸筹带
  bins.sort((a, b) => b.volume - a.volume);
  const totalVol = bins.reduce((s, b) => s + b.volume, 0);
  let cumVol = 0;
  const denseBins = [];
  for (const bin of bins) {
    if (cumVol / totalVol >= 0.6) break;
    cumVol += bin.volume;
    denseBins.push(bin);
  }
  const denseLow = Math.min(...denseBins.map(b => b.priceLow));
  const denseHigh = Math.max(...denseBins.map(b => b.priceHigh));
  // 成交量加权均价
  const tvp = denseBins.reduce((s, b) => s + (b.priceLow + b.priceHigh) / 2 * b.volume, 0);
  const volWeightedPrice = cumVol > 0 ? tvp / cumVol : (high + low) / 2;
  return { denseLow, denseHigh, volWeightedPrice, denseBins };
}
function filterWashTrading(klines) {
  let washedVol = 0, washedDays = 0;
  const clean = [];
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const bodyPct = k.open > 0 ? Math.abs(k.close - k.open) / k.open : 0;
    const prev5 = klines.slice(Math.max(0, i - 5), i);
    const avg5 = prev5.length > 0 ? prev5.reduce((s, x) => s + x.volume, 0) / prev5.length : k.volume;
    // 对敲特征：价格<0.1%变动 + 量>前5日均量3倍
    if (bodyPct < 0.001 && k.volume > avg5 * 3 && avg5 > 0 && prev5.length >= 3) {
      washedVol += k.quoteVolume || 0;
      washedDays++;
      continue;
    }
    clean.push(k);
  }
  return { clean, washedVol, washedDays, totalDays: klines.length };
}

// ═══ 五大条件检测（单时间窗）═══
function checkAll(klines, btcKlines) {
  const n = klines.length;
  if (n < 15) return null;
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const avgVol = vols.reduce((s, v) => s + v, 0) / n;
  const high = Math.max(...klines.map(k => k.high));
  const low = Math.min(...klines.map(k => k.low));
  const range = (high - low) / low;

  // 动态振幅阈值：用该币90日范围做基准，30/60日不能超过基准的40%
  // 这里不设死15%，而是看该时间段相对波动
  const maxRange = 0.30; // 放宽到30%（之前15%太严）

  // 1. 地量横盘
  const half = klines.slice(-Math.floor(n / 2));
  const allButHalf = klines.slice(0, klines.length - half.length);
  const avgVolHalf = half.reduce((s, k) => s + k.volume, 0) / Math.max(half.length, 1);
  const avgVolEarlier = allButHalf.reduce((s, k) => s + k.volume, 0) / Math.max(allButHalf.length, 1);
  const volRatio = avgVolEarlier > 0 ? avgVolHalf / avgVolEarlier : 1;
  const volShrink = volRatio < 0.6 && range < maxRange;
  const c1 = { met: volShrink, label: '地量横盘', desc: '缩量窄幅震荡，庄家暗中吸筹不拉价格', detail: `后半段量比${volRatio.toFixed(2)} 振幅${(range*100).toFixed(1)}%`, weight: 15 };

  // 2. 底背离
  const r = rsi(closes, 14);
  const priceLows = [];
  for (let i = 2; i < klines.length - 2; i++) {
    if (klines[i].low < klines[i-1].low && klines[i].low < klines[i-2].low && klines[i].low < klines[i+1].low && klines[i].low < klines[i+2].low) {
      if (r[i] !== null) priceLows.push({ low: klines[i].low, rsi: r[i], idx: i });
    }
  }
  let c2 = { met: false, label: '底背离', desc: '价格低点下移但RSI低点上移，是反转前兆', detail: '无背离', weight: 25 };
  if (priceLows.length >= 2) {
    const p1 = priceLows[Math.max(0, priceLows.length - 2)];
    const p2 = priceLows[priceLows.length - 1];
    if (p2.low <= p1.low && p2.rsi > p1.rsi) {
      c2 = { met: true, label: '底背离', desc: c2.desc, detail: `价${p1.low.toFixed(6)}→${p2.low.toFixed(6)} RSI${p1.rsi.toFixed(0)}→${p2.rsi.toFixed(0)}`, weight: 25 };
    }
  }

  // 3. 长下影
  let wickCount = 0;
  for (const k of klines.slice(-n)) {
    const body = Math.abs(k.close - k.open);
    const lw = Math.min(k.open, k.close) - k.low;
    if (body > 0 && lw > body * 2.5) wickCount++; // 放宽到2.5倍（原3倍）
  }
  const c3 = { met: wickCount >= 7, label: '长下影', desc: '多次出现长下影线，庄家在低位接筹托底', detail: `近${n}日${wickCount}根`, wickCount, weight: wickCount >= 10 ? 25 : (wickCount >= 7 ? 20 : 10) };

  // 4. 震仓
  let c4 = { met: false, label: '震仓', desc: '故意砸破箱体低位逼散户割肉，然后快速拉回', detail: '未检测到', weight: 35 };
  const lowWindow = Math.min(...klines.map(k => k.low));
  for (let i = 5; i < klines.length - 3; i++) {
    if (klines[i].low < lowWindow * 0.95) {
      let recovered = false, volSurge = false;
      for (let j = i + 1; j < Math.min(i + 4, klines.length); j++) {
        if (klines[j].close > lowWindow) recovered = true;
        const preVol = klines.slice(Math.max(0, i-5), i).reduce((s,x) => s + x.volume, 0) / Math.max(i-5, 1);
        if (klines[j].volume > preVol) volSurge = true;
      }
      if (recovered && volSurge) { c4 = { met: true, label: '震仓', desc: c4.desc, detail: '跌破箱体后放量收回', weight: 35 }; break; }
    }
  }

  // 5. 独立走势
  const bs = btcKlines.slice(-n).map(k => k.close);
  const corr = pearson(closes.slice(-Math.min(n, bs.length)), bs);
  const c5 = { met: Math.abs(corr) < 0.3, label: '独立走势', desc: '与BTC价格走势脱钩，走自己的独立行情', detail: `BTC相关${corr.toFixed(2)}`, correlation: corr, weight: 25 };

  return [c1, c2, c3, c4, c5];
}

// ═══ 高波吸筹检测（波段型）═══
function checkHighVolAccum(klines, conditions) {
  const n = klines.length;
  const high = Math.max(...klines.map(k => k.high));
  const low = Math.min(...klines.map(k => k.low));
  const range = (high - low) / low;
  // 振幅>25% + 至少满足长下影+独立走势
  const wickMet = conditions[2]?.met;
  const indepMet = conditions[4]?.met;
  const met = range > 0.25 && wickMet && indepMet;
  return { met, label: '波段型', desc: `高振幅(${(range*100).toFixed(0)}%)但密集长下影+独立走势，适合做波段而非等拉升`, range };
}

// ═══ 真拉确认度计算 ═══
function calcBreakoutConfidence(klines, accLow, accHigh, whaleCost) {
  const last5 = klines.slice(-5);
  const prev25 = klines.slice(-30, -5);
  const avg25 = prev25.length > 0 ? prev25.reduce((s,k) => s + k.volume, 0) / prev25.length : 1;
  const lastPrice = klines[klines.length - 1].close;

  // ① 持续放量天数（最近5天里有几天量>1.5倍）
  const volDays = last5.filter(k => k.volume > avg25 * 1.5).length;
  const volScore = Math.min(volDays * 8, 30);

  // ② 量比幅度
  const last3avg = last5.slice(-3).reduce((s,k) => s + k.volume, 0) / 3;
  const volRatio = avg25 > 0 ? last3avg / avg25 : 1;
  const volMagScore = Math.min(Math.round((volRatio - 1) * 15), 25);

  // ③ 价格位置（越靠近箱体上沿越强）
  const boxPos = accHigh > accLow ? (lastPrice - accLow) / (accHigh - accLow) : 0.5;
  const posScore = Math.round(Math.max(0, Math.min(boxPos, 1)) * 20);

  // ④ 振幅收窄（突破前酝酿）
  const range5 = (Math.max(...last5.map(k => k.high)) - Math.min(...last5.map(k => k.low))) / (lastPrice||1);
  const range25 = (Math.max(...prev25.map(k => k.high)) - Math.min(...prev25.map(k => k.low))) / (lastPrice||1);
  const tightening = range5 < range25 * 0.7;
  const tightScore = tightening ? 15 : 0;

  // ⑤ 连续阳线
  const closes = last5.map(k => k.close);
  const streak = (closes[4] > closes[3] && closes[3] > closes[2]) ? 10 : 0;

  const confidence = volScore + volMagScore + posScore + tightScore + streak;
  const ready = confidence >= 50;

  return {
    ready,
    confidence: Math.min(confidence, 100),
    label: '突破预备',
    detail: ready ? `确认度${confidence}%` : `确认度${confidence}% 未达标`,
    volRatio,
    volDays,
    boxPos,
    breakdown: { volDays:volScore, volMag:volMagScore, pos:posScore, tight:tightScore, streak }
  };
}

// ═══ 吸筹时长检测 ═══
function findAccumStart(klines) {
  // 往前找：找到成交量开始持续下降且价格开始横盘的那个点
  const vols = klines.map(k => k.volume);
  const avg = vols.reduce((s,v) => s+v,0) / vols.length;
  for (let i = klines.length - 2; i >= 10; i--) {
    const recent10 = vols.slice(i, i + 10);
    const avg10 = recent10.reduce((s,v) => s+v,0) / 10;
    const prev10 = vols.slice(Math.max(0,i-10), i);
    const avgPrev10 = prev10.length > 0 ? prev10.reduce((s,v) => s+v,0) / prev10.length : avg10;
    // 量缩到一半以下 + 之前的量明显更大 → 吸筹开始点
    if (avg10 < avgPrev10 * 0.5 && avgPrev10 > avg * 1.2 && prev10.length >= 5) {
      return { startIdx: i, days: klines.length - i, startDate: new Date(klines[i].time).toISOString().slice(0, 10) };
    }
  }
  return { startIdx: 0, days: klines.length, startDate: new Date(klines[0].time).toISOString().slice(0, 10) };
}

// ═══ 主扫描 ═══
async function main() {
  const t0 = Date.now();
  log('🚀 吸筹扫描 v2 — 多时间窗·对敲过滤·动态阈值');

  let btcAll;
  try {
    btcAll = await getDailyKlines('BTCUSDT', 120, BINANCE_FAPI, true);
    apiUrl = BINANCE_FAPI; apiLabel = 'fapi'; log('✅ 合约K线(Tor代理)可用');
  } catch(e) {
    log('⚠ Tor失败，直连重试…');
    try {
      btcAll = await getDailyKlines('BTCUSDT', 120, BINANCE_FAPI, false);
      apiUrl = BINANCE_FAPI; apiLabel = 'fapi'; log('✅ 合约K线(直连)可用');
    } catch(e2) {
      apiUrl = BINANCE_SPOT; btcAll = await getDailyKlines('BTCUSDT', 120, BINANCE_SPOT, false); log('⚠ 回退现货');
    }
  }

  // BTC Market Regime Engine
  const btcC = btcAll.map(k => k.close);
  const btcPrice = btcC[btcC.length - 1];
  const btcMA200 = btcC.length >= 200 ? btcC.slice(-200).reduce((s,c) => s + c, 0) / 200 : btcC.reduce((s,c) => s + c, 0) / btcC.length;
  const btc30d = btcC.length > 30 ? (btcC[btcC.length - 1] - btcC[btcC.length - 31]) / btcC[btcC.length - 31] : 0;
  let marketRegime = 'neutral';
  if (btc30d > 0.15 && btcPrice > btcMA200) marketRegime = 'strong_bull';
  else if (btc30d > 0.05 && btcPrice > btcMA200) marketRegime = 'bull';
  else if (btc30d < -0.20) marketRegime = 'panic';
  else if (btc30d < -0.05 && btcPrice < btcMA200) marketRegime = 'bear';
  log(`BTC: $${btcPrice.toFixed(0)} MA200:$${btcMA200.toFixed(0)} 30d:${(btc30d*100).toFixed(1)}% [${marketRegime}]`);

  // 2. 币种列表
  let xinfo;
  try {
    xinfo = await getJSON(`${BINANCE_FAPI}/exchangeInfo`, {}, true); apiUrl = BINANCE_FAPI; apiLabel = 'fapi';
    log('✅ 合约API(Tor)');
  } catch(e) {
    try { xinfo = await getJSON(`${BINANCE_FAPI}/exchangeInfo`, {}, false); apiUrl = BINANCE_FAPI; apiLabel = 'fapi'; log('✅ 合约API(直连)'); }
    catch(e2) { xinfo = await getJSON(`${BINANCE_SPOT}/exchangeInfo`); apiUrl = BINANCE_SPOT; apiLabel = 'spot'; log('⚠ 回退现货'); }
  }
  const all = (xinfo.symbols || []).filter(s => {
    const isPerp = s.contractType === 'PERPETUAL' || !s.contractType; // spot has no contractType
    return isPerp && s.quoteAsset === 'USDT' && s.status === 'TRADING';
  }).map(s => s.symbol);
  const altcoins = all.filter(s => !MAJOR_PAIRS.includes(s) && !STABLECOINS.has(s.replace('USDT','')));
  log(`山寨币${altcoins.length}个`);

  // 2.5 拉资金费率（fapi 批量接口）
  let fundingMap = {};
  try {
    const premiums = await getJSON(`${BINANCE_FAPI}/premiumIndex`, {}, true);
    for (const p of (premiums || [])) fundingMap[p.symbol] = parseFloat(p.lastFundingRate || 0);
    log(`资金费率: ${Object.keys(fundingMap).length}条`);
  } catch(e) { log('⚠ 资金费率拉取失败'); }

  // 2.6 CoinGecko 市值+流通率（免费 30次/分，仅拉信号币）
  let cgMap = {};
  try {
    const cgList = await getJSON('https://api.coingecko.com/api/v3/coins/list');
    // 建映射: binance symbol → coingecko id
    const symToId = {};
    for (const c of (cgList || [])) {
      const sym = (c.symbol || '').toUpperCase();
      if (!symToId[sym]) symToId[sym] = c.id;
    }
    log(`CoinGecko 映射: ${Object.keys(symToId).length}个`);
    // 只拉出现在信号池里的币（省API次数）
    const targetSymbols = new Set(altcoins.map(s => s.replace('USDT','')));
    const idsToFetch = [];
    for (const [s, id] of Object.entries(symToId)) {
      if (targetSymbols.has(s)) idsToFetch.push(id);
    }
    log(`需拉市值: ${idsToFetch.length}个币`);
    // 批量拉（每批200个，3-4次API调用）
    for (let i = 0; i < idsToFetch.length; i += 200) {
      const batch = idsToFetch.slice(i, i + 200);
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${batch.join(',')}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_circulating_supply=true&include_total_supply=true`;
      try {
        const prices = await getJSON(url);
        for (const [id, data] of Object.entries(prices || {})) {
          const binSym = Object.entries(symToId).find(([,v]) => v === id)?.[0];
          if (binSym) cgMap[binSym] = {
            marketCap: data.usd_market_cap || 0,
            volume24h: data.usd_24h_vol || 0,
          };
        }
        await new Promise(r => setTimeout(r, 2100)); // 2秒间隔，控制在30次/分内
      } catch(e) {}
    }
    log(`市值数据: ${Object.keys(cgMap).length}个`);
  } catch(e) { log('⚠ CoinGecko 拉取失败'); }

  // 3. 扫描
  const results = [];
  const CONC = 2;
  for (let i = 0; i < altcoins.length; i += CONC) {
    const batch = altcoins.slice(i, i + CONC);
    const res = await Promise.allSettled(batch.map(async sym => {
      const raw = await getDailyKlines(sym, 120, apiUrl, apiLabel === 'fapi');
      if (raw.length < 31 || isStablecoin(sym, raw)) return null;

      // 对敲过滤
      const { clean, washedVol, washedDays } = filterWashTrading(raw);
      if (clean.length < 20) return null;
      const closes = clean.map(k => k.close);

      // 3个时间窗
      const windows = [
        { label: '30d', klines: clean.slice(-30), n: 30 },
        { label: '60d', klines: clean.slice(-60), n: 60 },
        { label: '90d', klines: clean.slice(-90), n: 90 },
      ];
      const winResults = windows.map(w => ({
        label: w.label,
        conditions: checkAll(w.klines, btcAll.slice(-w.n)),
      })).filter(w => w.conditions !== null);

      // 取最佳窗口（最多条件命中的）
      let best = winResults[0];
      for (const w of winResults) {
        const cnt = w.conditions.filter(c => c.met).length;
        if (cnt > best.conditions.filter(c => c.met).length) best = w;
      }
      const bestConds = best.conditions;
      const met = bestConds.filter(c => c.met).length;
      // 全量保留——即使0条件也入库，搜索能搜到

      // 加权分
      const score = bestConds.reduce((s, c) => s + (c.met ? c.weight : 0), 0);

      // 吸筹时长
      const accum = findAccumStart(clean);

      // VWAP（吸筹期）
      const accKlines = clean.slice(accum.startIdx);
      let tv = 0, tvp = 0;
      for (const k of accKlines) {
        const tp = (k.high + k.low + k.close) / 3;
        tv += k.volume;
        tvp += tp * k.volume;
      }
      const vwap = tv > 0 ? tvp / tv : 0;

      // 累计吸筹金额（剔除对敲后）
      const accVol = accKlines.reduce((s,k) => s + k.quoteVolume, 0);
      const estAccSpent = accVol * 0.5;

      // 理想开仓区间（Volume Profile：成交量最密集的价格带）
      const vp = calcVolumeProfile(accKlines);
      const accLow = vp.denseLow;
      const accHigh = vp.denseHigh;
      const whaleCost = vp.volWeightedPrice;
      const price = closes[closes.length - 1];
      const entryLow = accLow * 1.03;  // 比地板价高3%
      const entryHigh = Math.min(whaleCost * 1.02, accHigh * 0.88);  // 略高于庄家成本但不碰箱体上沿
      const priceVsCost = whaleCost > 0 ? ((price - whaleCost) / whaleCost * 100) : 0;
      let entryStatus = 'neutral', entryLabel = '';
      if (price < accLow * 0.97) {
        entryStatus = 'avalanche'; entryLabel = '⚠ 深跌中';
      } else if (price < entryLow) {
        entryStatus = 'sub_zone'; entryLabel = '⚠ 吸筹区下方';
      } else if (price <= entryHigh) {
        entryStatus = 'in_zone'; entryLabel = '✓ 成本区内';
      } else if (price <= accHigh) {
        entryStatus = 'above_cost'; entryLabel = '庄家已获利';
      } else {
        entryStatus = 'far_above'; entryLabel = '已脱离吸筹区';
      }

      // 高波吸筹 + 突破预备检测
      const hiVol = checkHighVolAccum(clean, bestConds);
      const brk = calcBreakoutConfidence(clean, accLow, accHigh, whaleCost);
      const accType = hiVol.met ? 'band' : 'quiet';

      return {
        symbol: sym.replace('USDT',''),
        price: closes[closes.length - 1],
        change24h: closes.length>1 ? ((closes[closes.length-1]-closes[closes.length-2])/closes[closes.length-2]*100) : 0,
        quoteVolume: clean[clean.length-1]?.quoteVolume || 0,
        conditions: bestConds.map(c => ({ label:c.label, met:c.met, detail:c.detail, desc:c.desc, weight:c.weight })),
        metCount: met,
        score,
        accType,
        bestWindow: best.label,
        accumDays: accum.days,
        accumStart: accum.startDate,
        vwap,
        estAccumulation: estAccSpent,
        washedVol,
        washedDays,
        entryZone: { low: entryLow, high: entryHigh, whaleCost, accLow, accHigh },
        priceVsCost,
        entryStatus,
        entryLabel,
        breakout: { ready: brk.ready, label: brk.label, detail: brk.detail, confidence: brk.confidence, volRatio: brk.volRatio },
        hiVolAccum: { isHiVol: hiVol.met, label: hiVol.label, desc: hiVol.desc, range: hiVol.range },
        fundingRate: fundingMap[sym] || 0,
        oiSignal: fundingMap[sym] && fundingMap[sym] > 0.01 ? 'extreme' : fundingMap[sym] < -0.01 ? 'shortCrowded' : 'normal',
        marketCap: (cgMap[sym.replace('USDT','')] || {}).marketCap || 0,
        marketRegime,
        btcMetrics: { price: btcPrice, ma200: btcMA200, ret30d: btc30d },
      };
    }));
    for (const r of res) { if (r.status === 'fulfilled' && r.value) results.push(r.value); }
    if ((i / CONC) % 30 === 0) log(`进度 ${Math.min(i, altcoins.length)}/${altcoins.length} → 信号${results.length}`);
    await new Promise(r => setTimeout(r, 30));
  }

  // 排序：突破预备按确认度排前面，其余按分
  results.sort((a, b) => {
    const ba = a.breakout?.ready ? (a.breakout.confidence || 50) : 0;
    const bb = b.breakout?.ready ? (b.breakout.confidence || 50) : 0;
    if (ba && bb) return bb - ba;  // 俩都突破 → 按确认度
    if (ba) return -1;  // 突破在前
    if (bb) return 1;
    return b.score - a.score;  // 都非突破 → 按分
  });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = { scannedAt: new Date().toISOString(), totalScanned: altcoins.length, signalsFound: results.length, signals: results };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));

  const dur = ((Date.now() - t0) / 1000).toFixed(0);
  const hi = results.filter(r => r.score >= 60);
  const mid = results.filter(r => r.score >= 40 && r.score < 60);
  const lo = results.filter(r => r.metCount >= 2 && r.score < 40);
  const none = results.filter(r => r.metCount < 2);
  log(`✅ 完成 ${dur}s | 扫${altcoins.length}币 → 全量入库 | 强(${hi.length}) 中(${mid.length}) 弱(${lo.length}) 无(${none.length})`);

  // 查特定币
  const checkSyms = ['HUMA'];
  for (const s of checkSyms) {
    const found = results.find(r => r.symbol === s);
    if (found) {
      log(`🔍 ${s}: ${found.score}分 ${found.metCount}/5 窗${found.bestWindow} 吸筹${found.accumDays}天 累计~$${(found.estAccumulation/1e6).toFixed(1)}M`);
    } else {
      log(`🔍 ${s}: 未发现信号`);
    }
  }

  return out;
}
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }
main().catch(e => { log('❌ ' + e.message); process.exit(1); });
