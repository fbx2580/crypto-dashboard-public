// ─── 数据源健康监控 ───
// 检测各数据源是否可用，挂了自动切换+通知
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'public', 'data', 'alerts', 'source_alerts.json');
const STATE = path.join(__dirname, 'data', 'source_state.json');

// 数据源列表
const SOURCES = [
  { id: 'etherscan', name: 'Etherscan API', url: 'https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&tag=latest&boolean=true&apikey=' + fs.readFileSync(path.join(__dirname,'secrets','etherscan.key'),'utf8').trim(), timeout: 8000 },
  { id: 'mempool', name: 'mempool.space (BTC)', url: 'https://mempool.space/api/blocks/tip/height', timeout: 8000 },
  { id: 'blockstream', name: 'Blockstream (BTC)', url: 'https://blockstream.info/api/blocks/tip/height', timeout: 8000 },
  { id: 'alchemy', name: 'Alchemy (ETH)', url: 'https://eth-mainnet.g.alchemy.com/v2/alch_E3kX4fkHDTYOIEWORr0nd', timeout: 8000, post: true },
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch(e) { return {}; }
}

function saveState(s) { 
  const dir = path.dirname(STATE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(STATE, JSON.stringify(s,null,2));
}

function logAlert(msg) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
    let data = { alerts: [] };
    try { data = JSON.parse(fs.readFileSync(FILE,'utf8')); } catch(e) {}
    data.alerts.unshift({ msg, ts: Math.floor(Date.now()/1000) });
    if (data.alerts.length > 20) data.alerts = data.alerts.slice(0,20);
    fs.writeFileSync(FILE, JSON.stringify(data,null,2));
  } catch(e) {}
}

async function checkSource(src) {
  try {
    if (src.post) {
      await axios.post(src.url, { jsonrpc:'2.0', id:1, method:'eth_blockNumber', params:[] }, { timeout: src.timeout });
    } else {
      await axios.get(src.url, { timeout: src.timeout });
    }
    return true;
  } catch(e) {
    return false;
  }
}

async function monitor() {
  const state = loadState();
  
  for (const src of SOURCES) {
    const ok = await checkSource(src);
    const prev = state[src.id];
    
    if (!ok && (!prev || prev.status === 'ok')) {
      // 刚挂
      state[src.id] = { status: 'down', time: Date.now() };
      const msg = `🔴 数据源 ${src.name} 挂了`;
      console.log(`[source] ${msg}`);
      logAlert(msg);
      
      // 自动切换（如果有备选）
      if (src.id === 'blockstream') {
        console.log('[source]  BTC扫描已自动切换到 mempool.space');
        // whale-monitor已经用mempool.space了，blockstream只是标注用
      }
    } else if (ok && prev && prev.status === 'down') {
      // 恢复了
      state[src.id] = { status: 'ok', time: Date.now() };
      const msg = `🟢 数据源 ${src.name} 已恢复`;
      console.log(`[source] ${msg}`);
      logAlert(msg);
    } else if (ok) {
      state[src.id] = { status: 'ok', time: Date.now() };
    }
  }
  
  saveState(state);
  console.log(`[source] ✅  ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`);
}

console.log('[source-monitor] 🚀 数据源健康监控启动');
monitor();
setInterval(monitor, 300000); // 5分钟检一次
