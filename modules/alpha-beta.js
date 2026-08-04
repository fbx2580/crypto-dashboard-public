const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const KLINES_DIR = path.join(__dirname, '..', 'public', 'data', 'klines_cache');
const MAJORS = ['ETH','BNB','XRP','SOL','DOGE','ADA','AVAX','LINK','DOT',
  'TRX','LTC','BCH','XLM','HBAR','SHIB','NEAR','ATOM','UNI',
  'FIL','APT','SUI','INJ','OP','ARB','TIA','ETC'];

function loadCloses(filepath, days) {
  if (!fs.existsSync(filepath)) return null;
  const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  const klines = data.klines || [];
  return klines.slice(-days).map(k => parseFloat(k.close));
}

function dailyReturns(closes) {
  return closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
}

function calcAlphaBeta(coinReturns, btcReturns) {
  const n = btcReturns.length;
  const meanB = btcReturns.reduce((a, b) => a + b, 0) / n;
  const meanC = coinReturns.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (btcReturns[i] - meanB) * (coinReturns[i] - meanC);
    varB += (btcReturns[i] - meanB) ** 2;
  }
  cov /= (n - 1); varB /= (n - 1);
  const beta = varB ? cov / varB : 0;
  const alpha = meanC - beta * meanB;
  return { alpha, beta };
}

router.get('/', (req, res) => {
  try {
    const btcPath = path.join(KLINES_DIR, 'BTC.json');
    const btcCloses30 = loadCloses(btcPath, 30);
    const btcCloses7 = loadCloses(btcPath, 7);
    if (!btcCloses30) return res.json({ error: 'no btc data' });

    const btcR30 = dailyReturns(btcCloses30);
    const btcR7 = dailyReturns(btcCloses7);
    const btcChg24 = (btcCloses30[btcCloses30.length - 1] - btcCloses30[btcCloses30.length - 2]) / btcCloses30[btcCloses30.length - 2];

    const results = [];
    for (const sym of MAJORS) {
      const fp = path.join(KLINES_DIR, `${sym}.json`);
      const closes30 = loadCloses(fp, 30);
      if (!closes30 || closes30.length < 10) continue;
      const chg24 = (closes30[closes30.length - 1] - closes30[closes30.length - 2]) / closes30[closes30.length - 2];
      const rel24 = (chg24 - btcChg24) * 100;
      
      const rets30 = dailyReturns(closes30);
      const { alpha: a30, beta: b30 } = calcAlphaBeta(rets30, btcR30);
      
      const closes7 = closes30.slice(-7);
      const rets7 = dailyReturns(closes7);
      const { alpha: a7, beta: b7 } = calcAlphaBeta(rets7, btcR7);

      let signal = '';
      if (a30 < -0.003) signal = '🟠 独立走弱';
      else if (a30 < -0.0005) signal = '🟡 略弱';
      else if (a30 < 0.0005) signal = '⚪ 跟随BTC';
      else if (a30 < 0.003) signal = '🟡 略强';
      else signal = '🟢 独立走强';
      // 近期弱但7天在转强 = 补涨信号
      if (a30 < -0.001 && a7 > a30 * 3) signal += ' 💡补涨';
      if (a30 > 0.002 && a7 < a30 * 0.3) signal += ' ⚠️滞涨';

      results.push({
        symbol: sym,
        chg24: +(chg24 * 100).toFixed(1),
        rel24: +rel24.toFixed(1),
        alpha30: +(a30 * 100).toFixed(2),
        beta30: +b30.toFixed(2),
        alpha7: +(a7 * 100).toFixed(2),
        signal
      });
    }

    results.sort((a, b) => a.alpha30 - b.alpha30);
    res.json({ updated: Date.now(), results });
  } catch(e) {
    res.json({ error: e.message });
  }
});

module.exports = router;
