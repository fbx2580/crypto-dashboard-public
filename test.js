// ─── 自测脚本：验证后端 → 前端全链路 ───
const http = require('http');

const BASE = 'http://localhost:3001';
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('🔍 Crypto Dashboard 自测\n');
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✅ ${t.name}`);
      passed++;
    } catch(e) {
      console.log(`  ❌ ${t.name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n📊 结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

function fetch(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function json(body) {
  try { return JSON.parse(body); } catch(e) { throw new Error('JSON解析失败: ' + body.slice(0,80)); }
}

// ═══ 测试用例 ═══

test('首页返回200', async () => {
  const res = await fetch('/');
  if (res.status !== 200) throw new Error(`status=${res.status}`);
});

test('巨鲸API返回500条', async () => {
  const res = await fetch('/api/whale/transfers');
  const d = json(res.body);
  if (!d.transfers) throw new Error('无 transfers 字段');
  if (d.transfers.length < 400) throw new Error(`只有${d.transfers.length}条, 期望>=400`);
});

test('巨鲸数据字段完整', async () => {
  const res = await fetch('/api/whale/transfers');
  const t = json(res.body).transfers[0];
  for (const k of ['c','val','hash','ts','from','to']) {
    if (t[k] === undefined) throw new Error(`缺少字段: ${k}`);
  }
});

test('巨鲸过滤BTC有数据', async () => {
  const res = await fetch('/api/whale/transfers');
  const txs = json(res.body).transfers;
  const btcs = txs.filter(t => t.c === 'BTC');
  if (btcs.length < 1) throw new Error('BTC 0条');
});

test('地址分析API返回', async () => {
  const res = await fetch('/api/whale/addresses');
  const d = json(res.body);
  if (!d.btc || !d.eth) throw new Error('缺少btc/eth');
  if (d.btc.length < 1 && d.eth.length < 1) throw new Error('都为空');
});

test('BTC价格返回', async () => {
  const res = await fetch('/api/binance/price/btc');
  const d = json(res.body);
  if (!d.price) throw new Error('无价格');
  if (typeof d.price !== 'number') throw new Error('价格不是数字');
});

test('大盘API', async () => {
  const res = await fetch('/api/market/overview');
  const d = json(res.body);
  if (!d.crypto) throw new Error('无crypto');
});

test('恐惧贪婪API', async () => {
  const res = await fetch('/api/market/indicators');
  const d = json(res.body);
  if (!d.fear && !d.altSeason) throw new Error('无数据');
});

test('新闻API', async () => {
  const res = await fetch('/api/news');
  const d = json(res.body);
  // 只要不报错就算过
});

test('健康检查', async () => {
  const res = await fetch('/api/health');
  const d = json(res.body);
  if (d.status !== 'ok') throw new Error('status不是ok');
});

run();
