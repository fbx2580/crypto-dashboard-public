// ─── ETH 大户常驻监控 ───
const A = 'https://eth-mainnet.g.alchemy.com/v2/alch_E3kX4fkHDTYOIEWORr0nd';
const ax = require('axios');
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'public', 'data', 'analysis', 'eth_whales.json');
const P = {'0x7a250d5630b4cf539739df2c5dacb4c659f2488d':'🔄Uniswap','0xae7ab96520de3a18e5e111b589fa27aff3ab053b':'🥩Lido','0xdac17f958d2ee523a2206206994597c13d831ec7':'USDT','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':'USDC'};

// ★ 令牌桶限速：Alchemy免费配额 ~10次/秒
let _tokens = 5, _lastRefill = Date.now();
function rateLimit() {
  const now = Date.now();
  _tokens = Math.min(5, _tokens + (now - _lastRefill) * 3 / 1000);
  _lastRefill = now;
  if (_tokens < 1) return new Promise(r => setTimeout(r, Math.ceil((1 - _tokens) * 400)));
  _tokens -= 1;
  return Promise.resolve();
}

async function call(m,p) { await rateLimit(); const r = await ax.post(A,{jsonrpc:'2.0',id:1,method:m,params:p},{timeout:15000}); return r.data.result; }

async function scanNew() {
  const data = JSON.parse(fs.readFileSync(FILE,'utf8'));
  const known = new Set((data.whales||[]).map(w=>(w.fullAddr||'').toLowerCase()));
  
  const latest = parseInt(await call('eth_blockNumber',[]),16);
  let added = 0;
  
  for (let i = 0; i < 10 && added < 10; i++) {
    const block = await call('eth_getBlockByNumber',['0x'+(latest-i).toString(16), true]);
    if (!block?.transactions) continue;
    for (const tx of block.transactions) {
      const val = parseInt(tx.value,16)/1e18;
      if (val < 10) continue;
      for (const addr of [tx.from?.toLowerCase(), (tx.to||'').toLowerCase()]) {
        if (!addr || addr.length < 30 || known.has(addr)) continue;
        try {
          const b = parseInt(await call('eth_getBalance',[addr,'latest']),16)/1e18;
          if (b < 1) continue;
          if ((await call('eth_getCode',[addr,'latest'])) !== '0x') continue;
          const tc = parseInt(await call('eth_getTransactionCount',[addr,'latest']),16);
          
          const [o,i] = await Promise.all([
            call('alchemy_getAssetTransfers',[{fromBlock:'0x0',toBlock:'latest',category:['external','erc20'],withMetadata:true,maxCount:20,order:'desc',fromAddress:addr}]),
            call('alchemy_getAssetTransfers',[{fromBlock:'0x0',toBlock:'latest',category:['external','erc20'],withMetadata:true,maxCount:20,order:'desc',toAddress:addr}])
          ]);
          
          const txs = []; const seen = new Set();
          for (const s of [o?.transfers||[], i?.transfers||[]]) {
            for (const t of s) {
              const v = parseFloat(t.value||0);
              if (v < 0.01 || seen.has(t.hash)) continue;
              seen.add(t.hash);
              const ti = (t.metadata?.blockTimestamp||'').slice(11,16);
              const as = t.asset||'ETH';
              const d = (t.from||'').toLowerCase()===addr?'📤':'📥';
              txs.push((ti?'['+ti+']':'')+' '+(P[(t.rawContract?.address||'').toLowerCase()]||P[(t.to||'').toLowerCase()]||d)+' '+v.toFixed(4)+' '+as);
            }
          }
          
          data.whales.push({
            fullAddr: addr, balance: b.toFixed(2), txCount: tc, addedAt: Date.now(),
            category: tc>1000?'超短线交易员 ⚡':tc>100?'短线交易员 🔹':'中线交易员',
            recentTxs: txs.slice(0,20),
            behavior: txs.length+'笔交易',
          });
          known.add(addr); added++;
          console.log(`[eth] 新增 ${addr.slice(0,12)}.. ${b.toFixed(0)}ETH`);
          await new Promise(r=>setTimeout(r,500));
        } catch(e) {}
      }
    }
  }
  if (added > 0) { fs.writeFileSync(FILE, JSON.stringify(data,null,2)); try { require('./data-store').save('eth', data.whales.slice(-added), 'fullAddr'); } catch(e) {} try { const { archive } = require('./archive-manager'); archive('eth', data.whales.slice(-added), 'fullAddr'); } catch(e) {} }
  return added;
}

async function checkBalance(fullScan) {
  const data = JSON.parse(fs.readFileSync(FILE,'utf8'));
  const whales = data.whales || [];
  const now = Date.now();
  const cutoff = now - 7*86400000; // 7天内活跃
  
  // 过滤：非全量扫描时只查活跃地址
  const targets = fullScan ? whales : whales.filter(w => {
    const lastActive = w.lastBalanceChange || w.addedAt || 0;
    return lastActive > cutoff;
  });
  
  if (!fullScan && targets.length === 0) return 0;
  
  let changed = 0;
  for (const w of targets) {
    const addr = w.fullAddr;
    if (!addr) continue;
    try {
      const b = parseInt(await call('eth_getBalance',[addr,'latest']),16)/1e18;
      if (Math.abs(b - parseFloat(w.balance||0)) > 0.5) {
        console.log(`[eth] 余额变化 ${addr.slice(0,12)}.. ${w.balance}→${b.toFixed(2)}ETH`);
        w.balance = b.toFixed(2);
        w.lastBalanceChange = now;
        changed++;
      }
    } catch(e) {}
    await new Promise(r=>setTimeout(r,200));
  }
  if (changed) { fs.writeFileSync(FILE, JSON.stringify(data,null,2)); try { const { archive } = require('./archive-manager'); archive('eth', data.whales, 'fullAddr'); } catch(e) {} }
  return changed;
}

async function main() {
  console.log('[eth-monitor] 🚀 ETH大户常驻监控启动 (方案B: 1分钟扫新区块/2分钟活跃/12小时全量)');
  
  // 🆕 扫新区块发现新大户：每 1 分钟
  setInterval(async () => { const n=await scanNew(); if(n)console.log(`[eth-monitor] 新增${n}个`); }, 60000);
  await scanNew();
  
  // 🔥 活跃地址高频查余额：每 2 分钟
  setInterval(async () => { const c=await checkBalance(false); if(c)console.log(`[eth-monitor] 活跃${c}个余额变动`); }, 120000);
  
  // 🧟 全量地址低频查余额：每 12 小时（3点 + 15点）
  const scheduleFull = () => {
    const now = new Date();
    const bjH = (now.getUTCHours() + 8) % 24;
    const bjM = now.getUTCMinutes();
    if ((bjH === 3 || bjH === 15) && bjM < 5) {
      console.log(`[eth-monitor] 🌙 全量余额扫描 (${bjH}:00)...`);
      checkBalance(true).then(c => console.log(`[eth-monitor] 🌙 全量${c}个余额变动`));
    }
  };
  setInterval(scheduleFull, 300000);
  scheduleFull();
}
main().catch(e=>console.error('[eth-monitor]',e.message));
