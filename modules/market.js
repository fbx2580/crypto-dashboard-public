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

    let nasdaq = null, sp500 = null, oil = null, gold = null;
    try {
      const [nasRes, spRes, oilRes, goldRes] = await Promise.all([
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BZUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
        axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=XAUUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }),
      ]);
      const nasMeta = nasRes.data.chart.result[0].meta;
      const spMeta = spRes.data.chart.result[0].meta;
      nasdaq = { price: nasMeta.regularMarketPrice, changePercent: (nasMeta.regularMarketPrice / nasMeta.previousClose - 1) * 100 };
      sp500 = { price: spMeta.regularMarketPrice, changePercent: (spMeta.regularMarketPrice / spMeta.previousClose - 1) * 100 };
      // 石油 + 黄金 → 币安永续合约 BZUSDT / XAUUSDT
      const oilData = oilRes.data;
      oil = { price: parseFloat(oilData.lastPrice), changePercent: parseFloat(oilData.priceChangePercent) };
      const goldData = goldRes.data;
      gold = { price: parseFloat(goldData.lastPrice), changePercent: parseFloat(goldData.priceChangePercent) };
    } catch(e) {}

    let btcPrice = null;
    if (majors.length > 0) {
      const btc = majors.find(t => t.symbol === 'BTCUSDT');
      if (btc) btcPrice = btc.price;
    }

    const result = { crypto: { changePercent: totalCryptoChg, btcPrice }, aShares, nasdaq, sp500, oil, gold };
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
    // 始终从 API 拉最新恐惧贪婪，然后更新本地缓存
    const fng = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
    const fngData = fng.data.data[0];
    result.fear = { value: parseInt(fngData.value), label: fngData.value_classification };
    // 更新本地文件
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
  } catch(e) {}
  try {
    // 山寨季指数：用 Blockchaincenter 的官方算法（Top50中有多少跑赢BTC）
    const altResp = await axios.get('https://api.blockchaincenter.net/api/v1/altcoin-season-index', { timeout: 8000 });
    if (altResp.data && altResp.data.altcoinSeasonIndex != null) {
      const score = altResp.data.altcoinSeasonIndex;
      result.altSeason = { value: score, label: score > 75 ? '山寨季' : score < 25 ? '比特季' : '中性' };
    }
  } catch(e) {
    // 降级：用 CoinGecko BTC 占比粗略估算
    try {
      const cg = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 5000 });
      const btcDom = cg.data.data.market_cap_percentage.btc;
      const score = Math.max(0, Math.min(100, Math.round((65 - btcDom) / 20 * 100)));
      const label = score >= 70 ? '山寨季' : score <= 30 ? '比特季' : '中性';
      result.altSeason = { value: score, btcDominance: btcDom, label };
    } catch(e2) {}
  }
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
