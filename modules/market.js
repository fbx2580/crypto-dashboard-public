// ─── 大盘行情模块 ───
const express = require('express');
const axios = require('axios');
const router = express.Router();

let marketCache = { data: null, time: 0 };

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

    let nasdaq = null, sp500 = null;
    try {
      const [nasRes, spRes] = await Promise.all([
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
      ]);
      const nasMeta = nasRes.data.chart.result[0].meta;
      const spMeta = spRes.data.chart.result[0].meta;
      nasdaq = { price: nasMeta.regularMarketPrice, changePercent: (nasMeta.regularMarketPrice / nasMeta.previousClose - 1) * 100 };
      sp500 = { price: spMeta.regularMarketPrice, changePercent: (spMeta.regularMarketPrice / spMeta.previousClose - 1) * 100 };
    } catch(e) {}

    let btcPrice = null;
    if (majors.length > 0) {
      const btc = majors.find(t => t.symbol === 'BTCUSDT');
      if (btc) btcPrice = btc.price;
    }

    const result = { crypto: { changePercent: totalCryptoChg, btcPrice }, aShares, nasdaq, sp500 };
    marketCache = { data: result, time: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
