// ─── Crypto Dashboard v2 ─── 模块化重构版
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = 3001;
const DATA_DIR = path.join(__dirname, 'public', 'data');
const db = require('./db');

// ─── 中间件 ───
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ═══ 模块路由 ═══
app.use('/api/market', require('./modules/market'));
app.use('/api/binance', require('./modules/binance'));
app.use('/api/news', require('./modules/news'));
app.use('/api/wallets', require('./modules/wallet'));
app.use('/api/bd', require('./modules/bd'));
app.use('/api/config', require('./modules/config'));
app.use('/api/defi', require('./modules/defi'));


// ═══ 旧接口兼容（直接映射到模块路由） ═══
app.get('/api/whale/transfers', (req, res) => {
  // 主存储：SQLite（whale-monitor 实时写入）
  const chain = req.query.chain;
  try {
    let rows;
    if (chain) rows = db.prepare('SELECT * FROM whale_transfers WHERE chain = ? ORDER BY ts DESC ').all(chain.toUpperCase());
    else rows = db.prepare('SELECT * FROM whale_transfers ORDER BY ts DESC ').all();
    if (rows.length > 0) {
      return res.json({ updated: Date.now(), transfers: rows.map(r => ({
        c: r.chain, val: r.value, hash: r.hash, ts: r.ts,
        from: r.from_addr, to: r.to_addr,
        exFrom: r.ex_from, exTo: r.ex_to
      })) });
    }
  } catch(e) {}
  // 降级：读 JSON 文件
  const whaleFile = path.join(DATA_DIR, 'whale', 'transfers.json');
  try {
    if (fs.existsSync(whaleFile)) return res.json(JSON.parse(fs.readFileSync(whaleFile, 'utf8')));
  } catch(e) {}
  res.json({ updated: Date.now(), transfers: [] });
});

app.get('/api/whale/addresses', (req, res) => {
  try {
    const af = path.join(DATA_DIR, 'analysis', 'addr_analysis.json');
    if (fs.existsSync(af)) return res.json(JSON.parse(fs.readFileSync(af, 'utf8')));
    const rows = db.prepare('SELECT * FROM addresses ORDER BY balance DESC LIMIT 50').all();
    const btc = rows.filter(r => r.chain === 'BTC');
    const eth = rows.filter(r => r.chain === 'ETH');
    res.json({ updated: Date.now(), btc, eth });
  } catch(e) { res.json({ updated: Date.now(), btc: [], eth: [] }); }
});

app.get('/api/whale/address/:chain/:address', (req, res) => {
  const { address } = req.params;
  try {
    const info = db.prepare('SELECT * FROM addresses WHERE address = ?').get(address);
    const txs = db.prepare('SELECT * FROM addr_tx_history WHERE address = ? ORDER BY ts DESC LIMIT 100').all(address);
    res.json({ address, info, txs });
  } catch(e) { res.json({ address, txs: [] }); }
});

app.get('/api/symbols', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'binance', 'symbols.json'), 'utf8'))); } catch(e) { res.json([]); }
});
app.get('/api/symbols/all', (req, res) => { res.redirect('/api/symbols'); });
app.get('/api/latest', (req, res) => { res.json({ timestamp: Date.now() }); });

// DexScreener 信号检测（保留旧逻辑，暂不封装）
app.get('/api/fetch', async (req, res) => { res.json({ timestamp: Date.now(), results: [] }); });
app.get('/api/data/:chain/:address', (req, res) => {
  const { chain, address } = req.params;
  const dir = path.join(DATA_DIR, chain, address);
  const snapshots = [];
  try {
    if (fs.existsSync(dir)) {
      for (const date of fs.readdirSync(dir).sort()) {
        const dd = path.join(dir, date);
        if (fs.statSync(dd).isDirectory()) {
          for (const f of fs.readdirSync(dd).sort()) {
            if (f.endsWith('.json')) snapshots.push(JSON.parse(fs.readFileSync(path.join(dd, f), 'utf8')));
          }
        }
      }
    }
  } catch(e) {}
  res.json({ chain, address, snapshots });
});
app.get('/api/signals/:chain/:address', (req, res) => {
  res.json({ chain: req.params.chain, address: req.params.address, signals: [] });
});
app.get('/api/binance/fetch', async (req, res) => { res.json({ success: true }); });
app.get('/api/smart-pool', (req, res) => { res.json({ pools: [] }); });
app.get('/api/smart-alerts', (req, res) => { res.json({ alerts: [] }); });

// 币种分析 API（供大看板使用）
app.get('/api/market/coin-analysis', async (req, res) => {
  try {
    const axios = require('axios');
    const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOTUSDT'];
    const axios2 = require('axios');
    const results = [];
    for (const sym of symbols) {
      try {
        const ticker = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=' + sym, {timeout:5000});
        const price = parseFloat(ticker.data.lastPrice);
        const depthRes = await axios.get('https://fapi.binance.com/fapi/v1/depth?symbol=' + sym + '&limit=10', {timeout:3000});
        const bids = (depthRes.data.bids||[]).reduce((s,b) => s + parseFloat(b[1]), 0);
        const asks = (depthRes.data.asks||[]).reduce((s,a) => s + parseFloat(a[1]), 0);
        const depthRatio = asks > 0 ? (bids / asks).toFixed(2) : 1;
        const change24h = parseFloat(ticker.data.priceChangePercent);
        
        let level = '平稳', color = '➖', cl='yellow';
        if (change24h < -3) { level = '大跌'; color = '🔴'; cl='red'; }
        else if (change24h < -1.5) { level = '下跌'; color = '🔻'; cl='orange'; }
        else if (change24h > 3) { level = '大涨'; color = '🟢🟢'; cl='green'; }
        else if (change24h > 1.5) { level = '上涨'; color = '🟢'; cl='lime'; }
        
        results.push({ symbol: sym.replace('USDT',''), price, change24h, level, color, cl, depthRatio: parseFloat(depthRatio) });
      } catch(e) {}
    }
    res.json({ coins: results, updated: Date.now() });
  } catch(e) { res.json({ coins: [] }); }
});

// ═══ 错误处理 ═══
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.url, err.message);
  res.status(500).json({ error: err.message });
});

// ═══ 山寨币吸筹雷达 ═══
app.get('/api/accumulation/radar', (req, res) => {
  const file = path.join(DATA_DIR, 'analysis', 'accumulation_radar.json');
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    res.json({ scannedAt: null, totalAnalyzed: 0, results: [] });
  } catch(e) { res.json({ scannedAt: null, results: [] }); }
});

// ═══ 山寨币吸筹扫描 ═══
app.get('/api/accumulation/scan', (req, res) => {
  const file = path.join(DATA_DIR, 'analysis', 'accumulation_signals.json');
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    res.json({ scannedAt: null, totalScanned: 0, signalsFound: 0, signals: [] });
  } catch(e) { res.json({ scannedAt: null, totalScanned: 0, signalsFound: 0, signals: [] }); }
});

// ═══ 健康检查 ═══
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: 'v2',
    uptime: process.uptime(), memory: process.memoryUsage().rss,
    dbFile: fs.existsSync(path.join(__dirname, 'data', 'dashboard.db')),
  });
});

// 聪明钱地址分析 API
app.get('/api/whale/smart-money', (req, res) => {
  // ETH大户分类数据（从Alchemy扫描结果）
  const whaleFile = path.join(DATA_DIR, 'analysis', 'eth_whales.json');
  try {
    if (fs.existsSync(whaleFile)) {
      const data = JSON.parse(fs.readFileSync(whaleFile, 'utf8'));
          const whales = data.whales || [];
    const dayAgo = Date.now() - 86400000;
    const new24h = whales.filter(w => w.addedAt && w.addedAt > dayAgo).length;
    return res.json({ updated: Date.now(), whales, new24h });
    }
  } catch(e) {}
  res.json({ updated: Date.now(), whales: [] });
});

// 行情异动告警 API
app.get('/api/alerts/price', (req, res) => {
  const file = path.join(DATA_DIR, 'alerts', 'price_alerts.json');
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch(e) {}
  res.json({ alerts: [] });
});

// ═══ 优雅关闭 ═══
function graceful(signal) {
  console.log(`\n[server] ${signal} 收到，关闭中...`);
  server.close(() => { console.log('[server] 已关闭'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => graceful('SIGTERM'));
process.on('SIGINT', () => graceful('SIGINT'));

// ═══ 启动后门AI ═══
const bdWorker = require('child_process').fork(path.join(__dirname, 'bd-worker.js'), [], {
  stdio: 'pipe', env: { ...process.env }
});
bdWorker.stdout.on('data', d => process.stdout.write('[bd-worker] ' + d));
bdWorker.stderr.on('data', d => process.stderr.write('[bd-worker] ' + d));
bdWorker.on('exit', (code) => {
  console.log(`⚠️ bd-worker exited with code ${code}, restarting in 5s...`);
  setTimeout(() => {
    require('child_process').fork(path.join(__dirname, 'bd-worker.js'), [], { stdio: 'pipe', env: { ...process.env } })
      .stdout.on('data', d => process.stdout.write('[bd-worker] ' + d));
  }, 5000);
});

// ═══ 启动 ═══
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Crypto Dashboard v2 — Port ${PORT}`);
  console.log(`   Modules: market, binance, news, wallets, bd, config, defi, whale`);
});
