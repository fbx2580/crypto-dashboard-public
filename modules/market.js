// ─── 大盘行情模块 ───
const express = require('express');
const axios = require('axios');
const router = express.Router();

let marketCache = { data: null, time: 0 };
// 用于计算资金流向：缓存最近5个数据点
let flowHistory = [];

// 大盘总览
router.get('/overview', async (req, res) => {
  if (marketCache.data && Date.now() - marketCache.time < 30000) {
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

    let nasdaq = null, sp500 = null, gold = null, oil = null;
    try {
      const [nasRes, spRes, goldRes, oilRes] = await Promise.all([
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
      ]);
      const nasMeta = nasRes.data.chart.result[0].meta;
      const spMeta = spRes.data.chart.result[0].meta;
      const goldMeta = goldRes.data.chart.result[0].meta;
      const oilMeta = oilRes.data.chart.result[0].meta;
      nasdaq = { price: nasMeta.regularMarketPrice, changePercent: (nasMeta.regularMarketPrice / nasMeta.previousClose - 1) * 100, volume: nasMeta.regularMarketVolume || 0 };
      sp500 = { price: spMeta.regularMarketPrice, changePercent: (spMeta.regularMarketPrice / spMeta.previousClose - 1) * 100, volume: spMeta.regularMarketVolume || 0 };
      gold = { price: goldMeta.regularMarketPrice, changePercent: (goldMeta.regularMarketPrice / goldMeta.previousClose - 1) * 100, volume: goldMeta.regularMarketVolume || 0 };
      oil = { price: oilMeta.regularMarketPrice, changePercent: (oilMeta.regularMarketPrice / oilMeta.previousClose - 1) * 100, volume: oilMeta.regularMarketVolume || 0 };
    } catch(e) {}

    let btcPrice = null;
    if (majors.length > 0) {
      const btc = majors.find(t => t.symbol === 'BTCUSDT');
      if (btc) btcPrice = btc.price;
    }

    // 计算资金流向（基于成交量和价格变化）
    const flow = computeFlow({ cryptoChg: totalCryptoChg, cryptoVol, nasdaq, sp500, gold, oil });

    const result = { crypto: { changePercent: totalCryptoChg, btcPrice }, aShares, nasdaq, sp500, gold, oil, flow };
    marketCache = { data: result, time: Date.now() };

    // 缓存流量历史
    flowHistory.push({
      time: Date.now(),
      btcPrice: btcPrice || 0, cryptoChg: totalCryptoChg,
      nasdaqPrice: nasdaq?.price || 0, sp500Price: sp500?.price || 0,
      goldPrice: gold?.price || 0, oilPrice: oil?.price || 0,
      nasdaqVol: nasdaq?.volume || 0, sp500Vol: sp500?.volume || 0,
      goldVol: gold?.volume || 0, oilVol: oil?.volume || 0,
    });
    if (flowHistory.length > 10) flowHistory = flowHistory.slice(-10);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 计算各市场资金流向信号
function computeFlow(data) {
  const now = Date.now();
  const result = {};
  const markets = [
    { key: 'btc', label: 'BTC', price: data.btcPrice, chg: data.cryptoChg, vol: data.cryptoVol },
    { key: 'nasdaq', label: '纳斯达克', price: data.nasdaq?.price, chg: data.nasdaq?.changePercent, vol: data.nasdaq?.volume },
    { key: 'sp500', label: '标普500', price: data.sp500?.price, chg: data.sp500?.changePercent, vol: data.sp500?.volume },
    { key: 'gold', label: '黄金', price: data.gold?.price, chg: data.gold?.changePercent, vol: data.gold?.volume },
    { key: 'oil', label: '原油', price: data.oil?.price, chg: data.oil?.changePercent, vol: data.oil?.volume },
  ];

  for (const m of markets) {
    if (m.price == null) { result[m.key] = { signal: 'nodata' }; continue; }

    // 找历史对比（30分钟前）
    const past = flowHistory.filter(h => h.time < now - 1800000);
    let signal = 'neutral';
    let strength = 0;

    if (past.length > 0) {
      const avgPast = past[0];

      // 价格变化方向
      let priceDir = 0;
      if (m.key === 'btc' || m.key === 'crypto') {
        priceDir = m.chg || 0;
      } else {
        const pastPrice = m.key === 'nasdaq' ? avgPast.nasdaqPrice :
                          m.key === 'sp500' ? avgPast.sp500Price :
                          m.key === 'gold' ? avgPast.goldPrice :
                          m.key === 'oil' ? avgPast.oilPrice : 0;
        priceDir = pastPrice > 0 ? ((m.price - pastPrice) / pastPrice * 100) : 0;
      }

      // 成交量变化方向
      const pastVol = m.key === 'btc' ? avgPast.cryptoChg : // btc uses crypto vol
                      m.key === 'nasdaq' ? avgPast.nasdaqVol :
                      m.key === 'sp500' ? avgPast.sp500Vol :
                      m.key === 'gold' ? avgPast.goldVol :
                      m.key === 'oil' ? avgPast.oilVol : 0;
      const volDir = pastVol > 0 ? (m.vol / pastVol - 1) : 0;

      // 综合判断：价格方向 + 量方向
      if (priceDir > 0.3 && volDir > 0.2) {
        signal = 'inflow'; strength = Math.min(3, Math.round(priceDir * 3 + volDir * 2));
      } else if (priceDir > 0.1 && signal !== 'inflow') {
        signal = 'weak_in';
      } else if (priceDir < -0.3 && volDir > 0.2) {
        signal = 'outflow'; strength = Math.min(3, Math.round(Math.abs(priceDir) * 2 + volDir * 2));
      } else if (priceDir < -0.1 && signal !== 'outflow') {
        signal = 'weak_out';
      } else {
        signal = 'neutral';
      }
    } else {
      // 首次加载无历史：仅看24h涨跌
      if ((m.chg || 0) > 1) signal = 'weak_in';
      else if ((m.chg || 0) < -1) signal = 'weak_out';
      else signal = 'neutral';
    }

    result[m.key] = { signal, strength, priceChg: m.chg || 0 };
  }

  return result;
}

// 恐惧贪婪 + 山寨季
router.get('/indicators', async (req, res) => {
  const result = { fear: null, altSeason: null, fngHistory: null };
  try {
    const fs = require('fs');
    const path = require('path');
    const fngFile = path.join(__dirname, '..', 'public', 'data', 'analysis', 'fng_history.json');
    if (fs.existsSync(fngFile)) {
      const fngAll = JSON.parse(fs.readFileSync(fngFile, 'utf8'));
      const latest = fngAll.history[fngAll.history.length - 1];
      result.fear = { value: latest.value, label: latest.label };
      result.fngHistory = fngAll;
    } else {
      const fng = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
      const fngData = fng.data.data[0];
      result.fear = { value: parseInt(fngData.value), label: fngData.value_classification };
    }
  } catch(e) {}
  try {
    const cg = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 5000 });
    const btcDom = cg.data.data.market_cap_percentage.btc;
    const score = Math.max(0, Math.min(100, Math.round((1 - (btcDom - 30) / 50) * 100)));
    result.altSeason = { value: score, btcDominance: btcDom };
  } catch(e) {}
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
