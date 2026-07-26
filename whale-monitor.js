const fs = require('fs');
const path = require('path');
const axios = require('axios');
const apiMon = require('./api-monitor');
try { apiMon.wrapAxios(axios); } catch(e){}

const DATA_DIR = path.join(__dirname, 'public', 'data', 'whale');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CACHE_FILE = path.join(DATA_DIR, 'transfers.json');

let ETHERSCAN_KEY = '';
try { ETHERSCAN_KEY = fs.readFileSync(path.join(__dirname, 'secrets', 'etherscan.key'), 'utf8').trim().split('\n').filter(l => !l.startsWith('#') && l.trim())[0] || ''; } catch(e) {}

const EX = { '3ddf':'币安', '28c6':'币安', '1db2':'币安', 'f977':'Coinbase', '6a2d':'OKX', '5a52':'Bitfinex', '7a16':'Kraken', 'db0a':'Upbit' };
function getEx(addr) {
  if (!addr) return null;
  const pre = addr.toLowerCase().slice(2, 6);
  return EX[pre] || null;
}

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

// ─── USDT/USDC 转账（Etherscan V2 tokentx）───
async function fetchTokenTxs(contract, decimals, minVal, chain) {
  const txs = [];
  if (!ETHERSCAN_KEY) return txs;
  try {
    const url = ETHERSCAN_V2 + '?chainid=1&module=account&action=tokentx&contractaddress=' + contract + '&sort=desc&apikey=' + ETHERSCAN_KEY;
    const r = await axios.get(url, {timeout:10000});
    if (r.data && r.data.status === '1' && r.data.result) {
      for (const tx of r.data.result) {
        const val = parseFloat(tx.value) / Math.pow(10, decimals);
        if (val > minVal) {
          txs.push({c:chain, val:parseFloat(val.toFixed(2)), hash:tx.hash, ts:parseInt(tx.timeStamp)||Math.floor(Date.now()/1000), from:tx.from, to:tx.to, exFrom:getEx(tx.from), exTo:getEx(tx.to)});
        }
      }
    }
  } catch(e) {}
  return txs;
}

// ─── 原生 ETH 大额转账（Etherscan V2 proxy eth_getBlockByNumber）───
async function scanEthBlock() {
  if (!ETHERSCAN_KEY) return [];
  const txs = [];
  try {
    const r = await axios.get(ETHERSCAN_V2 + '?chainid=1&module=proxy&action=eth_getBlockByNumber&tag=latest&boolean=true&apikey=' + ETHERSCAN_KEY, {timeout:8000});
    if (!r.data || !r.data.result) return txs;
    const block = r.data.result;
    let ts = parseInt(block.timestamp, 16);
    if (!ts || isNaN(ts)) ts = Math.floor(Date.now()/1000);
    for (const t of (block.transactions || [])) {
      const val = parseInt(t.value, 16) / 1e18;
      if (val > 800 && t.from && t.to) {
        txs.push({c:'ETH', val:parseFloat(val.toFixed(0)), hash:t.hash, ts, from:t.from, to:t.to, exFrom:getEx(t.from), exTo:getEx(t.to)});
      }
    }
  } catch(e) { console.error('[whale] ETH区块扫描失败:', e.message?.slice(0,60)||e); }
  return txs;
}

// ─── BTC 最新区块大额转账（mempool.space，用块哈希查） ───
async function scanBtcBlock() {
  const txs = [];
  try {
    const h = await axios.get('https://mempool.space/api/blocks/tip/height', {timeout:5000});
    const blk = await axios.get('https://mempool.space/api/block-height/' + parseInt(h.data), {timeout:8000});
    const hash = blk.data.trim();
    const txRes = await axios.get('https://mempool.space/api/block/' + hash + '/txs', {timeout:10000});
    const blockTxs = txRes.data || [];
    
    for (const tx of blockTxs.slice(0, 100)) {
      let val = 0;
      for (const vout of (tx.vout || [])) val += (vout.value || 0);
      val = val / 1e8;
      if (val <= 25) continue;
      
      const from = tx.vin?.[0]?.prevout?.scriptpubkey_address || 'unknown';
      const to = tx.vout?.[0]?.scriptpubkey_address || 'unknown';
      const ts = tx.status?.block_time || Math.floor(Date.now()/1000);
      txs.push({c:'BTC', val:parseFloat(val.toFixed(5)), hash:tx.txid, ts, from, to, exFrom:'', exTo:''});
    }
  } catch(e) { /* rate limit - wait for next cycle */ }
  return txs;
}

// ─── 缓存写入（增量追加，500 上限）───
function updateCache(fresh) {
  let old = [];
  try { old = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).transfers || []; } catch(e) {}
  const seen = new Set(old.map(t => t.hash));
  for (const t of fresh) {
    if (!seen.has(t.hash)) { old.unshift(t); seen.add(t.hash); }
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify({updated:Date.now(), transfers:old.slice(0,500)}, null, 2));
  // P0: 写 SQLite
  try { require('./data-store').save('whale', fresh, 'hash'); } catch(e) {}
  // P2: 按日归档
  try { const { archive } = require('./archive-manager'); archive('whale', fresh, 'hash'); } catch(e) {}
  
  // 同步写 SQLite（主存储）
  try {
    const db = require('./db');
    const insert = db.prepare('INSERT OR IGNORE INTO whale_transfers (chain, value, hash, ts, from_addr, to_addr, ex_from, ex_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const tx = db.transaction((items) => {
      for (const t of items) {
        insert.run(t.c || '', t.val || 0, t.hash, t.ts || Math.floor(Date.now()/1000), t.from || '', t.to || '', t.exFrom || '', t.exTo || '');
      }
    });
    tx(fresh);
  } catch(e) {}
}

// ─── 启动 ───
if (require.main === module) {
  console.log('[whale] 🐋 启动 (轮询: 1s=ETH  2s=USDT  3s=USDC  4s=BTC)');

  const TASKS = [
    async () => { const t = await scanEthBlock(); if (t.length) { updateCache(t); console.log('[whale] ✅ ETH:', t.length); } },
    async () => { const t = await fetchTokenTxs('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 1500000, "USDT"); if (t.length) { updateCache(t); console.log('[whale] ✅ USDT:', t.length); } },
    async () => { const t = await fetchTokenTxs('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 1500000, "USDC"); if (t.length) { updateCache(t); console.log('[whale] ✅ USDC:', t.length); } },
    async () => { const t = await scanBtcBlock(); if (t.length) { updateCache(t); console.log('[whale] ✅ BTC:', t.length); } },
  ];
  const LABELS = ['🔵 ETH', '🟡 USDT', '🟢 USDC', '🟠 BTC'];

  let idx = 0;
  setInterval(() => {
    const i = idx;
    idx = (i + 1) % TASKS.length;
    console.log('[whale] 📡', LABELS[i]);
    TASKS[i]().catch(() => {});
  }, 1000);

  // 首次全量加载
  (async () => {
    console.log('[whale] 🔍 首次全量扫描...');
    const res = await Promise.allSettled([scanEthBlock(), fetchTokenTxs('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 1500000, "USDT"), fetchTokenTxs('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 1500000, "USDC"), scanBtcBlock()]);
    const fresh = [];
    for (const r of res) { if (r.status === 'fulfilled') fresh.push(...r.value); }
    if (fresh.length) updateCache(fresh);
    console.log('[whale] ✅ 首次全量完成,', fresh.length, '条新');
  })();
}

module.exports = { scanAll: async () => {} };
