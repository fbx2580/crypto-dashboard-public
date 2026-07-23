// ─── 钱包监控采集器 ───
// 监控公开交易员地址的持仓变化
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, 'public', 'data', 'wallets');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 监控地址列表
const WATCHED_WALLETS = [
  {
    id: 'james_fickel',
    name: 'James Fickel',
    address: '0xf977814e90da44bfa03b6295a0616a897441acec',
    chain: 'eth',
    color: '#58a6ff',
    tags: ['ETH多头', '个人交易员'],
  },
  {
    id: '0xsifu',
    name: '0xSifu',
    address: '0x8b337bd0cf9526d3cb63d3e81c5e3cedf52feb3',
    chain: 'eth',
    color: '#3fb950',
    tags: ['DeFi大户', 'CurveLP'],
  },
  {
    id: 'gcr',
    name: 'GCR',
    address: '0x2222286e4a2f8b00d34524a3a1d5a9c442f36d4e',
    chain: 'eth',
    color: '#d29922',
    tags: ['逆向交易', '经典战役'],
  },
];

const CACHE_FILE = path.join(DATA_DIR, 'latest.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ETH RPC 公共节点


// 获取 ETH 余额


// 获取钱包历史（简版：每轮记录一次）
async function refreshAll() {
  const now = Date.now();
  const results = [];
  
  for (const w of WATCHED_WALLETS) {
    console.log(`[wallet] checking ${w.name}...`);
    
    let ethBalance = null;
    let usdValue = null;
    
    if (w.chain === 'eth') {
      ethBalance = await getEthBalance(w.address);
      // 粗略估算 USD（用 ETH 现价，后续可以优化）
      if (ethBalance !== null) {
        usdValue = ethBalance * 3200; // 估算，后续从币安拉实时价
      }
    }
    
    results.push({
      id: w.id,
      name: w.name,
      address: w.address,
      color: w.color,
      tags: w.tags,
      timestamp: now,
      ethBalance: ethBalance ? parseFloat(ethBalance.toFixed(4)) : null,
      usdValue: usdValue ? parseFloat(usdValue.toFixed(0)) : null,
      usdValueFormatted: usdValue ? '$' + (usdValue / 1e6).toFixed(2) + 'M' : 'N/A',
    });
    
    // 存历史
    const historyFile = path.join(HISTORY_DIR, w.id + '.jsonl');
    fs.appendFileSync(historyFile, JSON.stringify({
      t: now,
      eth: ethBalance,
      usd: usdValue,
    }) + '\n');
  }
  
  // 写最新数据
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    updated: now,
    wallets: results,
  }, null, 2));
  
  console.log(`[wallet] ✅ ${results.length} wallets checked`);
}

// 独立运行模式
if (require.main === module) {
  console.log('[wallet] 👛 钱包监控启动 (间隔 60s)');
  async function loop() {
    await refreshAll();
    setTimeout(loop, 60000);
  }
  loop();
}

module.exports = { refreshAll, WATCHED_WALLETS };
