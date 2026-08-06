// ─── 大盘行情模块 ───
const express = require('express');
const axios = require('axios');
const router = express.Router();

let marketCache = { data: null, time: 0 };

// 大盘总览
router.get('/overview', async (req, res) => {
  if (marketCache.data && Date.now() - marketCache.time < 60000) {
    return res.json(marketCache.data);
  }
  try {
    const snapshot = getLatestSnapshot();
    const majors = snapshot?.majors || [];
    let totalCryptoChg = 0, cryptoVol = 0;
    if (majors.length > 0) {
      const weighted = majors.reduce((s, t) => {
        const w = t.quoteVolume || 0;
        return { chg: s.chg + (t.change24h || 0) * w, vol: s.vol + w };
      }, { chg: 0, vol: 0 });
      totalCryptoChg = weighted.vol > 0 ? weighted.chg / weighted.vol : 0;
      cryptoVol = weighted.vol;
    }

    const A_SHARE_MAP = { '000001': '上证指数', '399001': '深证成指', '399006': '创业板指', '000300': '沪深300' };
    let aShares = {};
    try {
      const aRes = await axios.get('https://web.sqt.gtimg.cn/q=sh000001,sz399001,sz399006,sh000300', {
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
      });
      const regex = /v_\w+="([^"]+)"/g;
      let match;
      while ((match = regex.exec(aRes.data)) !== null) {
        const fields = match[1].split('~');
        const code = fields[2];
        if (code && A_SHARE_MAP[code]) {
          aShares[code] = { name: A_SHARE_MAP[code], price: parseFloat(fields[3]), changePercent: parseFloat(fields[32]) };
        }
      }
    } catch(e) {}

    let nasdaq = null, sp500 = null, oil = null, gold = null, dxy = null, cny = null, hsi = null, tnx = null, sox = null;
    try {
      const yfetch = url => axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
      const delay = ms => new Promise(r => setTimeout(r, ms));
      
      // 每批2个，间隔500ms 避免 Yahoo 418
      const [nasRes, spRes] = await Promise.all([
        yfetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC'),
        yfetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC'),
      ]); await delay(500);
      const [dxyRes, hsiRes] = await Promise.all([
        yfetch('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB'),
        yfetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EHSI'),
      ]); await delay(500);
      const [tnxRes, soxRes] = await Promise.all([
        yfetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX'),
        yfetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX'),
      ]); await delay(500);
      const cnyRes = await yfetch('https://query1.finance.yahoo.com/v8/finance/chart/CNY%3DX?range=1d&interval=1d');
      // 币安这两个不互斥，并行拉
      const [oilRes, goldRes] = await Promise.all([
        axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BZUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=XAUUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
      ]);
      const nasMeta = nasRes.data.chart.result[0].meta;
      const spMeta = spRes.data.chart.result[0].meta;
      const dxyMeta = dxyRes.data.chart.result[0].meta;
      const hsiMeta = hsiRes.data.chart.result[0].meta;
      const tnxMeta = tnxRes.data.chart.result[0].meta;
      const cnyMeta = cnyRes.data.chart.result[0].meta;
      const soxMeta = soxRes.data.chart.result[0].meta;
      const pc = m => m.previousClose || m.chartPreviousClose;
      nasdaq = { price: nasMeta.regularMarketPrice, changePercent: (nasMeta.regularMarketPrice / pc(nasMeta) - 1) * 100 };
      sp500 = { price: spMeta.regularMarketPrice, changePercent: (spMeta.regularMarketPrice / pc(spMeta) - 1) * 100 };
      dxy = { price: dxyMeta.regularMarketPrice, changePercent: (dxyMeta.regularMarketPrice / pc(dxyMeta) - 1) * 100 };
      hsi = { price: hsiMeta.regularMarketPrice, changePercent: (hsiMeta.regularMarketPrice / pc(hsiMeta) - 1) * 100 };
      tnx = { price: tnxMeta.regularMarketPrice, changePercent: (tnxMeta.regularMarketPrice / pc(tnxMeta) - 1) * 100 };
      cny = { price: cnyMeta.regularMarketPrice, changePercent: (cnyMeta.regularMarketPrice / pc(cnyMeta) - 1) * 100 };
      sox = { price: soxMeta.regularMarketPrice, changePercent: (soxMeta.regularMarketPrice / pc(soxMeta) - 1) * 100 };
      // 石油 + 黄金 → 币安永续合约 BZUSDT / XAUUSDT
      const oilData = oilRes.data;
      oil = { price: parseFloat(oilData.lastPrice), changePercent: parseFloat(oilData.priceChangePercent) };
      const goldData = goldRes.data;
      gold = { price: parseFloat(goldData.lastPrice), changePercent: parseFloat(goldData.priceChangePercent) };
    } catch(e) { console.error('[overview] Yahoo fetch error:', e.message, e.response?.status); }

    let btcPrice = null;
    if (majors.length > 0) {
      const btc = majors.find(t => t.symbol === 'BTCUSDT');
      if (btc) btcPrice = btc.price;
    }

    const result = { crypto: { changePercent: totalCryptoChg, btcPrice }, aShares, nasdaq, sp500, dxy, cny, hsi, tnx, sox, oil, gold };
    marketCache = { data: result, time: Date.now() };
    res.json(result);
  } catch (err) {
    if (marketCache.data) {
      marketCache.data._stale = true;
      return res.json(marketCache.data);
    }
    res.status(500).json({ error: err.message });
  }
});

// 恐惧贪婪 + 山寨季 + 多空比 + 爆仓 + VIX + DXY + CVD
router.get('/indicators', async (req, res) => {
  const result = { fear: null, altSeason: null, fngHistory: null, longShort: null, liquidation: null, vix: null, dxy: null, cvd: null, sentiment: null };

  // Warp 代理（币安 FAPI 在国内被墙）
  let warpAgent = null;
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    warpAgent = new SocksProxyAgent('socks5://127.0.0.1:40000');
  } catch(e) {}

  // ─── 并行拉取所有数据 ───
  const promises = [];

  // 1. 恐惧贪婪（CMC 主源，alternative.me 兜底）
  promises.push((async () => {
    try {
      const cmcKey = require('fs').readFileSync(require('path').join(__dirname, '..', 'secrets', 'cmc.key'), 'utf8').trim();
      const fng = await axios.get('https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest', {
        headers: { 'X-CMC_PRO_API_KEY': cmcKey }, timeout: 5000
      });
      const d = fng.data.data;
      result.fear = { value: d.value, label: d.value_classification, source: 'cmc' };
    } catch(e) {
      // 兜底：alternative.me
      try {
        const fng = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
        const fngData = fng.data.data[0];
        result.fear = { value: parseInt(fngData.value), label: fngData.value_classification, source: 'altme' };
      } catch(e2) {}
    }
    // 更新本地文件
    if (result.fear) {
      const fs = require('fs'); const path = require('path');
      try {
        const fngFile = path.join(__dirname, '..', 'public', 'data', 'analysis', 'fng_history.json');
        let fngAll = { history: [] };
        if (fs.existsSync(fngFile)) fngAll = JSON.parse(fs.readFileSync(fngFile, 'utf8'));
        const today = new Date().toISOString().slice(0, 10);
        const last = fngAll.history[fngAll.history.length - 1];
        if (!last || last.date !== today) {
          fngAll.history.push({ date: today, value: result.fear.value, label: result.fear.label });
          fs.writeFileSync(fngFile, JSON.stringify(fngAll, null, 2));
        }
        result.fngHistory = fngAll;
      } catch(e) {}
    }
  })());

  // 2. 山寨季
  promises.push((async () => {
    try {
      const altResp = await axios.get('https://api.blockchaincenter.net/api/v1/altcoin-season-index', { timeout: 8000 });
      if (altResp.data && altResp.data.altcoinSeasonIndex != null) {
        const score = altResp.data.altcoinSeasonIndex;
        result.altSeason = { value: score, label: score > 75 ? '山寨季' : score < 25 ? '比特季' : '中性' };
      }
    } catch(e) {
      try {
        const cg = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 5000 });
        const btcDom = cg.data.data.market_cap_percentage.btc;
        const score = Math.max(0, Math.min(100, Math.round((65 - btcDom) / 20 * 100)));
        result.altSeason = { value: score, btcDominance: btcDom, label: score >= 70 ? '山寨季' : score <= 30 ? '比特季' : '中性' };
      } catch(e2) {}
    }
  })());

  // 3. 多空比 (Binance FAPI, 走代理)
  promises.push((async () => {
    try {
      const opts = { params: { symbol: 'BTCUSDT', period: '5m', limit: 1 }, timeout: 8000 };
      if (warpAgent) opts.httpsAgent = warpAgent;
      const lsResp = await axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', opts);
      const d = lsResp.data[0];
      if (d) {
        const longPct = parseFloat(d.longAccount) * 100;
        result.longShort = {
          longPct: longPct,
          shortPct: 100 - longPct,
          ratio: longPct / (100 - longPct),
          label: longPct > 55 ? '偏多' : longPct < 45 ? '偏空' : '中性',
          timestamp: parseInt(d.timestamp)
        };
      }
    } catch(e) {}
  })());

  // 4. 爆仓数据 (Binance FAPI, 走代理)
  promises.push((async () => {
    try {
      const now = Date.now();
      const oneHourAgo = now - 3600000;
      const opts = {
        params: { symbol: 'BTCUSDT', limit: 100, startTime: oneHourAgo, endTime: now },
        timeout: 8000
      };
      if (warpAgent) opts.httpsAgent = warpAgent;
      const liqResp = await axios.get('https://fapi.binance.com/fapi/v1/allForceOrders', opts);
      const orders = liqResp.data || [];
      let longLiq = 0, shortLiq = 0, longCount = 0, shortCount = 0;
      for (const o of orders) {
        const qty = parseFloat(o.executedQty || o.origQty || 0);
        const price = parseFloat(o.avgPrice || o.price || 0);
        const val = qty * price;
        if (o.side === 'SELL') { longLiq += val; longCount++; }
        else { shortLiq += val; shortCount++; }
      }
      result.liquidation = {
        longLiq: Math.round(longLiq),
        shortLiq: Math.round(shortLiq),
        totalLiq: Math.round(longLiq + shortLiq),
        longCount, shortCount,
        label: (longLiq + shortLiq) > 5e6 ? '🔥 剧烈' : (longLiq + shortLiq) > 1e6 ? '⚠ 活跃' : '平静'
      };
    } catch(e) {}
  })());

  // 5. VIX 恐慌指数 (Yahoo Finance)
  promises.push((async () => {
    try {
      const vixResp = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000
      });
      const meta = vixResp.data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      result.vix = {
        value: parseFloat(price.toFixed(1)),
        change: parseFloat(((price / meta.previousClose - 1) * 100).toFixed(2)),
        label: price < 15 ? '😌 低波动' : price < 25 ? '😐 正常' : price < 35 ? '😰 恐慌' : '😱 极高'
      };
    } catch(e) {}
  })());

  // 6. DXY 美元指数 (Yahoo Finance)
  promises.push((async () => {
    try {
      const dxyResp = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 5000
      });
      const meta = dxyResp.data.chart.result[0].meta;
      const price = meta.regularMarketPrice;
      result.dxy = {
        value: parseFloat(price.toFixed(2)),
        change: parseFloat(((price / meta.previousClose - 1) * 100).toFixed(2)),
        label: price > 105 ? '💪 强美元' : price < 100 ? '📉 弱美元' : '中性'
      };
    } catch(e) {}
  })());

  // 7. CVD 累积成交量差（用本地 1h K 线中的 taker buy/sell）
  promises.push((async () => {
    try {
      const fs = require('fs'); const path = require('path');
      const klineDir = path.join(__dirname, '..', 'public', 'data', 'binance', 'perps', 'BTCUSDT', '1h');
      if (!fs.existsSync(klineDir)) return;
      const files = fs.readdirSync(klineDir).filter(f => f.endsWith('.json')).sort();
      if (files.length === 0) return;
      // 读取最新两个文件（今天 + 昨天），取最近 24 根 1h K 线
      let allCandles = [];
      for (let i = files.length - 1; i >= 0 && allCandles.length < 100; i--) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(klineDir, files[i]), 'utf8'));
          allCandles = allCandles.concat(data);
        } catch(e) {}
      }
      allCandles.sort((a, b) => a.time - b.time);
      // 取最近 24 根（24小时）
      const recent = allCandles.slice(-24);
      let cvd = 0;
      let totalBuy = 0, totalSell = 0;
      for (const c of recent) {
        const buyVol = c.takerBuyVol || 0;
        const totalVol = c.volume || 0;
        const sellVol = Math.max(0, totalVol - buyVol);
        cvd += buyVol - sellVol;
        totalBuy += buyVol;
        totalSell += sellVol;
      }
      const totalVol = totalBuy + totalSell;
      result.cvd = {
        value: Math.round(cvd * 100) / 100,
        netPct: totalVol > 0 ? Math.round(cvd / totalVol * 10000) / 100 : 0,
        period: recent.length + 'h',
        label: cvd > 500 ? '🟢 主动买' : cvd < -500 ? '🔴 主动卖' : '⚪ 均衡',
        candles: recent.length
      };
    } catch(e) {}
  })());

  // 8. 新闻情绪（基于自有新闻数据）
  promises.push((async () => {
    try {
      const db = require('../db');
      const ts = Math.floor(Date.now()/1000) - 86400;
      const rows = db.prepare('SELECT title FROM news_archive WHERE ts > ? ORDER BY ts DESC LIMIT 200').all(ts);
      const bullish = ['bull','bullish','surge','pump','moon','rally','breakout','buy','long','bottom','accumulate','green','rise','gain','新高','拉升','反弹','抄底','起飞','暴涨','利好','突破','创新高','大涨','看多','做多','净流入','增持','买入','涨超','飙升','猛涨'];
      const bearish = ['bear','bearish','dump','crash','sell','short','resistance','top','correction','red','drop','fear','暴跌','崩盘','大跌','做空','砸盘','回调','看空','利空','跌超','跌穿','跳水','闪崩','衰退','危机','违规','被黑','被盗','跑路'];
      const topics = {};
      let bullCount = 0, bearCount = 0, neutralCount = 0;
      for (const r of rows) {
        const title = (r.title || '').toLowerCase();
        let isBull = false, isBear = false;
        for (const w of bullish) { if (title.includes(w)) { isBull = true; break; } }
        for (const w of bearish) { if (title.includes(w)) { isBear = true; break; } }
        if (isBull && isBear) neutralCount++;
        else if (isBull) bullCount++;
        else if (isBear) bearCount++;
        else neutralCount++;
        const words = (r.title || '').match(/[\u4e00-\u9fff]{2,4}|[A-Z]{3,6}/g) || [];
        for (const w of words) {
          const skip = ['USDT','USDC','BTC','ETH','SOL','XRP','THE','AND','FOR','THAT','THIS','WITH','FROM','WILL','HAVE','BEEN','SAID','MORE','INTO','OVER','AFTER','WHEN','ALSO','JUST','SOME','WHAT','LIKE','THEY','YOUR','THEIR','WOULD','COULD','WHICH','THERE','OTHER'];
          if (!skip.includes(w)) topics[w] = (topics[w] || 0) + 1;
        }
      }
      const total = bullCount + bearCount + neutralCount;
      const score = total > 0 ? ((bullCount * 10 + neutralCount * 5) / total) : 0;
      result.sentiment = {
        score: Math.round(score * 100) / 100,
        label: score >= 6.5 ? '🟢 偏多' : score >= 4.5 ? '⚪ 中性' : '🔴 偏空',
        bullCount, bearCount, neutralCount, total,
        topTopics: Object.entries(topics).sort((a,b) => b[1]-a[1]).slice(0,8).map(([k]) => k)
      };
    } catch(e) {}
  })());

  await Promise.allSettled(promises);
  res.json(result);
});

function getLatestSnapshot() {
  try {
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'binance', 'latest_snapshot.json'), 'utf8'));
  } catch(e) { return null; }
}

module.exports = router;
