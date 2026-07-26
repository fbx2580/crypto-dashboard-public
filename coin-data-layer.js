#!/usr/bin/env node
/**
 * Market Data Layer V1 — Layer 2+3: 币种市场数据 + 合约资金数据
 * 覆盖全部 Binance USDT 合约
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const DATA_DIR = path.join(__dirname, 'public', 'data', 'market_data');
const COIN_DIR = path.join(DATA_DIR, 'coins');
const CACHE_DIR = path.join(__dirname, 'public', 'data', 'klines_cache');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [l2] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
async function getJSON(url, p = {}, t = 15000) { return (await axios.get(url, { params: p, timeout: t })).data; }

async function main() {
  L('Layer 2+3: 币种市场 + 合约资金数据');
  const today = new Date().toISOString().slice(0, 10);

  // 1. 获取全量合约列表
  const info = await getJSON(`${BINANCE_FAPI}/exchangeInfo`);
  const skip = new Set(['USDC','DAI','TUSD','BUSD','USDP','FDUSD','USDE','USDD']);
  const symbols = [];
  for (const s of (info.symbols || [])) {
    if (s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || s.contractType !== 'PERPETUAL') continue;
    if (skip.has(s.baseAsset)) continue;
    symbols.push({ base: s.baseAsset, symbol: s.symbol });
  }
  L(`合约: ${symbols.length} 个`);

  // 2. 批量获取 24h ticker + 资金费率 + OI
  const [tickers, premiums, ois] = await Promise.all([
    getJSON(`${BINANCE_FAPI}/ticker/24hr`),
    getJSON(`${BINANCE_FAPI}/premiumIndex`),
    getJSON(`${BINANCE_FAPI}/openInterest`, { symbol: 'BTCUSDT' }),
  ]);

  const tickerMap = {};
  for (const t of (tickers || [])) tickerMap[t.symbol] = t;
  const fundingMap = {};
  for (const p of (premiums || [])) fundingMap[p.symbol] = parseFloat(p.lastFundingRate || 0);
  const oiMap = {}; // OI will be fetched per-coin below
  // OI fetched individually

  L(`Ticker: ${Object.keys(tickerMap).length} | 费率: ${Object.keys(fundingMap).length} | OI: ${Object.keys(oiMap).length}`);

  // 3. 组装每个币的数据
  const coins = [];
  for (const s of symbols) {
    const t = tickerMap[s.symbol];
    if (!t) continue;

    const price = parseFloat(t.lastPrice || 0);
    const volume = parseFloat(t.quoteVolume || 0);
    const change24h = parseFloat(t.priceChangePercent || 0);
    const high24h = parseFloat(t.highPrice || 0);
    const low24h = parseFloat(t.lowPrice || 0);
    const oi = oiMap[s.symbol] || 0;
    const funding = fundingMap[s.symbol] || 0;

    coins.push({
      symbol: s.base,
      symbolRaw: s.symbol,
      price,
      change24h,
      high24h,
      low24h,
      volume24h: volume,
      amplitude24h: low24h > 0 ? ((high24h - low24h) / low24h * 100) : 0,
      openInterest: oi,
      oiNotional: oi * price,
      fundingRate: funding,
      fundingApr: funding * 3 * 365 * 100, // 年化费率(近似)
      rank_volume: 0,
      rank_oi: 0,
    });
  }

  // 排序
  coins.sort((a, b) => b.volume24h - a.volume24h);
  coins.forEach((c, i) => c.rank_volume = i + 1);
  coins.sort((a, b) => b.openInterest - a.openInterest);
  coins.forEach((c, i) => c.rank_oi = i + 1);
  coins.sort((a, b) => b.volume24h - a.volume24h); // 恢复成交量排序

  // 4. 提取 Top100 K线数据（太吃API，只拉前100）
  L('拉取 Top100 K线...');
  const top100 = coins.slice(0, 100);
  const klineMap = {};
  for (let i = 0; i < top100.length; i++) {
    const c = top100[i];
    try {
      const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: c.symbolRaw, interval: '1d', limit: 120 }, 8000);
      const closes = raw.map(k => +k[4]);
      const highs = raw.map(k => +k[2]);
      const lows = raw.map(k => +k[3]);
      const vol = raw.map(k => +k[5]);
      const n = closes.length;
      const price = closes[n - 1];
      if (n < 30) continue;

      const ath = Math.max(...highs);
      const absLow = Math.min(...lows);
      const vol30 = avg(vol.slice(-30));
      const vol90 = avg(vol.slice(-90));

      klineMap[c.symbol] = {
        dataDays: n,
        athPrice: ath,
        athDate: new Date(raw[highs.indexOf(ath)]?.[0] || 0).toISOString().slice(0, 10),
        athDistance: ((price - ath) / ath * 100),
        absLowPrice: absLow,
        absLowDistance: ((price - absLow) / absLow * 100),
        ret7d: (price / closes[Math.max(0, n - 8)] - 1) * 100,
        ret30d: (price / closes[Math.max(0, n - 31)] - 1) * 100,
        ret60d: (price / closes[Math.max(0, n - 61)] - 1) * 100,
        ret120d: n > 120 ? (price / closes[Math.max(0, n - 121)] - 1) * 100 : null,
        volRatio30_90: vol90 > 0 ? vol30 / vol90 : 1,
      };
    } catch(e) {}
    if ((i + 1) % 20 === 0) L(`  K线 ${i + 1}/${top100.length}`);
    await new Promise(r => setTimeout(r, 100));
  }
  L(`K线完成: ${Object.keys(klineMap).length} 个`);

  // 5. 汇总
  const summary = {
    totalCoins: coins.length,
    topByVolume: coins.slice(0, 10).map(c => ({ symbol: c.symbol, volume24h: c.volume24h, change24h: c.change24h })),
    topByOI: [...coins].sort((a,b) => b.openInterest - a.openInterest).slice(0, 10).map(c => ({ symbol: c.symbol, oi: c.openInterest, funding: c.fundingRate })),
    fundingSummary: {
      avgRate: avg(coins.map(c => c.fundingRate)),
      positiveCount: coins.filter(c => c.fundingRate > 0).length,
      negativeCount: coins.filter(c => c.fundingRate < 0).length,
      extremeHigh: coins.filter(c => c.fundingRate > 0.005).length,
      extremeLow: coins.filter(c => c.fundingRate < -0.005).length,
    },
    oiSummary: {
      totalOI: coins.reduce((s,c) => s + c.oiNotional, 0),
      avgOI: avg(coins.map(c => c.oiNotional)),
    },
    top100KlineAvailable: Object.keys(klineMap).length,
  };

  // 6. 保存
  if (!fs.existsSync(COIN_DIR)) fs.mkdirSync(COIN_DIR, { recursive: true });

  // 全量币种快照
  const coinFile = path.join(COIN_DIR, `${today}.json`);
  fs.writeFileSync(coinFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    date: today,
    summary,
    klineData: klineMap,
    coins: coins.map(c => ({
      symbol: c.symbol,
      price: c.price,
      change24h: c.change24h,
      volume24h: c.volume24h,
      amplitude24h: c.amplitude24h,
      openInterest: c.openInterest,
      oiNotional: c.oiNotional,
      fundingRate: c.fundingRate,
      rank_volume: c.rank_volume,
      rank_oi: c.rank_oi,
    })),
  }, null, 2));

  // 摘要更新
  fs.writeFileSync(path.join(DATA_DIR, 'coin_summary_latest.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    summary,
    top100OI: [...coins].sort((a,b) => b.openInterest - a.openInterest).slice(0, 20).map(c => ({ symbol: c.symbol, price: c.price, oi: c.openInterest, funding: c.fundingRate, change24h: c.change24h })),
  }, null, 2));

  // ===== 打印 =====
  console.log('\n' + '═'.repeat(55));
  console.log(`📊 Layer 2+3 快照 — ${today}`);
  console.log('═'.repeat(55));
  console.log(`\n全量: ${coins.length} 合约 | K线: ${Object.keys(klineMap).length} 个`);
  console.log(`\n📈 Top 10 成交量:`);
  coins.slice(0, 10).forEach(c => console.log(`  ${c.symbol.padEnd(8)} $${(c.volume24h/1e6).toFixed(0)}M | ${c.change24h.toFixed(1)}% | OI $${(c.oiNotional/1e6).toFixed(0)}M | 费率 ${(c.fundingRate*100).toFixed(3)}%`));
  console.log(`\n💀 极端费率(>0.5%): ${summary.fundingSummary.extremeHigh}个 | 负费率: ${summary.fundingSummary.negativeCount}个`);
  console.log(`💰 总OI: $${(summary.oiSummary.totalOI/1e9).toFixed(1)}B`);

  L(`✅ 币种数据 → ${COIN_DIR}/${today}.json (${(fs.statSync(coinFile).size/1024).toFixed(0)}KB)`);

  // ═══ 自动增量 K线缓存（每次补50个未缓存币） ═══
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cached = new Set(fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));
  const uncached = symbols.filter(s => !cached.has(s.base));
  const batch = uncached.slice(0, 50);
  let added = 0;
  for (const s of batch) {
    try {
      const raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: s.symbol, interval: '1d', limit: 400 }, 8000);
      if (!raw || raw.length < 100) continue;
      const klines = raw.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] }));
      fs.writeFileSync(path.join(CACHE_DIR, `${s.base}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), symbol: s.base, klines }));
      added++;
    } catch(e) {}
    if (added % 10 === 0 && added > 0) L(`  增量缓存: ${added}/${batch.length} | 总: ${cached.size + added}/${symbols.length}`);
    await new Promise(r => setTimeout(r, 100));
  }
  if (added > 0) L(`✅ 自动增量缓存: +${added}个, 总覆盖 ${cached.size + added}/${symbols.length}`);
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
