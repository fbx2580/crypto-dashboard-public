// ─── 币安行情信号模块 ───
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const MAJOR_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','TRXUSDT','LTCUSDT','BCHUSDT','XLMUSDT','HBARUSDT','SHIBUSDT','NEARUSDT','ATOMUSDT','UNIUSDT','FILUSDT','APTUSDT','SUIUSDT','INJUSDT','OPUSDT','ARBUSDT','TIAUSDT','ETCUSDT'];
const DATA_DIR = path.join(__dirname, '..', 'public', 'data', 'binance');

function getLatestSnapshot() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'latest_snapshot.json'), 'utf8')); } catch(e) { return null; }
}

async function getAllPerpTickers() {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 10000 });
  return (res.data || []).filter(t => t.symbol.endsWith('USDT')).map(t => ({
    symbol: t.symbol, price: parseFloat(t.lastPrice), change24h: parseFloat(t.priceChangePercent),
    quoteVolume: parseFloat(t.quoteVolume), volume: parseFloat(t.volume),
  }));
}

async function getPerpetualSymbols() {
  const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo', { timeout: 10000 });
  return (res.data?.symbols || []).filter(s => (s.contractType === 'PERPETUAL' || s.contractType === 'TRADIFI_PERPETUAL') && s.quoteAsset === 'USDT').map(s => s.symbol);
}

// BTC 实时价
router.get('/price/btc', (req, res) => {
  const snapshot = getLatestSnapshot();
  let btc = null;
  if (Array.isArray(snapshot)) btc = snapshot.find(t => t.symbol === 'BTCUSDT');
  else if (snapshot?.majors) btc = snapshot.majors.find(m => m.symbol === 'BTCUSDT');
  res.json({ price: btc?.price || null, change24h: btc?.change24h || null });
});

// 主流行情
router.get('/majors', async (req, res) => {
  const snapshot = getLatestSnapshot();
  if (snapshot?.majors && Date.now() - snapshot.timestamp < 60000) return res.json(snapshot.majors);
  try {
    const [tickers, perps] = await Promise.all([getAllPerpTickers(), getPerpetualSymbols()]);
    const usdtTickers = tickers.filter(t => perps.includes(t.symbol));
    res.json(usdtTickers.filter(t => MAJOR_PAIRS.includes(t.symbol)));
  } catch(e) {
    res.json(snapshot?.majors || []);
  }
});

// 异动检测
router.get('/anomalies', async (req, res) => {
  const snapshot = getLatestSnapshot();
  if (snapshot?.anomalies && Date.now() - snapshot.timestamp < 60000) return res.json(snapshot.anomalies);
  try {
    const [tickers, perps] = await Promise.all([getAllPerpTickers(), getPerpetualSymbols()]);
    const usdtTickers = tickers.filter(t => perps.includes(t.symbol));
    const vols = usdtTickers.map(t => t.quoteVolume);
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
    return res.json(usdtTickers.filter(t => t.quoteVolume > avgVol * 5 && !MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 15));
  } catch(e) {
    return res.json(snapshot?.anomalies || []);
  }
});

// 涨跌排行
router.get('/signals', async (req, res) => {
  const snapshot = getLatestSnapshot();
  const fresh = snapshot && (Date.now() - snapshot.timestamp < 120000);
  // 缓存命中且数据完整
  if (fresh && snapshot.allTickers && snapshot.allTickers.length > 100) {
    return res.json({
      timestamp: Date.now(), fetchedAt: snapshot.timestamp,
      majors: snapshot.allTickers.filter(t => MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.change24h - a.change24h),
      altcoins: snapshot.allTickers.filter(t => !MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.change24h - a.change24h),
    });
  }
  // 尝试实时拉取
  try {
    const [tickers, perps] = await Promise.all([getAllPerpTickers(), getPerpetualSymbols()]);
    const usdtTickers = tickers.filter(t => perps.includes(t.symbol));
    if (usdtTickers.length > 100) {
      return res.json({
        timestamp: Date.now(), fetchedAt: Date.now(),
        majors: usdtTickers.filter(t => MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.change24h - a.change24h),
        altcoins: usdtTickers.filter(t => !MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.change24h - a.change24h),
      });
    }
  } catch(e) {}
  // 兜底：用过期缓存（即使超过120秒也比空的好）
  if (snapshot && snapshot.allTickers && snapshot.allTickers.length > 100) {
    return res.json({
      timestamp: Date.now(), fetchedAt: snapshot.timestamp,
      majors: snapshot.allTickers.filter(t => MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.change24h - a.change24h),
      altcoins: snapshot.allTickers.filter(t => !MAJOR_PAIRS.includes(t.symbol)).sort((a, b) => b.change24h - a.change24h),
    });
  }
  return res.json({ timestamp: Date.now(), fetchedAt: null, majors: [], altcoins: [] });
});

// K线
router.get('/klines/:symbol/:interval', (req, res) => {
  const { symbol, interval } = req.params;
  const file = path.join(DATA_DIR, symbol, interval, 'latest.json');
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch(e) {}
  res.json([]);
});

// 快照
router.get('/snapshot', (req, res) => {
  const snapshot = getLatestSnapshot();
  res.json(snapshot || {});
});

module.exports = router;
