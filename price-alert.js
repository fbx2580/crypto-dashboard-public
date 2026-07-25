// ─── 行情异动监控 v4 ───
// 动态波动率基线 | 小/中/大三级 | 急跌/阴跌区分 | 盘口显示

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ALERT_FILE = path.join(__dirname, 'public', 'data', 'alerts', 'price_alerts.json');
const STATE_FILE = path.join(__dirname, 'data', 'price_state.json');
const BINANCE = 'https://fapi.binance.com';

// 波动率倍数阈值：1.5x/2.5x/4x → 小/中/大
const LEVELS = [1.5, 2.5, 4.0];
const LEVEL_NAMES = { 0: '小', 1: '中', 2: '大' };
const LEVEL_COLORS = { 0: '🟡', 1: '🟠', 2: '🔴' };

let state = { klines: {}, stats: {} };

function loadState() {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { state = { klines: {}, stats: {} }; }
}

function saveState() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function saveAlert(a) {
  try {
    const dir = path.dirname(ALERT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data = { alerts: [] };
    try { data = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); } catch(e) {}
    data.alerts.unshift(a);
    if (data.alerts.length > 30) data.alerts = data.alerts.slice(0, 30);
    fs.writeFileSync(ALERT_FILE, JSON.stringify(data, null, 2));
  } catch(e) {}
}

async function getKlines(symbol, interval = '1m', limit = 100) {
  try {
    const url = `${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 8000 });
    return (res.data || []).map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  } catch(e) { return []; }
}

async function getDepth(symbol, limit = 100) {
  try {
    const url = `${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`;
    const res = await axios.get(url, { timeout: 5000 });
    const bids = res.data.bids || [];
    const asks = res.data.asks || [];
    const bidVol = bids.reduce((s, b) => s + parseFloat(b[1]), 0);
    const askVol = asks.reduce((s, a) => s + parseFloat(a[1]), 0);
    
    // 流动性：前10档买卖总量（反应盘口厚度）
    const top10Bid = bids.slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
    const top10Ask = asks.slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
    const totalDepth = top10Bid + top10Ask;
    const liquidity = totalDepth > 200 ? '充足' : totalDepth > 50 ? '一般' : '偏薄';
    
    return { 
      bids: bidVol, asks: askVol, ratio: bidVol / (askVol || 1),
      top10Bid, top10Ask, totalDepth: parseFloat(totalDepth.toFixed(1)),
      liquidity,
    };
  } catch(e) { return null; }
}

// 计算波动率基线（基于过去1小时1分钟K线的价格变动标准差）
function calcBaseline(symbol, klines) {
  if (klines.length < 10) return { std: 0.1, avgMove: 0.05, basePrice: klines[klines.length - 1]?.close || 0 };

  // 计算每1分钟价格变动幅度（百分比）
  const moves = [];
  for (let i = 1; i < klines.length; i++) {
    const pct = Math.abs((klines[i].close - klines[i - 1].close) / klines[i - 1].close) * 100;
    moves.push(pct);
  }

  const avg = moves.reduce((s, m) => s + m, 0) / moves.length;
  const std = Math.sqrt(moves.reduce((s, m) => s + (m - avg) ** 2, 0) / moves.length);
  const basePrice = klines[klines.length - 1].close;

  return { std, avgMove: avg, basePrice, count: moves.length };
}

async function check() {
  loadState();
  const now = Date.now();
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOTUSDT'];

  for (const sym of symbols) {
    const name = sym.replace('USDT', '');
    const alerts = [];

    try {
      // 拉1分钟K线（过去100分钟≈1.5小时，足够算基线）
      const klines = await getKlines(sym, '1m', 100);
      if (klines.length < 5) continue;

      // 计算当前价格和基线
      const cur = klines[klines.length - 1];
      const prev = klines[klines.length - 2];
      const baseline = calcBaseline(sym, klines);

      // 1分钟变动
      const pct1m = ((cur.close - prev.close) / prev.close) * 100;
      // 5分钟变动
      const pct5m = klines.length >= 6
        ? ((cur.close - klines[klines.length - 6].close) / klines[klines.length - 6].close) * 100
        : pct1m;

      // 急跌系数：1分钟跌幅 / 5分钟跌幅（>0.7=急跌，<0.3=阴跌）
      const speedRatio = pct5m !== 0 ? Math.abs(pct1m / pct5m) : 1;
      const isFlash = pct1m < 0 && speedRatio > 0.7;          // 急跌
      const isDrift = pct1m < 0 && speedRatio < 0.3;           // 阴跌

      // 判断级别：看当前价格超出基线几个标准差
      const deviation = baseline.std > 0 ? Math.abs(pct1m) / baseline.std : 0;
      let level = -1;
      for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (deviation >= LEVELS[i]) { level = i; break; }
      }

      // 盘口
      const depth = await getDepth(sym);
      const depthBad = depth && depth.ratio < 0.6;

      // 成交量相对均值倍数
      const volAvg = klines.slice(0, -1).reduce((s, k) => s + k.volume, 0) / (klines.length - 1);
      const volRatio = volAvg > 0 ? cur.volume / volAvg : 0;
      const highVol = volRatio > 2;

      // 触发告警（不管涨跌，超过1.5x标准差就算事）
      if (level >= 0 && pct1m < 0) {
        const lvlName = LEVEL_NAMES[level];
        const lvlColor = LEVEL_COLORS[level];
        let extra = '';
        if (isFlash && highVol) extra = '⚡ 消息面急跌';
        else if (isDrift) extra = '🌊 持续下跌';
        else if (highVol) extra = '📊 放量下跌';
        if (depthBad) extra += ' 盘口失衡';

        saveAlert({
          type: 'drop_' + lvlName,
          symbol: sym, name, price: cur.close,
          pct1m: parseFloat(pct1m.toFixed(2)),
          pct5m: parseFloat(pct5m.toFixed(2)),
          level: lvlName, deviation: parseFloat(deviation.toFixed(1)),
          volRatio: parseFloat(volRatio.toFixed(1)),
          bidAskRatio: depth ? parseFloat(depth.ratio.toFixed(2)) : null,
          extra: extra.trim(),
          ts: Math.floor(now / 1000),
          msg: `${lvlColor} ${name} ${lvlName}跌 ${Math.abs(pct1m).toFixed(2)}% | 盘口 ${depth?.ratio.toFixed(2)||'?'} | ${extra || '正常波动'}`.trim(),
        });
        console.log(`  🚨 ${name} ${lvlName}跌! ${extra}`);
      }

      // 涨幅同理
      if (level >= 0 && pct1m > 0) {
        const lvlName = LEVEL_NAMES[level];
        const lvlColor = {0:'🟢',1:'🟢🟢',2:'🟢🟢🟢'}[level];
        let extra = '';
        if (isFlash && highVol) extra = '⚡ 消息面急涨';
        else if (highVol) extra = '📊 放量上涨';

        saveAlert({
          type: 'rise_' + lvlName,
          symbol: sym, name, price: cur.close,
          pct1m: parseFloat(pct1m.toFixed(2)),
          level: lvlName, deviation: parseFloat(deviation.toFixed(1)),
          volRatio: parseFloat(volRatio.toFixed(1)),
          ts: Math.floor(now / 1000),
          msg: `${lvlColor} ${name} ${lvlName}涨 ${pct1m.toFixed(2)}% | ${extra || '正常波动'}`.trim(),
        });
        console.log(`  📈 ${name} ${lvlName}涨! ${extra}`);
      }

      // 简略日志
      const dir = pct1m >= 0 ? '📈' : '📉';
      const volTag = volRatio > 2 ? ' 📊' : '';
      console.log(`[${name}] $${cur.close.toLocaleString('en')} ${dir} ${Math.abs(pct1m).toFixed(2)}% 基差:${deviation.toFixed(1)}x 盘口:${depth?.ratio.toFixed(2)||'?'}${volTag}`);

    } catch(e) {
      console.error(`[${sym}] error:`, e.message);
    }
  }

  saveState();
}

function getUnreadAlerts() {
  try {
    const data = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8'));
    const unread = data.alerts.filter(a => !a.read);
    for (const a of data.alerts) a.read = true;
    fs.writeFileSync(ALERT_FILE, JSON.stringify(data, null, 2));
    return unread;
  } catch(e) { return []; }
}

if (require.main === module) {
  console.log('[alert] 🚀 v4 — 动态基线 | 小/中/大三级 | 急跌/阴跌 | 盘口');
  check();
  setInterval(check, 60000);
}

module.exports = { check, getUnreadAlerts };
