// ─── ETH大户行为分析器 ───
// 用Alchemy查每个地址的近期交易，分析行为

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ALCHEMY = 'https://eth-mainnet.g.alchemy.com/v2/alch_E3kX4fkHDTYOIEWORr0nd';

async function call(method, params) {
  const res = await axios.post(ALCHEMY, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 });
  return res.data.result;
}

// 已知协议标记
const PROTOCOLS = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'UniswapV2',
  '0x1f98431c8ad98523631ae4a59f267346ea31f984': 'UniswapV3',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'UniswapV3',
  '0xae7ab96520de3a18e5e111b589fa27aff3ab053b': 'Lido stETH',
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'Lido wstETH',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
  '0x514910771af9ca656af840dff83e8264ecf986ca': 'LINK',
};

// 分析一个地址的行为
async function analyzeAddress(addr) {
  const behaviors = [];
  const recentTxs = [];
  const protocols = new Set();

  // 查最近100笔交易
  try {
    const transfers = await call('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest',
      category: ['external', 'internal', 'erc20', 'erc721'],
      withMetadata: true, maxCount: 100,
      order: 'desc',
      fromAddress: addr,
    }]);

    const items = transfers?.transfers || [];
    let swapCount = 0, transferCount = 0, dexCount = 0, stakeCount = 0;
    for (const tx of items.slice(0, 30)) {
      const to = (tx.to || '').toLowerCase();
      const from = (tx.from || '').toLowerCase();
      const value = parseFloat(tx.value || 0);
      const asset = tx.asset || '';
      const hash = (tx.hash || '').slice(0, 12) + '..';
      const category = tx.category;
      const contract = (tx.rawContract?.address || '').toLowerCase();

      // 识别交互协议
      let label = PROTOCOLS[to] || PROTOCOLS[contract] || '';
      if (label) {
        protocols.add(label);
        if (label.includes('Uniswap')) {
          swapCount++;
          // 解析Uniswap交易方向
          const direction = category === 'erc20' ? 
            (from.toLowerCase() === addr.toLowerCase() ? '卖出' : '买入') : '交易';
          dexCount++;
          recentTxs.push(`🔄 Uniswap ${direction} ${value.toFixed(2)} ${asset}`);
        } else if (label.includes('Lido')) {
          stakeCount++;
          recentTxs.push(`🥩 Lido 质押 ${value.toFixed(4)} ETH`);
        } else if (label === 'USDT' || label === 'USDC') {
          transferCount++;
        }
      } else if (category === 'external' && value > 0.1) {
        // ETH转账
        if (from.toLowerCase() === addr.toLowerCase()) {
          recentTxs.push(`📤 转出 ${value.toFixed(4)} ETH → ${to.slice(0,8)}..`);
        } else {
          recentTxs.push(`📥 转入 ${value.toFixed(4)} ETH`);
        }
        transferCount++;
      }
    }

    // 生成行为摘要
    const parts = [];
    if (swapCount > 0) parts.push(`在Uniswap做了${swapCount}笔交易`);
    if (stakeCount > 0) parts.push(`质押了到Lido`);
    if (transferCount > 0) parts.push(`${transferCount}笔转账`);
    if (items.length === 0) parts.push('无近期活动');

    behaviors.push(parts.join(' | '));
    
    return {
      behavior: behaviors.join(' | '),
      recentTxs: recentTxs.slice(0, 10),
      protocolTags: [...protocols],
    };
  } catch(e) {
    return {
      behavior: '数据采集中',
      recentTxs: [],
      protocolTags: [],
    };
  }
}

// ─── 批量分析所有ETH大户 ───
async function analyzeAll() {
  const whaleFile = path.join(__dirname, 'public', 'data', 'analysis', 'eth_whales.json');
  const data = JSON.parse(fs.readFileSync(whaleFile, 'utf8'));
  const whales = data.whales || [];

  console.log(`分析 ${whales.length} 个ETH大户的行为...\n`);

  for (let i = 0; i < whales.length; i++) {
    const w = whales[i];
    const addr = w.fullAddr || w.addr;
    if (!addr) continue;

    console.log(`[${i+1}/${whales.length}] ${addr.slice(0,12)}.. ${w.balance}ETH`);
    const result = await analyzeAddress(addr);
    w.behavior = result.behavior;
    w.recentTxs = result.recentTxs;
    w.protocols = result.protocolTags;

    if (result.behavior) console.log(`  行为: ${result.behavior.slice(0,60)}`);
    if (result.recentTxs.length > 0) console.log(`  最新: ${result.recentTxs[0].slice(0,50)}`);

    // Alchemy免费版有限速
    await new Promise(r => setTimeout(r, 200));
  }

  // 更新分类
  for (const w of whales) {
    const tx = w.txCount || 0;
    const bal = parseFloat(w.balance || 0);
    if (tx > 1000) w.category = '超短线交易员 ⚡';
    else if (tx > 100) w.category = '短线交易员 🔹';
    else if (bal > 1000 && tx < 5) w.category = '钻石手 💎';
    else w.category = '中线交易员';
  }

  fs.writeFileSync(whaleFile, JSON.stringify({ updated: Date.now(), whales }, null, 2));
  console.log(`\n✅ 已保存 ${whales.length} 个地址的行为数据`);
}

if (require.main === module) {
  analyzeAll().catch(e => console.error('FATAL:', e.message));
}

module.exports = { analyzeAddress, analyzeAll };
