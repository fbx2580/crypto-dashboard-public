const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require("fs");
const axios = require('axios');

const app = express();
const PORT = 3001;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Default config
const DEFAULT_CONFIG = {
  tokens: [
    { name: 'SOL', address: 'So11111111111111111111111111111111111111112', chain: 'solana', active: true },
  ],
  checkInterval: 5, // minutes
  volumeSurgeThreshold: 5, // times average
};

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Load or create config
let config = DEFAULT_CONFIG;
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) { /* use default */ }
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

app.use(cors());
// 反缓存
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== DexScreener API =====
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

// Get current token data from DexScreener
async function fetchTokenData(tokenAddress, chain) {
  try {
    const url = `${DEXSCREENER_BASE}/tokens/${tokenAddress}`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (err) {
    console.error(`[fetchTokenData] Error for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

// Save a data snapshot
function saveSnapshot(chain, tokenAddress, data) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dir = path.join(DATA_DIR, chain, tokenAddress, dateStr);
  if (!fs.existsSync(dir, { recursive: true })) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const snapshot = {
    timestamp: Date.now(),
    price: parseFloat(data.priceUsd) || 0,
    volume24h: parseFloat(data.volume?.h24) || 0,
    volume1h: parseFloat(data.volume?.h1) || 0,
    volume5m: parseFloat(data.volume?.m5) || 0,
    liquidity: parseFloat(data.liquidity?.usd) || 0,
    fdv: parseFloat(data.fdv) || 0,
    txns24h: data.txns?.h24?.buys + data.txns?.h24?.sells || 0,
    priceChange24h: parseFloat(data.priceChange?.h24) || 0,
    priceChange1h: parseFloat(data.priceChange?.h1) || 0,
  };
  
  const filePath = path.join(dir, `${snapshot.timestamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  
  return snapshot;
}

// ===== Signal Detection =====
function detectSignals(snapshots, tokenData) {
  const signals = [];
  const recent = snapshots.slice(-20); // Last 20 snapshots (~100 min if 5min interval)
  
  if (recent.length < 3) return signals;
  
  const latest = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  const avgVolume5m = recent.slice(0, -1).reduce((s, p) => s + p.volume5m, 0) / (recent.length - 1);
  
  // Volume surge detection
  if (avgVolume5m > 0 && latest.volume5m > avgVolume5m * config.volumeSurgeThreshold) {
    signals.push({
      type: 'volume_surge',
      level: 'warning',
      message: `交易量暴增 ${(latest.volume5m / avgVolume5m).toFixed(1)}x`,
      timestamp: Date.now(),
      importance: latest.volume5m > avgVolume5m * 10 ? 'high' : 'medium',
      currentPrice: latest.price,
    });
  }
  
  // Price surge with volume - possible "起涨点"
  if (latest.price > prev.price * 1.02 && latest.volume5m > avgVolume5m * 3) {
    signals.push({
      type: 'breakout',
      level: 'buy',
      message: `放量突破! 价格 +${((latest.price/prev.price - 1)*100).toFixed(2)}%, 量 ${(latest.volume5m/avgVolume5m).toFixed(1)}x`,
      timestamp: Date.now(),
      importance: 'high',
      currentPrice: latest.price,
    });
  }
  
  // Price drop with volume - possible dump
  if (latest.price < prev.price * 0.97 && latest.volume5m > avgVolume5m * 3) {
    signals.push({
      type: 'dump',
      level: 'sell',
      message: `放量下跌! 价格 ${((latest.price/prev.price - 1)*100).toFixed(2)}%`,
      timestamp: Date.now(),
      importance: 'high',
      currentPrice: latest.price,
    });
  }
  
  return signals;
}

// ===== API Routes =====

// Get config
app.get('/api/config', (req, res) => res.json(config));

// Update config (add/remove tokens)
app.post('/api/config', (req, res) => {
  if (req.body.tokens) config.tokens = req.body.tokens;
  if (req.body.volumeSurgeThreshold) config.volumeSurgeThreshold = req.body.volumeSurgeThreshold;
  if (req.body.checkInterval) config.checkInterval = req.body.checkInterval;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ success: true, config });
});

// Fetch latest data for all active tokens
app.get('/api/fetch', async (req, res) => {
  const results = [];
  for (const token of config.tokens.filter(t => t.active)) {
    try {
      const raw = await fetchTokenData(token.address, token.chain);
      if (raw && raw.pairs && raw.pairs.length > 0) {
        // Get the most liquid pair
        const bestPair = raw.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        const snapshot = saveSnapshot(token.chain, token.address, bestPair);
        
        // Read existing snapshots for signals
        const snapshots = getSnapshots(token.chain, token.address);
        const signals = detectSignals(snapshots.slice(0, -1), bestPair);
        
        results.push({
          token: token.name,
          address: token.address,
          pair: bestPair.pairAddress || '',
          chain: token.chain,
          dex: bestPair.dexId || '',
          snapshot,
          signals,
          url: bestPair.url || '',
        });
      }
    } catch (err) {
      console.error(`[fetch] Error for ${token.name}: ${err.message}`);
    }
  }
  res.json({ timestamp: Date.now(), results });
});

// Get historical snapshots for a token
app.get('/api/data/:chain/:address', (req, res) => {
  const { chain, address } = req.params;
  const snapshots = getSnapshots(chain, address);
  res.json({ chain, address, snapshots });
});

function getSnapshots(chain, address) {
  const dir = path.join(DATA_DIR, chain, address);
  if (!fs.existsSync(dir)) return [];
  
  const snapshots = [];
  try {
    const dates = fs.readdirSync(dir).sort();
    for (const date of dates) {
      const dateDir = path.join(dir, date);
      if (fs.statSync(dateDir).isDirectory()) {
        const files = fs.readdirSync(dateDir).sort();
        for (const file of files) {
          if (file.endsWith('.json')) {
            const data = JSON.parse(fs.readFileSync(path.join(dateDir, file), 'utf8'));
            snapshots.push(data);
          }
        }
      }
    }
  } catch (e) { /* ignore */ }
  
  return snapshots.sort((a, b) => a.timestamp - b.timestamp);
}

// Get signals for a token
app.get('/api/signals/:chain/:address', (req, res) => {
  const { chain, address } = req.params;
  const snapshots = getSnapshots(chain, address);
  const signals = detectSignals(snapshots, {});
  
  // Read cached signals from file
  const signalFile = path.join(DATA_DIR, chain, address, 'signals.json');
  let cachedSignals = [];
  if (fs.existsSync(signalFile)) {
    try { cachedSignals = JSON.parse(fs.readFileSync(signalFile, 'utf8')); } catch (e) {}
  }
  
  res.json({ chain, address, signals: [...signals, ...cachedSignals.slice(-50)] });
});

// Get latest snapshot summary
app.get('/api/latest', (req, res) => {
  const result = [];
  for (const token of config.tokens.filter(t => t.active)) {
    const snapshots = getSnapshots(token.chain, token.address);
    if (snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      const signals = detectSignals(snapshots, {});
      result.push({
        token: token.name,
        address: token.address,
        chain: token.chain,
        latest,
        signalsCount: signals.length,
        signalsSummary: signals.filter(s => s.importance === 'high').slice(-3),
      });
    }
  }
  res.json({ timestamp: Date.now(), tokens: result });
});

// ===== Binance Integration =====
const { getBinanceData, getLatestSnapshot, MAJOR_PAIRS, fetchAll, getAllPerpTickers, getPerpetualSymbols } = require('./binance-fetcher.js');

// Searchable coin symbols
const SYMBOLS_FILE = path.join(DATA_DIR, 'binance', 'symbols.json');

app.get('/api/symbols', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(SYMBOLS_FILE, 'utf8'));
    const q = (req.query.q || '').toUpperCase();
    const filtered = q ? data.filter(s => s.includes(q)).slice(0, 20) : data.slice(0, 20);
    res.json(filtered);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/symbols/all', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(SYMBOLS_FILE, 'utf8')));
  } catch (e) {
    res.json([]);
  }
});

// Get Binance kline data (USDT走期货, BUSDT走现货)
app.get('/api/binance/klines/:symbol/:interval', (req, res) => {
  // ★ 全部读本地缓存，不调币安 API
  const { symbol, interval } = req.params;
  const sym = symbol.toUpperCase();
  const data = getBinanceData(sym, interval);
  if (data.length > 0) {
    res.json({ symbol: sym, interval, candles: data, source: 'cache' });
  } else {
    res.status(404).json({ symbol: sym, interval, error: 'No cached data', candles: [] });
  }
});

// Get older klines for chart "load more"

// Get latest Binance market snapshot
app.get('/api/binance/snapshot', (req, res) => {
  const snapshot = getLatestSnapshot();
  res.json(snapshot || { timestamp: Date.now(), majors: [], anomalies: [], totalPairs: 0 });
});

// Get Binance major coins data (缓存放行，旧了就实时拉)
app.get('/api/binance/majors', async (req, res) => {
  const snapshot = getLatestSnapshot();
  const fresh = snapshot && (Date.now() - snapshot.timestamp < 30000);
  if (fresh) {
    res.set('X-Data-Source', 'cache');
    res.set('X-Data-Age', String(Date.now() - snapshot.timestamp));
    return res.json(snapshot.majors);
  }

  try {
    const [tickers, perps] = await Promise.all([getAllPerpTickers(), getPerpetualSymbols()]);
    const usdtTickers = tickers.filter(t => t.symbol.endsWith('USDT') && perps.includes(t.symbol));
    res.set('X-Data-Source', 'live');
    return res.json(usdtTickers.filter(t => MAJOR_PAIRS.includes(t.symbol)));
  } catch (e) {
    res.set('X-Data-Source', 'fallback');
    return res.json(snapshot?.majors || []);
  }
});

// Get Binance anomaly (volume surge) altcoins
app.get('/api/binance/anomalies', async (req, res) => {
  const snapshot = getLatestSnapshot();
  const fresh = snapshot && (Date.now() - snapshot.timestamp < 60000);
  if (fresh && snapshot.anomalies) return res.json(snapshot.anomalies);

  try {
    const [tickers, perps] = await Promise.all([getAllPerpTickers(), getPerpetualSymbols()]);
    const usdtTickers = tickers.filter(t => t.symbol.endsWith('USDT') && perps.includes(t.symbol));
    const vols = usdtTickers.map(t => t.quoteVolume);
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
    const anomalies = usdtTickers
      .filter(t => t.quoteVolume > avgVol * 5 && !MAJOR_PAIRS.includes(t.symbol))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 15);
    return res.json(anomalies);
  } catch (e) {
    return res.json(snapshot?.anomalies || []);
  }
});

// Get all perp signals, sorted by gain/loss, split into majors & altcoins
app.get('/api/binance/signals', async (req, res) => {
  const snapshot = getLatestSnapshot();
  const fresh = snapshot && (Date.now() - snapshot.timestamp < 60000);

  if (fresh && snapshot.allTickers) {
    const all = snapshot.allTickers;
    const majors = all.filter(t => MAJOR_PAIRS.includes(t.symbol));
    const altcoins = all.filter(t => !MAJOR_PAIRS.includes(t.symbol));
    return res.json({
      timestamp: Date.now(),
      fetchedAt: snapshot.timestamp,
      majors: majors.sort((a, b) => b.change24h - a.change24h),
      altcoins: altcoins.sort((a, b) => b.change24h - a.change24h),
    });
  }

  // Fallback: fetch live
  try {
    const [tickers, perps] = await Promise.all([getAllPerpTickers(), getPerpetualSymbols()]);
    const usdtTickers = tickers.filter(t => t.symbol.endsWith('USDT') && perps.includes(t.symbol));
    const majors = usdtTickers.filter(t => MAJOR_PAIRS.includes(t.symbol));
    const altcoins = usdtTickers.filter(t => !MAJOR_PAIRS.includes(t.symbol));
    return res.json({
      timestamp: Date.now(),
      fetchedAt: Date.now(),
      majors: majors.sort((a, b) => b.change24h - a.change24h),
      altcoins: altcoins.sort((a, b) => b.change24h - a.change24h),
    });
  } catch (err) {
    // Fallback to spot on error
    if (snapshot && snapshot.allTickers) {
      const all = snapshot.allTickers;
      const majors = all.filter(t => MAJOR_PAIRS.includes(t.symbol));
      const altcoins = all.filter(t => !MAJOR_PAIRS.includes(t.symbol));
      return res.json({
        timestamp: Date.now(),
        fetchedAt: snapshot.timestamp,
        majors: majors.sort((a, b) => b.change24h - a.change24h),
        altcoins: altcoins.sort((a, b) => b.change24h - a.change24h),
      });
    }
    // Ultimate fallback: use whatever cache has
    if (snapshot && snapshot.allTickers) {
      const all = snapshot.allTickers;
      const majors = all.filter(t => MAJOR_PAIRS.includes(t.symbol));
      const altcoins = all.filter(t => !MAJOR_PAIRS.includes(t.symbol));
      return res.json({
        timestamp: Date.now(),
        fetchedAt: snapshot.timestamp,
        majors: majors.sort((a, b) => b.change24h - a.change24h),
        altcoins: altcoins.sort((a, b) => b.change24h - a.change24h),
      });
    }
    res.json({ timestamp: Date.now(), fetchedAt: null, majors: [], altcoins: [] });
  }
});

// 新闻监控警报 — 最新快讯
app.get('/api/news/alerts', (req, res) => {
  const alertsFile = path.join(DATA_DIR, 'alerts', 'news.json');
  try {
    if (fs.existsSync(alertsFile)) {
      res.json(JSON.parse(fs.readFileSync(alertsFile, 'utf8')));
    } else {
      res.json({ updated: Date.now(), alerts: [] });
    }
  } catch(e) {
    res.json({ updated: Date.now(), alerts: [] });
  }
});

// 秒级 BTC 实时价格（无缓存，直接调币安）
app.get('/api/binance/price/btc', (req, res) => {
  // ★ 读本地缓存，不调币安 API
  const snapshot = getLatestSnapshot();
  let btc = null;
  if (Array.isArray(snapshot)) {
    btc = snapshot.find(t => t.symbol === 'BTCUSDT');
  } else if (snapshot && snapshot.majors) {
    btc = snapshot.majors.find(m => m.symbol === 'BTCUSDT');
  }
  if (btc) return res.json({ price: btc.price, change24h: btc.change24h });
  res.json({ price: null, change24h: null });
});

// Trigger a manual Binance fetch
app.get('/api/binance/fetch', async (req, res) => {
  try {
    const result = await fetchAll('1h', 50);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== News Archive API (增量数据) =====
app.get("/api/news", async (req, res) => {
  const newsFile = path.join(DATA_DIR, "news", "latest.json");
  const jin10File = path.join(DATA_DIR, "news", "jin10.json");
  const fallbackFile = path.join(DATA_DIR, "news", "fallback.json");
  try {
    // RSS 新闻
    let rssItems = [];
    let needsRefresh = true;
    if (fs.existsSync(newsFile)) {
      const age = Date.now() - fs.statSync(newsFile).mtimeMs;
      if (age < 30000) needsRefresh = false;
    }
    if (needsRefresh) {
      try {
        const { fetchNews, loadFallback } = require("./rss-fetcher.js");
        await fetchNews();
      } catch(e) {}
    }
    if (fs.existsSync(newsFile)) {
      const data = JSON.parse(fs.readFileSync(newsFile, "utf8"));
      if (data.items) rssItems = data.items;
    }

    // 金十快讯
    let jin10Items = [];
    if (fs.existsSync(jin10File)) {
      const age = Date.now() - fs.statSync(jin10File).mtimeMs;
      if (age < 60000) {  // 1分钟内不重复爬
        const data = JSON.parse(fs.readFileSync(jin10File, "utf8"));
        if (data.items) jin10Items = data.items;
      } else {
        // 缓存过期，异步爬取
        try {
          const { scrapeJin10 } = require("./jin10-scraper.js");
          scrapeJin10().then(r => {
            // 爬完会自动写文件，下次请求就有数据
          }).catch(() => {});
        } catch(e) {}
        // 这次先用旧数据
        const data = JSON.parse(fs.readFileSync(jin10File, "utf8"));
        if (data.items) jin10Items = data.items;
      }
    }

    // 分开：金十和 RSS 各自独立返回
    res.json({
      jin10: jin10Items,
      rss: rssItems,
      updated: Date.now()
    });

  } catch(e) {
    console.error('[news] endpoint error:', e.message);
    res.json({ items: [], updated: Date.now() });
  }
});

// ===== Market Overview (大盘) =====
// Cache for market overview data
let marketCache = { data: null, time: 0 };
let defiYieldCache = { data: null, time: 0 };

app.get('/api/market/overview', async (req, res) => {
  if (marketCache.data && Date.now() - marketCache.time < 30000) {
    return res.json(marketCache.data);
  }
  
  try {
    // Crypto total market data from Binance
    const binanceSnapshot = getLatestSnapshot();
    const majors = binanceSnapshot?.majors || [];
    
    // Calculate total crypto market change (BTC dominance proxy)
    let totalCryptoChg = 0;
    let cryptoVol = 0;
    if (majors.length > 0) {
      const weighted = majors.reduce((s, t) => {
        const w = t.quoteVolume || 0;
        return { chg: s.chg + (t.change24h || 0) * w, vol: s.vol + w };
      }, { chg: 0, vol: 0 });
      totalCryptoChg = weighted.vol > 0 ? weighted.chg / weighted.vol : 0;
      cryptoVol = weighted.vol;
    }
    
    // A股指数 from 腾讯财经
    // A股 codes: Tencent returns pure numbers (000001, 399001...)
    const A_SHARE_MAP = { '000001': '上证指数', '399001': '深证成指', '399006': '创业板指', '000300': '沪深300' };
    let aShares = {};
    try {
      const aRes = await axios.get('https://web.sqt.gtimg.cn/q=sh000001,sz399001,sz399006,sh000300', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 8000,
      });
      
// Parse Tencent Finance format
      const regex = /v_\w+="([^"]+)"/g;
      let match;
      while ((match = regex.exec(aRes.data)) !== null) {
        const fields = match[1].split('~');
        const code = fields[2]; // Pure numeric code: 000001, 399001 etc
        if (code && A_SHARE_MAP[code]) {
          const price = parseFloat(fields[3]);
          const prevClose = parseFloat(fields[4]);
          const changePct = parseFloat(fields[32]);
          aShares[code] = {
            name: A_SHARE_MAP[code],
            price,
            prevClose,
            change: price - prevClose,
            changePercent: changePct,
          };
        }
      }
    } catch (e) {
      console.error('[market] A-share fetch failed:', e.message);
    }
    
    // NASDAQ & S&P 500 from Yahoo (价格+涨跌幅)
    let nasdaq = null, sp500 = null;
    try {
      const [nasRes, spRes] = await Promise.all([
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC', {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000,
        }),
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC', {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000,
        }),
      ]);
      const nasMeta = nasRes.data.chart.result[0].meta;
      const spMeta = spRes.data.chart.result[0].meta;
      nasdaq = {
        price: nasMeta.regularMarketPrice,
        changePercent: (nasMeta.regularMarketPrice / nasMeta.previousClose - 1) * 100,
      };
      sp500 = {
        price: spMeta.regularMarketPrice,
        changePercent: (spMeta.regularMarketPrice / spMeta.previousClose - 1) * 100,
      };
    } catch (e) {
      console.error('[market] Yahoo failed:', e.message);
    }
    
    // BTC price as 币圈 indicator
    let btcPrice = null;
    if (majors.length > 0) {
      const btc = majors.find(t => t.symbol === 'BTCUSDT');
      if (btc) btcPrice = btc.price;
    }
    
    const result = {
      crypto: { changePercent: totalCryptoChg, btcPrice },
      aShares,
      nasdaq,
      sp500,
    };
    
    marketCache = { data: result, time: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Market Indicators (恐惧贪婪 + 山寨季) =====
app.get("/api/market/indicators", async (req, res) => {
  const result = { fear: null, altSeason: null };
  try {
    const fng = await axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 5000 });
    const fngData = fng.data.data[0];
    result.fear = { value: parseInt(fngData.value), label: fngData.value_classification };
  } catch(e) {}
  try {
    // 从CoinGecko BTC主导率算山寨季指数（标准算法）
    const cg = await axios.get("https://api.coingecko.com/api/v3/global", { timeout: 5000 });
    const btcDom = cg.data.data.market_cap_percentage.btc;
    // 映射: 主导率30%→100分(强山寨), 55%→50分(中性), 80%→0分(强比特)
    const score = Math.max(0, Math.min(100, Math.round((1 - (btcDom - 30) / 50) * 100)));
    result.altSeason = { value: score, btcDominance: btcDom };
  } catch(e) {}
  res.json(result);
});

// ===== DeFi 质押收益率排行 =====
let llamaCache = { data: null, time: 0 };
app.get('/api/defi/llama', async (req, res) => {
  const minTvl = parseFloat(req.query.minTvl || '1000000');
  const limit = parseInt(req.query.limit || '50');
  if (llamaCache.data && Date.now() - llamaCache.time < 300000) {
    const sliced = { ...llamaCache.data, pools: llamaCache.data.pools.slice(0, limit) };
    return res.json(sliced);
  }
  try {
    const r = await axios.get('https://yields.llama.fi/pools', { timeout: 15000 });
    const pools = r.data.data || [];
    const minTvl = parseFloat(req.query.minTvl || '1000000');
    const limit = parseInt(req.query.limit || '30');
    const chainFilter = (req.query.chain || '').toLowerCase();
    const projectFilter = (req.query.project || '').toLowerCase();
    const projectList = projectFilter ? projectFilter.split(',').map(s => s.trim()) : [];
    
    const filtered = pools.filter(p => {
      if (p.tvlUsd < minTvl) return false;
      if (!p.apy || p.apy <= 0) return false;
      if (chainFilter && p.chain && p.chain.toLowerCase() !== chainFilter) return false;
      if (projectList.length > 0 && p.project && !projectList.includes(p.project.toLowerCase())) return false;
      return true;
    });
    filtered.sort((a, b) => (b.apy || 0) - (a.apy || 0));
    
    // 缓存全量过滤后的池子（不截断），返回时按 limit 截断
    llamaCache = {
      data: {
        updated: Date.now(),
        total: filtered.length,
        chains: [...new Set(pools.filter(p => p.chain).map(p => p.chain))].sort(),
        projects: Object.values(pools.reduce((m, p) => {
          if (!p.project) return m;
          const key = p.project.toLowerCase();
          if (!m[key] || p.apy > m[key].maxApy) m[key] = { name: p.project, maxApy: p.apy };
          return m;
        }, {})).sort((a, b) => b.maxApy - a.maxApy),
        pools: filtered.map(p => ({
          symbol: p.symbol || '?',
          apy: parseFloat((p.apy || 0).toFixed(2)),
          tvl: p.tvlUsd || 0,
          project: p.project || '?',
          chain: p.chain || '?',
        })),
      },
      time: Date.now(),
    };
    // 每次按请求的 limit 截断返回
    const sliced = {
      ...llamaCache.data,
      pools: llamaCache.data.pools.slice(0, limit),
    };
    res.json(sliced);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== 聊天后门 =====
const BD_DIR = path.join(__dirname, 'public', 'data', 'bd');
if (!fs.existsSync(BD_DIR)) fs.mkdirSync(BD_DIR, { recursive: true });

// 用户发消息
app.post('/api/bd/send', express.json(), (req, res) => {
  const { uid, msg } = req.body || {};
  if (!uid || !msg) return res.json({ ok: false });
  const file = path.join(BD_DIR, `${uid}.json`);
  let data = { messages: [] };
  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  data.messages.push({ role: 'user', text: msg, time: Date.now() });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  // 设置思考标记
  fs.writeFileSync(path.join(BD_DIR, `${uid}_thinking.flag`), '1');
  res.json({ ok: true });
});

// 获取消息
app.get('/api/bd/messages', (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ messages: [] });
  const file = path.join(BD_DIR, `${uid}.json`);
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch(e) {}
  res.json({ messages: [] });
});

// 检查思考状态 + 获取回复
app.get('/api/bd/status', (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ thinking: false, reply: null });
  const flagFile = path.join(BD_DIR, `${uid}_reply.json`);
  const thinkingFile = path.join(BD_DIR, `${uid}_thinking.flag`);
  const thinking = fs.existsSync(thinkingFile);
  let reply = null;
  try {
    if (fs.existsSync(flagFile)) {
      const d = JSON.parse(fs.readFileSync(flagFile, 'utf8'));
      if (d.reply) { reply = d.reply; fs.unlinkSync(flagFile); }
    }
  } catch(e) {}
  res.json({ thinking, reply });
});

// ===== Start server =====
// 启动后门 AI 工作器（后台线程）
const bdWorker = require('child_process').fork(path.join(__dirname, 'bd-worker.js'), [], {
  stdio: 'pipe',
  env: { ...process.env }
});
bdWorker.stdout.on('data', d => process.stdout.write('[bd-worker] ' + d));
bdWorker.stderr.on('data', d => process.stderr.write('[bd-worker] ' + d));
bdWorker.on('exit', (code) => {
  console.log(`⚠️ bd-worker exited with code ${code}, restarting in 5s...`);
  setTimeout(() => {
    const w = require('child_process').fork(path.join(__dirname, 'bd-worker.js'), [], {
      stdio: 'pipe', env: { ...process.env }
    });
    w.stdout.on('data', d => process.stdout.write('[bd-worker] ' + d));
    w.stderr.on('data', d => process.stderr.write('[bd-worker] ' + d));
  }, 5000);
});



// ===== 钱包监控 API =====
app.get('/api/wallets', (req, res) => {
  const file = path.join(DATA_DIR, 'wallets', 'latest.json');
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return res.json(data);
    }
  } catch(e) {}
  res.json({ updated: Date.now(), wallets: [] });
});

// 钱包历史（用于走势图）
app.get('/api/wallets/history/:id', (req, res) => {
  const file = path.join(DATA_DIR, 'wallets', 'history', req.params.id + '.jsonl');
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-60);
      const data = lines.map(l => JSON.parse(l));
      return res.json(data);
    }
  } catch(e) {}
  res.json([]);
});


// ===== 巨鲸转账 API =====
app.get('/api/whale/transfers', (req, res) => {
  const file = path.join(DATA_DIR, 'whale', 'transfers.json');
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch(e) {}
  res.json({ updated: Date.now(), transfers: [] });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Crypto Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`📡 Binance data: ${path.join(DATA_DIR, 'binance')}`);
  console.log(`🧠 BD Worker auto-started`);
});
