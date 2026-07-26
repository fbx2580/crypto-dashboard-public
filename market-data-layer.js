#!/usr/bin/env node
/**
 * Market Data Layer V1 — 宏观市场环境数据采集
 * 
 * Layer 1: BTC/ETH/山寨/传统市场
 * 每日快照，不覆盖历史，支持回放
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'market_data');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [data] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }

// ═══ 工具 ═══
async function getJSON(url, params = {}, timeout = 15000, headers = {}) {
  return (await axios.get(url, { params, timeout, headers })).data;
}

function ema(data, period) {
  const k = 2 / (period + 1), out = [];
  let sum = 0;
  for (let i = 0; i < period && i < data.length; i++) sum += data[i];
  out.push(sum / Math.min(period, data.length));
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

function atr(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atrVals = [avg(trs.slice(0, period))];
  for (let i = 1; i < trs.length; i++) atrVals.push((atrVals[i - 1] * (period - 1) + trs[i]) / period);
  return atrVals;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
  let ag = gains / period, al = losses / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ═══ 1. BTC 数据 ═══
async function fetchBTCData() {
  const [raw, ticker] = await Promise.all([
    getJSON(`${BINANCE_FAPI}/klines`, { symbol: 'BTCUSDT', interval: '1d', limit: 200 }),
    getJSON(`${BINANCE_FAPI}/ticker/24hr`, { symbol: 'BTCUSDT' })
  ]);
  const klines = raw.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7],
  }));
  const n = klines.length;
  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const price = closes[n - 1];

  const ma20 = ema(closes, 20), ma60 = ema(closes, 60), ma120 = ema(closes, 120), ma200 = ema(closes, Math.min(200, n));
  const atrVals = atr(highs, lows, closes, 14);
  const ath = Math.max(...highs);
  const absLow = Math.min(...lows);
  const returns = [];
  for (let i = 1; i < Math.min(30, n); i++) returns.push((closes[n - i] - closes[n - i - 1]) / closes[n - i - 1]);
  const volatility = Math.sqrt(returns.reduce((s, v) => s + v * v, 0) / returns.length) * Math.sqrt(365);

  return {
    symbol: 'BTC',
    price,
    price_24h_ago: parseFloat(ticker.prevClosePrice || closes[n - 2]),
    change24h: parseFloat(ticker.priceChangePercent || ((price - closes[n - 2]) / closes[n - 2] * 100)),
    volume24h: parseFloat(ticker.quoteVolume || vols[n - 1]),
    quoteVolume24h: klines[n - 1].quoteVolume,
    high24h: parseFloat(ticker.highPrice || 0),
    low24h: parseFloat(ticker.lowPrice || 0),
    updatedAt: new Date().toISOString(),
    source: 'Binance FAPI',
    ma20: ma20[ma20.length - 1], ma60: ma60[ma60.length - 1],
    ma120: ma120[ma120.length - 1], ma200: ma200[ma200.length - 1],
    atr14: atrVals[atrVals.length - 1],
    atrPct: atrVals[atrVals.length - 1] / price,
    volatility30d: volatility,
    rsi14: rsi(closes.slice(-15)),
    athDistance: ((price - ath) / ath * 100),
    lowDistance: ((price - absLow) / absLow * 100),
    ret7d: (price / closes[Math.max(0, n - 8)] - 1) * 100,
    ret30d: (price / closes[Math.max(0, n - 31)] - 1) * 100,
    ret90d: (price / closes[Math.max(0, n - 91)] - 1) * 100,
  };
}

// ═══ 2. ETH 数据 ═══
async function fetchETHData() {
  const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: 'ETHUSDT', interval: '1d', limit: 200 });
  const klines = raw.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7],
  }));
  const n = klines.length;
  const closes = klines.map(k => k.close);
  const price = closes[n - 1];
  const ath = Math.max(...klines.map(k => k.high));

  return {
    symbol: 'ETH',
    price,
    change24h: ((price - closes[n - 2]) / closes[n - 2] * 100),
    volume24h: klines[n - 1].volume,
    quoteVolume24h: klines[n - 1].quoteVolume,
    athDistance: ((price - ath) / ath * 100),
    ret7d: (price / closes[Math.max(0, n - 8)] - 1) * 100,
    ret30d: (price / closes[Math.max(0, n - 31)] - 1) * 100,
  };
}

// ═══ 3. ETH/BTC 汇率 ═══
async function fetchETHBTC() {
  const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: 'ETHBTC', interval: '1d', limit: 200 });
  const closes = raw.map(k => +k[4]);
  const n = closes.length;
  const price = closes[n - 1];
  return {
    price,
    change24h: ((price - closes[n - 2]) / closes[n - 2] * 100),
    ret7d: (price / closes[Math.max(0, n - 8)] - 1) * 100,
    ret30d: (price / closes[Math.max(0, n - 31)] - 1) * 100,
    ret90d: (price / closes[Math.max(0, n - 91)] - 1) * 100,
    low52w: Math.min(...closes.slice(-365)),
    high52w: Math.max(...closes.slice(-365)),
  };
}

// ═══ 4. CoinGecko: TOTAL3, BTC.D ═══
async function fetchCoinGecko() {
  try {
    const [global, trend] = await Promise.all([
      getJSON(`${COINGECKO}/global`),
      getJSON(`${COINGECKO}/search/trending`),
    ]);
    const d = global.data || {};
    return {
      totalMarketCap: d.total_market_cap?.usd || 0,
      totalVolume24h: d.total_volume?.usd || 0,
      btcDominance: d.market_cap_percentage?.btc || 0,
      ethDominance: d.market_cap_percentage?.eth || 0,
      activeCoins: d.active_cryptocurrencies || 0,
      trendingCoins: (trend.coins || []).slice(0, 5).map(c => c.item?.symbol || ''),
    };
  } catch(e) { return null; }
}

// ═══ 5. 传统市场 ═══
async function fetchTraditional() {
  const result = {};
  const symbols = [
    { id: 'nasdaq', symbol: '%5EIXIC' },
    { id: 'sp500', symbol: '%5EGSPC' },
    { id: 'gold', symbol: 'GC%3DF' },
    { id: 'oil', symbol: 'CL%3DF' },
  ];
  for (const s of symbols) {
    try {
      const raw = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${s.symbol}`,
        { interval: '1d', range: '5d' }, 8000,
        { 'User-Agent': 'Mozilla/5.0' }
      );
      const meta = raw?.chart?.result?.[0]?.meta;
      if (meta) {
        result[s.id] = {
          price: meta.regularMarketPrice,
          changePct: meta.regularMarketPrice && meta.previousClose
            ? ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose * 100) : 0,
        };
      }
    } catch(e) {}
  }
  return result;
}

// ═══ 6. 资金费率汇总 ═══
async function fetchFundingSummary() {
  try {
    const raw = await getJSON(`${BINANCE_FAPI}/premiumIndex`);
    const rates = (raw || []).map(p => parseFloat(p.lastFundingRate || 0));
    const positive = rates.filter(r => r > 0);
    const negative = rates.filter(r => r < 0);
    const extreme = rates.filter(r => Math.abs(r) > 0.005);
    return {
      totalSymbols: rates.length,
      avgFunding: avg(rates),
      positiveRatio: (positive.length / rates.length * 100),
      negativeRatio: (negative.length / rates.length * 100),
      extremeRatio: (extreme.length / rates.length * 100),
    };
  } catch(e) { return null; }
}

// ═══ 主流程 ═══
async function main() {
  L('📡 Market Data Layer V1 — 宏观数据采集');
  const timestamp = new Date().toISOString();
  const today = timestamp.slice(0, 10);

  // 并行采集
  const [btc, eth, ethbtc, cg, traditional, funding] = await Promise.all([
    fetchBTCData(),
    fetchETHData(),
    fetchETHBTC(),
    fetchCoinGecko(),
    fetchTraditional(),
    fetchFundingSummary(),
  ]);

  // 组装快照
  const snapshot = {
    timestamp,
    date: today,
    btc,
    eth,
    ethbtc,
    coingecko: cg,
    traditional,
    funding,
    // 元数据
    meta: {
      version: 'market-data-v1',
      source: 'Binance FAPI + CoinGecko + Yahoo Finance',
    },
  };

  // 保存：按日期命名，不覆盖
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 每日快照
  const dailyFile = path.join(DATA_DIR, `${today}.json`);
  fs.writeFileSync(dailyFile, JSON.stringify(snapshot, null, 2));

  // 最新摘要（覆盖更新）
  const latestFile = path.join(DATA_DIR, 'latest.json');
  fs.writeFileSync(latestFile, JSON.stringify(snapshot, null, 2));

  // ===== 打印报表 =====
  console.log('\n' + '═'.repeat(55));
  console.log(`📊 市场数据快照 — ${today}`);
  console.log('═'.repeat(55));

  console.log('\n🪙 BTC:');
  console.log(`  价格: $${btc.price.toFixed(0)} | 24h: ${btc.change24h.toFixed(2)}%`);
  console.log(`  MA60: $${btc.ma60.toFixed(0)} | MA200: $${btc.ma200.toFixed(0)}`);
  console.log(`  ATR: ${(btc.atrPct*100).toFixed(2)}% | 波动率: ${(btc.volatility30d*100).toFixed(0)}%`);
  console.log(`  距ATH: ${btc.athDistance.toFixed(1)}% | 距低点: ${btc.lowDistance.toFixed(0)}%`);
  console.log(`  7d: ${btc.ret7d.toFixed(1)}% | 30d: ${btc.ret30d.toFixed(1)}% | 90d: ${btc.ret90d.toFixed(1)}%`);

  console.log('\n💎 ETH:');
  console.log(`  价格: $${eth.price.toFixed(0)} | 24h: ${eth.change24h.toFixed(2)}%`);
  console.log(`  ETH/BTC: ${ethbtc.price.toFixed(6)} | 30d: ${ethbtc.ret30d.toFixed(1)}%`);

  if (cg) {
    console.log('\n🌐 山寨市场:');
    console.log(`  BTC.D: ${cg.btcDominance.toFixed(1)}% | ETH.D: ${cg.ethDominance.toFixed(1)}%`);
    console.log(`  总市值: $${(cg.totalMarketCap/1e12).toFixed(2)}T | 24h量: $${(cg.totalVolume24h/1e9).toFixed(1)}B`);
  }

  if (funding) {
    console.log('\n💰 资金费率:');
    console.log(`  均值: ${(funding.avgFunding*100).toFixed(4)}% | 正费率: ${funding.positiveRatio.toFixed(0)}% | 极端: ${funding.extremeRatio.toFixed(0)}%`);
  }

  if (traditional && Object.keys(traditional).length > 0) {
    console.log('\n🏛 传统市场:');
    for (const [k, v] of Object.entries(traditional)) {
      if (v.price) console.log(`  ${k}: $${v.price.toFixed(0)} (${v.changePct.toFixed(2)}%)`);
    }
  }

  console.log('\n' + '═'.repeat(55));
  L(`✅ 快照已保存 → ${DATA_DIR}/${today}.json`);
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
