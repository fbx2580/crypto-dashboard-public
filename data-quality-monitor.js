#!/usr/bin/env node
/**
 * Data Quality Monitor — 每5分钟自动运行
 * 
 * 检查项目：
 *   1. 数据存在性（文件是否存在、API返回是否为空）
 *   2. 数据新鲜度（last_update, delay_minutes）
 *   3. 数据完整性（必填字段是否齐全）
 *   4. 数据异常检测（price<=0, close<=0, timestamp=1970, 数量骤降）
 *
 * 输出：public/data/market_data/data_quality.json
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BINANCE = 'https://fapi.binance.com/fapi/v1';
const DATA_DIR = path.join(__dirname, 'public', 'data');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [dq] ${m}`); }

// ═══ 检查项定义 ═══

/**
 * 每条检查返回: { name, status: 'ok'|'warn'|'error', score: 0-100, errors: [], lastUpdate, delayMinutes }
 */

async function checkBTC() {
  const errors = [];
  let lastUpdate = null, delayMinutes = null;

  // 1. 文件存在 + 字段完整
  const f = path.join(DATA_DIR, 'market_data', 'latest.json');
  if (!fs.existsSync(f)) return { status: 'error', score: 0, errors: ['latest.json 不存在'] };

  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return { status: 'error', score: 0, errors: ['latest.json 解析失败'] }; }

  const b = d.btc || {};
  lastUpdate = d.timestamp;
  delayMinutes = lastUpdate ? Math.round((Date.now() - new Date(lastUpdate).getTime()) / 60000) : null;

  // 2. 必填字段
  const required = ['price', 'ma200', 'volatility30d', 'ret30d', 'change24h', 'volume24h'];
  for (const f of required) {
    if (b[f] == null || isNaN(b[f])) errors.push(`BTC.${f} 缺失或NaN`);
  }

  // 3. 数值异常
  if (b.price != null && b.price <= 0) errors.push('BTC.price <= 0');
  if (b.ma200 != null && b.ma200 <= 0) errors.push('BTC.ma200 <= 0');
  if (b.volatility30d != null && (b.volatility30d < 0.05 || b.volatility30d > 2.0)) errors.push(`BTC.volatility30d 异常: ${b.volatility30d}`);
  if (b.ret30d != null && b.ret30d < -95) errors.push(`BTC.ret30d 异常: ${b.ret30d}`);

  // 4. 新鲜度
  if (delayMinutes != null && delayMinutes > 60) errors.push(`BTC 数据超过60分钟未更新 (${delayMinutes}分钟)`);

  const score = errors.length === 0 ? 100 : errors.length <= 2 ? 80 : errors.length <= 4 ? 50 : 20;
  return { status: score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'error', score, errors, lastUpdate, delayMinutes };
}

function checkKline() {
  const errors = [];
  let lastUpdate = null, delayMinutes = null;

  const cacheDir = path.join(DATA_DIR, 'klines_cache');
  if (!fs.existsSync(cacheDir)) return { status: 'error', score: 0, errors: ['klines_cache 目录不存在'] };

  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const count = files.length;

  // 1. 数量检查
  if (count < 200) errors.push(`K线数量不足: ${count}/528`);
  if (count < 100) errors.push(`K线数量严重不足: ${count}/528`);

  // 2. 抽查5个核心币
  const samples = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE'];
  for (const sym of samples) {
    const f = path.join(cacheDir, `${sym}.json`);
    if (!fs.existsSync(f)) { errors.push(`${sym} K线缺失`); continue; }
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const kl = d.klines || [];
      if (kl.length < 200) errors.push(`${sym} K线不足${kl.length}根`);

      // 3. OHLCV 完整性
      const last = kl[kl.length - 1];
      if (!last) { errors.push(`${sym} 最后K线为空`); continue; }
      const ohlcv = ['open', 'high', 'low', 'close', 'volume', 'time'];
      for (const field of ohlcv) {
        if (last[field] == null || (field !== 'time' && last[field] <= 0)) errors.push(`${sym}.${field} 异常`);
      }

      // 4. 时间异常
      if (last.time === 0 || last.time === 1970 * 1000) errors.push(`${sym} 时间戳异常(epoch)`);
      
      // 5. 新鲜度
      const age = (Date.now() - (last.time || 0)) / 3600000;
      if (age > 48) errors.push(`${sym} K线超过48小时未更新(${age.toFixed(0)}h)`);
      
      if (!lastUpdate || (last.time && last.time < new Date(lastUpdate).getTime())) {
        lastUpdate = new Date(last.time).toISOString();
        delayMinutes = Math.round((Date.now() - last.time) / 60000);
      }
    } catch(e) { errors.push(`${sym} 读取失败: ${e.message}`); }
  }

  const score = errors.length === 0 ? 100 : errors.length <= 3 ? 80 : errors.length <= 6 ? 50 : 20;
  return { status: score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'error', score, errors, lastUpdate, delayMinutes, klineCount: count };
}

function checkNews() {
  const errors = [];
  let lastUpdate = null, delayMinutes = null;

  const f = path.join(DATA_DIR, 'news', 'jin10.json');
  if (!fs.existsSync(f)) return { status: 'error', score: 0, errors: ['jin10.json 不存在'] };

  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return { status: 'error', score: 0, errors: ['jin10.json 解析失败'] }; }

  const items = d.items || [];
  if (!items.length) errors.push('新闻列表为空');

  // 新鲜度
  const newest = items[0]?.t;
  if (newest) {
    lastUpdate = newest;
    delayMinutes = Math.round((Date.now() - new Date(newest).getTime()) / 60000);
    if (delayMinutes > 360) errors.push(`新闻超过6小时未更新 (${Math.round(delayMinutes/60)}h)`);
    if (delayMinutes > 720) errors.push(`新闻超过12小时未更新`);
  } else {
    errors.push('新闻缺少时间戳');
  }

  const score = errors.length === 0 ? 100 : errors.length <= 1 ? 80 : 50;
  return { status: score >= 80 ? 'ok' : 'warn', score, errors, lastUpdate, delayMinutes };
}

function checkAlerts() {
  const errors = [];
  let lastUpdate = null, delayMinutes = null;

  const f = path.join(DATA_DIR, 'alerts', 'price_alerts.json');
  if (!fs.existsSync(f)) return { status: 'error', score: 0, errors: ['price_alerts.json 不存在'] };

  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return { status: 'error', score: 0, errors: ['price_alerts.json 解析失败'] }; }

  const alerts = d.alerts || [];
  if (!alerts.length) { /* 可以没有异动，不是错误 */ }

  // 新鲜度（从文件mtime）
  const mtime = fs.statSync(f).mtime;
  lastUpdate = mtime.toISOString();
  delayMinutes = Math.round((Date.now() - mtime.getTime()) / 60000);
  if (delayMinutes > 720) errors.push(`异动数据超过12小时未更新 (${Math.round(delayMinutes/60)}h)`);

  const score = errors.length === 0 ? 100 : 50;
  return { status: score >= 80 ? 'ok' : 'warn', score, errors, lastUpdate, delayMinutes };
}

function checkWhale() {
  const errors = [];
  let lastUpdate = null, delayMinutes = null;

  const f = path.join(DATA_DIR, 'whale', 'transfers.json');
  if (!fs.existsSync(f)) return { status: 'error', score: 0, errors: ['transfers.json 不存在'] };

  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) { return { status: 'error', score: 0, errors: ['transfers.json 解析失败'] }; }

  const transfers = d.transfers || [];
  if (transfers.length) {
    const newest = transfers[0]?.ts;
    if (newest && newest > 1000000000000) { // 合理时间戳
      lastUpdate = new Date(newest).toISOString();
      delayMinutes = Math.round((Date.now() - newest) / 60000);
      if (delayMinutes > 60) errors.push(`鲸鱼数据超过1小时未更新 (${delayMinutes}分钟)`);
    } else {
      errors.push('鲸鱼数据时间戳异常(epoch 1970)');
    }
  } else {
    errors.push('鲸鱼数据为空');
  }

  const score = errors.length === 0 ? 100 : errors.length <= 1 ? 80 : 50;
  return { status: score >= 80 ? 'ok' : 'warn', score, errors, lastUpdate, delayMinutes };
}

async function checkBinanceAPI() {
  const errors = [];
  try {
    const start = Date.now();
    const r = await axios.get(`${BINANCE}/ticker/price?symbol=BTCUSDT`, { timeout: 10000 });
    const latency = Date.now() - start;
    if (r.status !== 200) errors.push(`Binance API ${r.status}`);
    const price = parseFloat(r.data.price);
    if (!price || price <= 0) errors.push('BTC 价格异常');
    return { status: errors.length ? 'error' : 'ok', score: errors.length ? 0 : 100, errors, latency };
  } catch(e) {
    return { status: 'error', score: 0, errors: [`Binance API 不可达: ${e.message.slice(0,50)}`] };
  }
}

// ═══ 主流程 ═══
async function main() {
  const timestamp = new Date().toISOString();

  const [btc, kline, news, alerts, whale, api] = await Promise.all([
    checkBTC(),
    Promise.resolve(checkKline()),
    checkNews(),
    checkAlerts(),
    checkWhale(),
    checkBinanceAPI(),
  ]);

  const checks = { btc, kline, news, alerts, whale, api };
  const scores = Object.values(checks).map(c => c.score);
  const overallScore = Math.round(scores.reduce((a,b) => a + b, 0) / scores.length);
  const errors = Object.entries(checks).flatMap(([k, v]) => (v.errors || []).map(e => `[${k}] ${e}`));
  const overallStatus = overallScore >= 80 ? 'healthy' : overallScore >= 60 ? 'degraded' : 'unhealthy';

  const report = {
    timestamp,
    overall_score: overallScore,
    status: overallStatus,
    checks,
    errors,
  };

  const outDir = path.join(DATA_DIR, 'market_data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data_quality.json'), JSON.stringify(report, null, 2));

  // 终端输出
  console.log(`\nData Quality: ${overallScore}% ${overallStatus.toUpperCase()}`);
  for (const [name, c] of Object.entries(checks)) {
    const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    console.log(`  ${icon} ${name}: ${c.score}%${c.errors.length ? ` (${c.errors.length}个问题)` : ''}`);
    if (c.errors.length) c.errors.slice(0, 3).forEach(e => console.log(`     ${e}`));
  }
}

main().catch(e => { L('FAIL: ' + e.message); });
