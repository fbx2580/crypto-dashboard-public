// =====================================================================
// 币安永续合约数据采集器
// 替代原现货版，使用 fapi (USD-M Futures)
// 包括：K线、24h ticker、资金费率、持仓量
// =====================================================================

const axios = require('axios');
const apiMon = require('./api-monitor');
try { apiMon.wrapAxios(axios); } catch(e){}
const fs = require('fs');
const path = require('path');

const FUTURES_BASE = 'https://fapi.binance.com';

const DATA_DIR = path.join(__dirname, 'public', 'data', 'binance');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── 主流永续合约对 ───
const MAJOR_PAIRS = [
  'SOLUSDT', 'BNBUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT',
];

const INTERVALS = {
  '1m': { ms: 60000, label: '1分钟' },
  '5m': { ms: 300000, label: '5分钟' },
  '15m': { ms: 900000, label: '15分钟' },
  '1h': { ms: 3600000, label: '1小时' },
  '4h': { ms: 14400000, label: '4小时' },
  '1d': { ms: 86400000, label: '日线' },
};

// ─── 获取所有永续合约列表 ───
let cachedPerps = null;
async function getPerpetualSymbols() {
  if (cachedPerps) return cachedPerps;
  const res = await axios.get(`${FUTURES_BASE}/fapi/v1/exchangeInfo`, { timeout: 10000 });
  cachedPerps = res.data.symbols
    .filter(s => (s.contractType === 'PERPETUAL' || s.contractType === 'TRADIFI_PERPETUAL') && s.status === 'TRADING')
    .map(s => s.symbol);
  return cachedPerps;
}

// ─── 拉取永续K线 ───
async function fetchAndSaveKlines(symbol, interval = '1h', limit = 100) {
  const dir = path.join(DATA_DIR, 'perps', symbol, interval);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    const res = await axios.get(`${FUTURES_BASE}/fapi/v1/klines`, {
      params: { symbol, interval, limit },
      timeout: 10000,
    });

    const candles = res.data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quoteVol: parseFloat(k[7]),
      trades: k[8],
      takerBuyVol: parseFloat(k[9]),
      takerBuyQuoteVol: parseFloat(k[10]),
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `${dateStr}.json`);

    let existing = [];
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const merged = mergeCandles(existing, candles);
    fs.writeFileSync(filePath, JSON.stringify(merged));

    return candles;
  } catch (err) {
    console.error(`  ✗ ${symbol} ${interval}: ${err.message}`);
    return [];
  }
}

function mergeCandles(existing, incoming) {
  const map = new Map();
  for (const c of existing) map.set(c.time, c);
  for (const c of incoming) map.set(c.time, c);
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// ─── 全量永续 ticker ───
async function getAllPerpTickers() {
  try {
    const res = await axios.get(`${FUTURES_BASE}/fapi/v1/ticker/24hr`, { timeout: 10000 });
    return res.data.map(t => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.volume),
      quoteVolume: parseFloat(t.quoteVolume),
      high24h: parseFloat(t.highPrice),
      low24h: parseFloat(t.lowPrice),
      count: parseFloat(t.count),
    }));
  } catch (err) {
    console.error('  ✗ ticker:', err.message);
    return [];
  }
}

// ─── 资金费率 ───
async function getFundingRates(symbols) {
  try {
    const res = await axios.get(`${FUTURES_BASE}/fapi/v1/premiumIndex`, { timeout: 10000 });
    const data = res.data;
    const result = {};
    for (const d of data) {
      if (symbols.includes(d.symbol)) {
        result[d.symbol] = {
          fundingRate: parseFloat(d.lastFundingRate) * 100,
          nextFundingTime: d.nextFundingTime,
          markPrice: parseFloat(d.markPrice),
        };
      }
    }
    return result;
  } catch (err) {
    return {};
  }
}

// ─── 持仓量 ───
async function getOpenInterest(symbol) {
  try {
    const res = await axios.get(`${FUTURES_BASE}/fapi/v1/openInterest`, {
      params: { symbol },
      timeout: 10000,
    });
    return parseFloat(res.data.openInterest);
  } catch (err) {
    return 0;
  }
}

// ─── 主采集任务 ───
async function fetchAll(interval = '1h', limit = 50) {
  console.log(`\n📡 币安永续合约采集 [${INTERVALS[interval]?.label || interval}]`);
  console.log('-'.repeat(50));

  const allPerps = await getPerpetualSymbols();
  const altPerps = allPerps.filter(p => !MAJOR_PAIRS.includes(p));

  // 主流永续 K线
  console.log('\n🏦 主流永续...');
  for (const pair of MAJOR_PAIRS) {
    const candles = await fetchAndSaveKlines(pair, interval, limit);
    if (candles.length > 0) {
      const last = candles[candles.length - 1];
      console.log(`  ✓ ${pair}: $${last.close.toFixed(2)} | 量 ${(last.volume / 1000).toFixed(0)}K`);
    }
  }

  // 全量 ticker
  const allTickers = await getAllPerpTickers();
  const usdtTickers = allTickers.filter(t => t.symbol.endsWith('USDT') && allPerps.includes(t.symbol));

  console.log(`\n🪙 总永续合约: ${allPerps.length} | USDT永续: ${usdtTickers.length}`);

  // 量能异常
  const vols = usdtTickers.map(t => t.quoteVolume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const anomalies = usdtTickers
    .filter(t => t.quoteVolume > avgVol * 5 && !MAJOR_PAIRS.includes(t.symbol))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 15);

  if (anomalies.length > 0) {
    console.log('\n⚡ 量能异常（山寨永续）：');
    anomalies.forEach(t => {
      const chg = t.change24h >= 0 ? '+' : '';
      console.log(`  ${t.symbol}: $${t.price.toFixed(4)} | ${chg}${t.change24h.toFixed(2)}% | 量 $${(t.quoteVolume / 1e6).toFixed(1)}M`);
    });
  }

  // 资金费率
  const fundingRates = await getFundingRates(MAJOR_PAIRS);
  console.log('\n💰 资金费率:');
  for (const [sym, fr] of Object.entries(fundingRates)) {
    console.log(`  ${sym}: ${fr.fundingRate.toFixed(4)}% | Mark: $${fr.markPrice.toFixed(2)}`);
  }

  // 保存快照
  const snapshot = {
    timestamp: Date.now(),
    interval,
    majors: usdtTickers.filter(t => MAJOR_PAIRS.includes(t.symbol)),
    anomalies,
    allTickers: usdtTickers,
    fundingRates,
    totalPerps: allPerps.length,
  };
  const snapshotFile = path.join(DATA_DIR, 'latest_snapshot.json');
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

  console.log(`\n✅ 永续采集完成`);
  return snapshot;
}

// ─── 拉历史数据用于回测 ───
async function fetchHistorical(symbol, interval = '1h', days = 30) {
  console.log(`\n📜 拉历史永续数据: ${symbol} ${interval} ${days}天`);
  const limit = 500;
  const allCandles = [];
  let endTime = Date.now();

  while (allCandles.length < days * (24 * 60 / parseInt(interval))) {
    try {
      const res = await axios.get(`${FUTURES_BASE}/fapi/v1/klines`, {
        params: { symbol, interval, endTime, limit },
        timeout: 10000,
      });
      if (res.data.length === 0) break;
      const candles = res.data.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
      allCandles.unshift(...candles);
      endTime = candles[0]?.time * 1000 - 1 || endTime - 86400000;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      break;
    }
  }

  const dir = path.join(DATA_DIR, 'historical', symbol, interval);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${days}d.json`), JSON.stringify(allCandles));
  console.log(`  ✅ ${allCandles.length} candles saved`);
  return allCandles;
}

// ─── 获取本地数据 ───
function getBinanceData(symbol, interval = '1h') {
  const dir = path.join(DATA_DIR, 'perps', symbol, interval);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).sort().slice(-7);
  const all = [];
  for (const file of files) {
    const fp = path.join(dir, file);
    if (fs.existsSync(fp)) all.push(...JSON.parse(fs.readFileSync(fp, 'utf8')));
  }
  return all.sort((a, b) => a.time - b.time);
}

function getLatestSnapshot() {
  const file = path.join(DATA_DIR, 'latest_snapshot.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

// ─── 独立运行 ───
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'historical') {
    fetchHistorical(process.argv[3] || 'BTCUSDT', process.argv[4] || '1h', parseInt(process.argv[5]) || 30)
      .catch(console.error);
  } else if (cmd === 'daemon') {
    // 持续采集模式
    console.log('📡 Binance 持续采集启动');
    const CACHE_DIR = path.join(DATA_DIR, '..', 'binance');
    // 快循环：每 30 秒拉一次 ticker（仅大看板需要）
    let _rateLimitUntil = 0;
    async function fastLoop() {
      if (Date.now() < _rateLimitUntil) {
        setTimeout(fastLoop, 10000);
        return;
      }
      try {
        // 只拉 ticker/24hr（全量，权重 40）→ 30秒一次 = 80/分钟，远低于 1200 限额
        const tickers = await getAllPerpTickers();
        if (tickers && tickers.length > 100) {
          const usdtTickers = tickers.filter(t => t.symbol.endsWith('USDT'));
          if (usdtTickers.length < 100) { console.log('[binance] ⚠ ticker不足', usdtTickers.length, ', 跳过写入'); setTimeout(fastLoop, 30000); return; }
          const vols = usdtTickers.map(t => t.quoteVolume);
          const avgVol = vols.filter(v => v > 0).reduce((a, b) => a + b, 0) / (vols.filter(v => v > 0).length || 1);
          const store = {
            timestamp: Date.now(),
            majors: usdtTickers.filter(t => ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'].includes(t.symbol)),
            anomalies: usdtTickers.filter(t => t.quoteVolume > avgVol * 3).sort((a,b) => b.quoteVolume - a.quoteVolume).slice(0, 15),
            allTickers: usdtTickers,
            totalTickers: tickers.length,
          };
          fs.writeFileSync(path.join(CACHE_DIR, 'latest_snapshot.json'), JSON.stringify(store, null, 2));
          console.log('[binance] ⚡ tickers updated', store.allTickers.length, 'USDT pairs');
        }
      } catch(e) {
        const status = e.response?.status || 0;
        if (status === 429 || status === 418) {
          const wait = status === 418 ? 600000 : 180000;
          _rateLimitUntil = Date.now() + wait;
          console.log('[binance] 🚫 限流', status, '退避', Math.round(wait/60), '分钟');
        } else {
          console.error('[binance] ✗ fast:', e.message);
        }
      }
      setTimeout(fastLoop, 30000);
    }
    // 慢循环已禁用（资金费率/持仓量/K线均无用）
    fastLoop();
  } else {
    fetchAll(process.argv[3] || '1h', parseInt(process.argv[4]) || 50)
      .catch(console.error);
  }
}

module.exports = { fetchAll, fetchHistorical, getBinanceData, getLatestSnapshot, getAllPerpTickers, getPerpetualSymbols, MAJOR_PAIRS };
