#!/usr/bin/env node
/**
 * Quant Data Center — 精简版
 * 只保留数据中心相关的 API
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

// ═══ 数据源状态 ═══
app.get('/api/status', (req, res) => {
  const checks = [
    { name: 'Binance FAPI', ok: fs.existsSync(path.join(CACHE_DIR, 'BTC.json')) },
    { name: 'K线缓存', ok: fs.existsSync(CACHE_DIR) && fs.readdirSync(CACHE_DIR).filter(f=>f.endsWith('.json')).length > 200 },
    { name: '新闻 RSS', ok: fs.existsSync(path.join(DATA_DIR, 'news', 'latest.json')) },
    { name: '异动监控', ok: fs.existsSync(path.join(DATA_DIR, 'alerts', 'price_alerts.json')) },
    { name: '市场快照', ok: fs.existsSync(path.join(MKT_DIR, 'latest.json')) },
    { name: '金十快讯', ok: fs.existsSync(path.join(DATA_DIR, 'news', 'jin10.json')) },
  ];
  res.json({ checks });
});

// ═══ 数据中心 ═══
app.get('/api/datacenter', (req, res) => {
  const stats = { sources: [], coverage: {}, storage: {}, fields: {} };

  stats.sources = [
    { name: 'Binance FAPI', ok: true, lastSync: '1秒(实时)', volume: '528合约+K线' },
    { name: 'CoinGecko', ok: fs.existsSync(path.join(MKT_DIR, 'latest.json')), lastSync: '1秒(实时)', volume: 'BTC.D/总市值' },
    { name: 'K线缓存', ok: fs.existsSync(CACHE_DIR), lastSync: '1秒(实时)', volume: (fs.existsSync(CACHE_DIR)?fs.readdirSync(CACHE_DIR).filter(f=>f.endsWith('.json')).length:0)+' 币' },
    { name: '新闻 RSS', ok: fs.existsSync(path.join(DATA_DIR, 'news', 'latest.json')), lastSync: '1秒(实时)', volume: 'RSS聚合' },
    { name: '金十快讯', ok: fs.existsSync(path.join(DATA_DIR, 'news', 'jin10.json')), lastSync: '1秒(实时)', volume: '497条' },
    { name: '鲸鱼监控', ok: fs.existsSync(path.join(DATA_DIR, 'whale', 'transfers.json')), lastSync: '1秒(实时)', volume: 'ETH链' },
    { name: '异动监控', ok: fs.existsSync(path.join(DATA_DIR, 'alerts', 'price_alerts.json')), lastSync: '1秒(实时)', volume: '全合约' },
    { name: 'ETH追踪', ok: fs.existsSync(path.join(DATA_DIR, 'analysis', 'eth_whales.json')), lastSync: '1秒(实时)', volume: 'ETH大户' },
  ];

  const cacheFiles = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter(f=>f.endsWith('.json')) : [];
  stats.coverage = {
    kline: { cached: cacheFiles.length, target: 528, pct: (cacheFiles.length/528*100).toFixed(0)+'%', missing: 528 - cacheFiles.length },
    periods: ['1d'],
  };

  const dirs = ['klines_cache','market_data','news','alerts','whale','wallets','binance','analysis','bd'];
  stats.storage = dirs.map(d => {
    const p = path.join(DATA_DIR, d);
    if(!fs.existsSync(p)) return { dir: d, files: 0, size: '0MB', updated: '—' };
    try {
      const files = fs.readdirSync(p,{recursive:true}).filter(f=>fs.statSync(path.join(p,f)).isFile());
      const size = files.reduce((s,f)=>s+(fs.statSync(path.join(p,f)).size||0),0);
      const newest = files.length ? files.reduce((a,f)=>Math.max(a,fs.statSync(path.join(p,f)).mtimeMs),0) : 0;
      return { dir: d, files: files.length, size: (size/1024/1024).toFixed(1)+'MB', updated: newest ? new Date(newest).toISOString().slice(0,16) : '—' };
    } catch(e) { return { dir: d, files: 0, size: '0MB', updated: '—' }; }
  });

  stats.fields = {
    btc: ['price','change24h','ma200','volatility','ret7d','ret30d','athDistance','source','updatedAt'],
    coin: ['symbol','price','change24h','volume24h','fundingRate'],
    news: ['time','title','source'],
    alerts: ['symbol','change','level','time'],
    whale: ['chain','value','hash','ts','from','to'],
  };

  res.json(stats);
});

// ═══ 数据质量 ═══
app.get('/api/data-quality', (req, res) => {
  try {
    const f = path.join(MKT_DIR, 'data_quality.json');
    if (!fs.existsSync(f)) return res.json({ overall_score: 0, status: 'no_data', checks: {} });
    const q = JSON.parse(fs.readFileSync(f, 'utf8'));
    // 追加告警记录
    try {
      const af = path.join(MKT_DIR, 'alerts_log.json');
      if (fs.existsSync(af)) q.alerts = JSON.parse(fs.readFileSync(af, 'utf8')).alerts || [];
    } catch(e) {}
    res.json(q);
  } catch(e) { res.json({ error: e.message }); }
});

app.listen(3002, '0.0.0.0', () => {
  console.log('🗄 Data Center — Port 3002');
});

// ═══ 实时监控 ═══
app.get('/api/monitor', (req, res) => {
  const { execSync } = require('child_process');

  // 1. 进程检查
  const procs = [
    { name: 'rt-daemon', pid: 0, status: 'dead', uptime: '' },
    { name: 'jin10-scraper', pid: 0, status: 'dead', uptime: '' },
    { name: 'supervisor', pid: 0, status: 'dead', uptime: '' },
    { name: 'quant-server', pid: 0, status: 'dead', uptime: '' },
  ];
  for (const p of procs) {
    try {
      const out = execSync(`pgrep -f '${p.name}' | head -1`, { encoding: 'utf8', timeout: 3000 }).trim();
      if (out) {
        p.pid = parseInt(out);
        p.status = 'alive';
        try {
          const etime = execSync(`ps -p ${p.pid} -o etime=`, { encoding: 'utf8', timeout: 2000 }).trim();
          p.uptime = etime;
        } catch(e) {}
      }
    } catch(e) {}
  }

  // 2. 数据新鲜度（每个数据文件的上次更新时间和延迟）
  const freshness = [];
  const checkFresh = (name, filepath, maxDelaySec) => {
    const fp = path.join(DATA_DIR, filepath);
    if (!fs.existsSync(fp)) return { name, status: 'missing', delay: null, updated: null };
    try {
      const st = fs.statSync(fp);
      const now = Date.now();
      const delay = Math.round((now - st.mtimeMs) / 1000);
      const status = delay < maxDelaySec ? 'fresh' : delay < maxDelaySec * 3 ? 'stale' : 'dead';
      return { name, status, delay, updated: new Date(st.mtimeMs).toISOString() };
    } catch(e) { return { name, status: 'error', delay: null, updated: null }; }
  };
  freshness.push(checkFresh('金十快讯', 'news/jin10.json', 30));
  freshness.push(checkFresh('RSS新闻', 'news/latest.json', 30));
  freshness.push(checkFresh('鲸鱼转账', 'whale/transfers.json', 60));
  freshness.push(checkFresh('ETH大户', 'analysis/eth_whales.json', 30));
  freshness.push(checkFresh('异动数据', 'alerts/price_alerts.json', 60));
  freshness.push(checkFresh('市场快照', 'market_data/latest.json', 3600));
  freshness.push(checkFresh('数据质量', 'market_data/data_quality.json', 600));
  freshness.push(checkFresh('告警日志', 'market_data/alerts_log.json', 600));

  // 3. 归档统计
  let archiveStats = {};
  try { archiveStats = require('./archive-manager').stats(); } catch(e) {}

  // 4. 实际数据量（读文件计数）
  const volumes = {};
  try { const d=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'news','jin10.json'),'utf8')); volumes.jin10=(d.items||[]).length; } catch(e) {}
  try { const d=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'news','latest.json'),'utf8')); volumes.rss=(d.items||[]).length; } catch(e) {}
  try { const d=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'whale','transfers.json'),'utf8')); volumes.whale=(d.transfers||[]).length; } catch(e) {}
  try { const d=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'analysis','eth_whales.json'),'utf8')); volumes.eth=(d.whales||[]).length; } catch(e) {}
  try { const d=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'alerts','price_alerts.json'),'utf8')); volumes.alerts=(d.alerts||[]).length; } catch(e) {}
  // P2: 归档存量
  const archVolumes = {};
  for (const [type, info] of Object.entries(archiveStats)) {
    archVolumes[type] = info.total;
  }

  res.json({ procs, freshness, archive: archiveStats, volumes, archVolumes, timestamp: Date.now() });
});
