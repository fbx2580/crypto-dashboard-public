#!/usr/bin/env node
/**
 * Quant Dashboard — 独立量化面板
 * 端口 3002，不动原有系统
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public-quant')));
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'public', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'klines_cache');
const MKT_DIR = path.join(DATA_DIR, 'market_data');

function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

// ═══ API ═══

// 市场状态
app.get('/api/market', (req, res) => {
  try {
    const f = path.join(MKT_DIR, 'latest.json');
    if (!fs.existsSync(f)) return res.json({});
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const btc = d.btc || {}, eth = d.eth || {}, ethbtc = d.ethbtc || {}, cg = d.coingecko || {};
    res.json({
      btc: { price: btc.price, change24h: btc.change24h, ma200: btc.ma200, ret30d: btc.ret30d, volatility: btc.volatility30d, high24h: btc.high24h, low24h: btc.low24h, volume24h: btc.volume24h, source: btc.source || 'Binance FAPI', updatedAt: btc.updatedAt || null },
      eth: { price: eth.price, ret30d: eth.ret30d, source: 'Binance FAPI' },
      ethbtc: { price: ethbtc.price, ret30d: ethbtc.ret30d, source: 'Binance FAPI' },
      dominance: { btc: cg.btcDominance, eth: cg.ethDominance, source: 'CoinGecko' },
      totalMC: cg.totalMarketCap,
      total3: { status: '数据缺失', note: 'CoinGecko free tier 不提供 TOTAL3' },
      updatedAt: new Date().toISOString(),
    });
  } catch(e) { res.json({ error: e.message }); }
});

// 币种扫描（从缓存K线实时计算）
app.get('/api/scan', (req, res) => {
  try {
    const files = (fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : []).filter(f => f.endsWith('.json'));
    const results = [];
    for (const file of files.slice(0, 200)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
        const kl = d.klines || [];
        const n = kl.length;
        if (n < 60) continue;
        const closes = kl.map(k => k.close);
        const highs = kl.map(k => k.high);
        const lows = kl.map(k => k.low);
        const vols = kl.map(k => k.volume);
        const price = closes[n - 1];

        // 简单指标
        const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const ma60 = closes.slice(-60).reduce((a,b)=>a+b,0)/60;
        const ath = Math.max(...highs);
        const absLow = Math.min(...lows);
        const vol30 = avg(vols.slice(-30));
        const vol90 = avg(vols.slice(-90));
        const volRatio = vol90 > 0 ? vol30 / vol90 : 1;
        const ret7d = (price / closes[Math.max(0, n - 8)] - 1) * 100;
        const ret30d = (price / closes[Math.max(0, n - 31)] - 1) * 100;
        const high60 = Math.max(...highs.slice(-60, -1));
        const nearHigh = price > high60 * 0.95;
        const trendUp = ma20 > ma60;

        results.push({
          symbol: d.symbol || file.replace('.json', ''),
          price, ret7d, ret30d,
          vsMA20: ((price - ma20) / ma20 * 100),
          vsATH: ((price - ath) / ath * 100),
          fromLow: ((price - absLow) / absLow * 100),
          volRatio,
          nearHigh,
          trendUp,
          dataDays: n,
        });
      } catch(e) {}
    }

    // 排序：强势优先
    results.sort((a,b) => {
      const scoreA = (a.nearHigh ? 3 : 0) + (a.trendUp ? 2 : 0) + (a.ret7d > 5 ? 2 : 0) + (a.volRatio > 1.2 ? 1 : 0);
      const scoreB = (b.nearHigh ? 3 : 0) + (b.trendUp ? 2 : 0) + (b.ret7d > 5 ? 2 : 0) + (b.volRatio > 1.2 ? 1 : 0);
      return scoreB - scoreA;
    });

    res.json({ updated: new Date().toISOString(), count: results.length, results: results.slice(0, 100) });
  } catch(e) { res.json({ error: e.message, results: [] }); }
});

// 币种详情
app.get('/api/coin/:symbol', (req, res) => {
  try {
    const file = path.join(CACHE_DIR, `${req.params.symbol}.json`);
    if (!fs.existsSync(file)) return res.json({ error: '未缓存' });
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kl = d.klines || [];
    const n = kl.length;
    const closes = kl.map(k => k.close);
    const highs = kl.map(k => k.high);
    const lows = kl.map(k => k.low);
    const vols = kl.map(k => k.volume);
    const price = closes[n - 1];

    // 返回最近 200 天 OHLCV
    const chart = kl.slice(-200).map(k => ({
      t: new Date(k.time).toISOString().slice(0, 10),
      o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
    }));

    const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
    const ma60 = closes.slice(-60).reduce((a,b)=>a+b,0)/60;
    const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a,b)=>a+b,0)/200 : ma60;
    const ath = Math.max(...highs);
    const absLow = Math.min(...lows);

    res.json({
      symbol: req.params.symbol,
      price,
      ret7d: (price / closes[Math.max(0, n - 8)] - 1) * 100,
      ret30d: (price / closes[Math.max(0, n - 31)] - 1) * 100,
      ret90d: (price / closes[Math.max(0, n - 91)] - 1) * 100,
      ma20, ma60, ma200,
      ath, athDistance: ((price - ath) / ath * 100),
      absLow, lowDistance: ((price - absLow) / absLow * 100),
      dataDays: n,
      chart,
    });
  } catch(e) { res.json({ error: e.message }); }
});

// ═══ 新闻 ═══
app.get('/api/news', (req, res) => {
  try {
    const items = [];
    for (const src of ['jin10', 'latest']) {
      const f = path.join(DATA_DIR, 'news', `${src}.json`);
      if (!fs.existsSync(f)) continue;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const item of (d.items || []).slice(0, 20)) {
        items.push({ time: item.t || '', title: (item.body || item.title || '').slice(0, 120), source: src });
      }
    }
    items.sort((a,b) => b.time.localeCompare(a.time));
    res.json({ items: items.slice(0, 30) });
  } catch(e) { res.json({ items: [] }); }
});

// ═══ 异动 ═══
app.get('/api/alerts', (req, res) => {
  try {
    const f = path.join(DATA_DIR, 'alerts', 'price_alerts.json');
    const items = [];
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const a of (d.alerts || []).slice(0, 20)) {
        items.push({ time: new Date(a.time||Date.now()).toISOString(), symbol: a.symbol, change: a.change, level: a.level });
      }
    }
    res.json({ items });
  } catch(e) { res.json({ items: [] }); }
});

// ═══ 合约数据（资金费率+OI） ═══
app.get('/api/derivatives', (req, res) => {
  try {
    const f = path.join(MKT_DIR, 'coins', `${new Date().toISOString().slice(0,10)}.json`);
    if (!fs.existsSync(f)) return res.json({ items: [] });
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const coins = (d.coins || []).filter(c => c.volume24h > 500000).sort((a,b) => b.volume24h - a.volume24h).slice(0, 30);
    res.json({
      items: coins.map(c => ({
        symbol: c.symbol, price: c.price, change24h: c.change24h,
        volume24h: c.volume24h, fundingRate: c.fundingRate,
      })),
      summary: {
        avgFunding: avg(coins.map(c => c.fundingRate)),
        positiveCount: coins.filter(c => c.fundingRate > 0).length,
        negativeCount: coins.filter(c => c.fundingRate < 0).length,
        extremeCount: coins.filter(c => Math.abs(c.fundingRate) > 0.005).length,
      }
    });
  } catch(e) { res.json({ items: [], summary: {} }); }
});

// ═══ 数据源状态 ═══
app.get('/api/status', (req, res) => {
  const checks = [
    { name: 'Binance API', ok: fs.existsSync(path.join(CACHE_DIR, 'BTC.json')) },
    { name: 'K线缓存', ok: (fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : []).filter(f=>f.endsWith('.json')).length > 500 },
    { name: '新闻源', ok: fs.existsSync(path.join(DATA_DIR, 'news', 'jin10.json')) },
    { name: '异动监控', ok: fs.existsSync(path.join(DATA_DIR, 'alerts', 'price_alerts.json')) },
    { name: '市场快照', ok: fs.existsSync(path.join(MKT_DIR, 'latest.json')) },
    { name: '币种数据', ok: fs.existsSync(path.join(MKT_DIR, 'coins', `${new Date().toISOString().slice(0,10)}.json`)) },
  ];
  res.json({ checks });
});

// ═══ 数据中心 ═══
app.get('/api/datacenter', (req, res) => {
  const stats = { sources: [], coverage: {}, storage: {}, fields: {} };

  // 数据源状态
  stats.sources = [
    { name: 'Binance FAPI', ok: true, lastSync: '实时', volume: '528合约' },
    { name: 'CoinGecko', ok: fs.existsSync(path.join(MKT_DIR, 'latest.json')), lastSync: '每日01:00', volume: 'BTC.D/总市值' },
    { name: 'K线缓存', ok: fs.existsSync(CACHE_DIR), lastSync: '实时(自动增量)', volume: (fs.existsSync(CACHE_DIR)?fs.readdirSync(CACHE_DIR).filter(f=>f.endsWith('.json')).length:0)+' 币' },
    { name: '新闻 RSS', ok: fs.existsSync(path.join(DATA_DIR, 'news', 'latest.json')), lastSync: '每2分钟', volume: 'RSS+金十' },
    { name: '鲸鱼监控', ok: fs.existsSync(path.join(DATA_DIR, 'whale', 'transfers.json')), lastSync: '每10分钟', volume: 'ETH链' },
    { name: '异动监控', ok: fs.existsSync(path.join(DATA_DIR, 'alerts', 'price_alerts.json')), lastSync: '每小时', volume: '全合约' },
  ];

  // K线覆盖
  const cacheFiles = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter(f=>f.endsWith('.json')) : [];
  const totalTarget = 528;
  stats.coverage = {
    kline: { cached: cacheFiles.length, target: totalTarget, pct: (cacheFiles.length/totalTarget*100).toFixed(0)+'%' },
    periods: ['1d'],
    oldestSync: cacheFiles.length ? (()=>{try{const f=JSON.parse(fs.readFileSync(path.join(CACHE_DIR,cacheFiles[0]),'utf8'));return f.fetchedAt?.slice(0,19)||'未知'}catch(e){return'未知'}})() : '无',
    missing: totalTarget - cacheFiles.length,
  };

  // 存储目录
  const dirs=['market_data','klines_cache','news','alerts','whale','wallets','binance','analysis','bd'];
  stats.storage = dirs.map(d => {
    const p = path.join(DATA_DIR, d);
    if(!fs.existsSync(p)) return { dir: d, files: 0, size: 0, updated: null };
    const files = fs.readdirSync(p,{recursive:true}).filter(f=>fs.statSync(path.join(p,f)).isFile());
    const size = files.reduce((s,f)=>s+(fs.statSync(path.join(p,f)).size||0),0);
    return { dir: d, files: files.length, size: (size/1024/1024).toFixed(1)+'MB', updated: files.length?(()=>{const newest=files.map(f=>fs.statSync(path.join(p,f)).mtimeMs).sort((a,b)=>b-a)[0];return new Date(newest).toISOString().slice(0,16)})():'无'};
  });

  // 字段字典
  stats.fields = {
    btc: ['price','change24h','high24h','low24h','volume24h','ma200','volatility','ret7d','ret30d','athDistance','source','updatedAt'],
    eth: ['price','change24h','ret30d'],
    ethbtc: ['price','ret7d','ret30d','ret90d'],
    coingecko: ['btcDominance','ethDominance','totalMarketCap','activeCoins'],
    coin: ['symbol','price','change24h','volume24h','fundingRate','rank_volume','rank_oi'],
    news: ['time','title','source'],
    alerts: ['symbol','change','level','time'],
  };

  res.json(stats);
});

// ═══ Market Regime ═══
app.get('/api/regime', (req, res) => {
  try {
    const f = path.join(MKT_DIR, 'latest.json');
    if (!fs.existsSync(f)) return res.json({ error: '市场数据未就绪' });
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const b = d.btc || {}, eb = d.ethbtc || {}, cg = d.coingecko || {};
    const price = b.price, ma200 = b.ma200, ret30d = b.ret30d, vol = b.volatility30d;
    const isAboveMA200 = price > ma200;
    const distMA200 = ((price - ma200) / ma200 * 100);

    const regime = {
      btc: {
        price: price,
        trend: ret30d > 3 ? { label: '上涨', class: 'up' } : ret30d < -3 ? { label: '下跌', class: 'down' } : { label: '震荡', class: 'neutral' },
        vsMA200: { label: isAboveMA200 ? '上方' : '下方', class: isAboveMA200 ? 'up' : 'down', distance: distMA200.toFixed(1) + '%' },
        volatility: { label: vol > 0.5 ? 'High' : vol > 0.3 ? 'Normal' : 'Low', class: vol > 0.5 ? 'high' : vol > 0.3 ? 'normal' : 'low', value: (vol * 100).toFixed(0) + '%' },
        state: isAboveMA200 && ret30d > 0 ? 'BULL' : !isAboveMA200 && ret30d < -5 ? 'BEAR' : 'SIDEWAYS',
      },
      altcoin: {
        btcDominance: cg.btcDominance,
        ethbtcPrice: eb.price,
        ethbtcTrend: eb.ret30d > 3 ? '走强' : eb.ret30d < -3 ? '走弱' : '持平',
        totalMC: cg.totalMarketCap,
        state: cg.btcDominance > 60 ? 'BTC_SEASON' : eb.ret30d > 5 ? 'ALT_SEASON' : 'NEUTRAL',
      },
      risk: {
        level: vol > 0.6 || cg.btcDominance > 65 ? 'HIGH' : vol > 0.4 ? 'MEDIUM' : 'LOW',
        factors: [],
      },
      updatedAt: new Date().toISOString(),
      sources: { btc: 'Binance FAPI', alt: 'CoinGecko', ethbtc: 'Binance FAPI' },
    };

    // 风险因素
    if (vol > 0.5) regime.risk.factors.push('BTC高波动');
    if (cg.btcDominance > 60) regime.risk.factors.push('BTC主导(山寨弱势)');
    if (!isAboveMA200) regime.risk.factors.push('BTC低于MA200');

    // 保存历史快照
    const histDir = path.join(MKT_DIR, 'regime_history');
    if (!fs.existsSync(histDir)) fs.mkdirSync(histDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(histDir, `${today}.json`), JSON.stringify({ date: today, ...regime }, null, 2));

    res.json(regime);
  } catch(e) { res.json({ error: e.message }); }
});

// 历史 regime 记录
app.get('/api/regime/history', (req, res) => {
  try {
    const histDir = path.join(MKT_DIR, 'regime_history');
    if (!fs.existsSync(histDir)) return res.json({ history: [] });
    const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json')).sort();
    const history = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8')); } catch(e) { return null; }
    }).filter(Boolean).slice(-30);
    res.json({ history });
  } catch(e) { res.json({ history: [] }); }
});

// ═══ 数据质量 ═══
app.get('/api/data-quality', (req, res) => {
  try {
    const f = path.join(MKT_DIR, 'data_quality.json');
    if (!fs.existsSync(f)) return res.json({ error: '质量报告未生成' });
    res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch(e) { res.json({ error: e.message }); }
});

app.listen(3002, '0.0.0.0', () => {
  console.log('📊 Quant Dashboard — Port 3002');
});
