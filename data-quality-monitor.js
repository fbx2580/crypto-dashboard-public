#!/usr/bin/env node
/**
 * Data Quality Monitor v2 — 两段式核验
 * 
 * 原则：
 *   1. 宽松阈值初筛 → 不误报
 *   2. 可疑时做 API 穿透验证 → 确认是不是真的挂了
 *   3. 连续 3 次确认失败才告警 → 不因为一次抖动就喊
 *   4. 告警附带验证证据 → 可追溯
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, 'public', 'data');
const BINANCE = 'https://fapi.binance.com/fapi/v1';

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [dq] ${m}`); }

// ═══ 数据源定义：名称、期望频率、初筛阈值、验证方式、连续失败次数 ═══
const SOURCES = [
  {
    id: 'jin10',
    name: '金十快讯',
    file: 'news/jin10.json',
    field: 'items',
    expectSec: 10,    // 期望每10秒更新
    warnSec: 60,      // 60秒后初筛告警
    verify: async () => {
      try { await axios.get('https://www.jin10.com', { timeout: 10000 }); return true; }
      catch(e) { return false; }
    },
    verifyLabel: 'jin10.com 可达',
  },
  {
    id: 'rss',
    name: 'RSS新闻',
    file: 'news/latest.json',
    field: 'items',
    expectSec: 10,
    warnSec: 120,     // RSS 聚合可能慢一些
    verify: async () => {
      // 随便选一个 RSS 源测一下
      try {
        const r = await axios.get('https://cointelegraph.com/rss', { timeout: 10000 });
        return r.status === 200;
      } catch(e) { return false; }
    },
    verifyLabel: 'CoinTelegraph RSS 可达',
  },
  {
    id: 'whale',
    name: '鲸鱼转账',
    file: 'whale/transfers.json',
    field: 'transfers',
    expectSec: 10,
    warnSec: 120,
    verify: async () => {
      // 调 Etherscan API 看最新区块
      try {
        let KEY = '';
        try { KEY = fs.readFileSync(path.join(__dirname, 'secrets', 'etherscan.key'), 'utf8').trim().split('\n').filter(l => !l.startsWith('#') && l.trim())[0] || ''; } catch(e) {}
        if (!KEY) return false;
        const r = await axios.get(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${KEY.slice(0,20)}`, { timeout: 8000 });
        return r.data && r.data.result && r.data.result.startsWith('0x');
      } catch(e) { return false; }
    },
    verifyLabel: 'Etherscan 区块号可达',
  },
  {
    id: 'eth',
    name: 'ETH大户',
    file: 'analysis/eth_whales.json',
    field: 'whales',
    expectSec: 30,
    warnSec: 300,
    verify: async () => {
      try {
        let KEY = '';
        try { KEY = fs.readFileSync(path.join(__dirname, 'secrets', 'etherscan.key'), 'utf8').trim().split('\n').filter(l => !l.startsWith('#') && l.trim())[0] || ''; } catch(e) {}
        if (!KEY) return false;
        const r = await axios.get(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=${KEY.slice(0,20)}`, { timeout: 8000 });
        return r.data && r.data.result && r.data.result.startsWith('0x');
      } catch(e) { return false; }
    },
    verifyLabel: 'Etherscan 可达',
  },
  {
    id: 'alerts',
    name: '异动数据',
    file: 'alerts/price_alerts.json',
    field: 'alerts',
    expectSec: 60,
    warnSec: 3600,    // 1小时——没异动很正常
    verify: async () => {
      try { await axios.get(`${BINANCE}/ticker/price?symbol=BTCUSDT`, { timeout: 5000 }); return true; }
      catch(e) { return false; }
    },
    verifyLabel: 'Binance API 可达',
  },
  {
    id: 'market_snapshot',
    name: '市场快照',
    file: 'market_data/latest.json',
    field: null,
    expectSec: 86400,  // 每日
    warnSec: 90000,    // 25小时
    verify: async () => {
      try { const r = await axios.get(`${BINANCE}/ticker/price?symbol=BTCUSDT`, { timeout: 5000 }); return r.status === 200; }
      catch(e) { return false; }
    },
    verifyLabel: 'Binance BTC 价格可达',
  },
  {
    id: 'data_quality',
    name: '数据质量',
    file: 'market_data/data_quality.json',
    field: null,
    expectSec: 300,
    warnSec: 900,
    verify: async () => true, // self-check
    verifyLabel: '自身',
  },
  {
    id: 'alerts_log',
    name: '告警日志',
    file: 'market_data/alerts_log.json',
    field: 'alerts',
    expectSec: 300,
    warnSec: 900,
    verify: async () => true,
    verifyLabel: '自身',
  },
];

// ═══ 核心：两段式检查 ═══
async function checkSource(src) {
  const result = {
    id: src.id, name: src.name,
    status: 'unknown', score: 100,
    delay: null, updated: null,
    errors: [], verified: false, verifyResult: null,
  };

  // ── 第一段：文件时间检查 ──
  const fp = path.join(DATA_DIR, src.file);
  if (!fs.existsSync(fp)) {
    result.errors.push('文件不存在');
    result.status = 'error'; result.score = 0;
    return result;
  }

  let st;
  try { st = fs.statSync(fp); } catch(e) {
    result.errors.push('文件不可读');
    result.status = 'error'; result.score = 0;
    return result;
  }

  const delay = Math.round((Date.now() - st.mtimeMs) / 1000);
  result.delay = delay;
  result.updated = new Date(st.mtimeMs).toISOString();

  // 读取内容检查字段
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const field = src.field;
    if (field && d[field] && Array.isArray(d[field]) && d[field].length === 0) {
      // 数组为空——可能是正常的（如鲸鱼、异动）
      // 不报错，但标记
      result.emptyArr = true;
    }
  } catch(e) {
    result.errors.push('JSON 解析失败');
    result.status = 'error'; result.score = 20;
    return result;
  }

  // 初筛：延迟是否超过阈值
  if (delay < src.warnSec) {
    result.status = 'ok';
    result.score = 100;
    return result;
  }

  // ── 第二段：API 穿透验证 ──
  L(`[${src.name}] 文件延迟 ${delay}s > 阈值 ${src.warnSec}s，触发验证...`);
  let verified = false;
  try {
    verified = await src.verify();
  } catch(e) {
    result.errors.push(`验证异常: ${e.message.slice(0,40)}`);
  }
  result.verified = true;
  result.verifyResult = verified ? src.verifyLabel + ' ✅' : src.verifyLabel + ' ❌';

  if (verified) {
    // API 可达但文件没更新 → 采集脚本可能挂了
    result.status = 'warn';
    result.score = 70;
    result.errors.push(`采集可能卡住: 文件${delay}s未更新但API可达`);
  } else {
    // API 也不可达 → 上游挂了
    result.status = 'warn';
    result.score = 50;
    result.errors.push(`API验证失败: ${src.verifyLabel}不可达`);
  }

  return result;
}

// ═══ 数据质量（字段/数值检查）═══
async function checkDataQuality() {
  const errors = [];

  // BTC 字段
  try {
    const f = path.join(DATA_DIR, 'market_data', 'latest.json');
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const b = d.btc || {};
      if (b.price == null || isNaN(b.price) || b.price <= 0) errors.push('[btc] price 异常');
      if (b.ma200 == null || isNaN(b.ma200)) errors.push('[btc] ma200 缺失');
    }
  } catch(e) {}

  // K线抽查
  try {
    const cacheDir = path.join(DATA_DIR, 'klines_cache');
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
      if (files.length < 100) errors.push(`[kline] 数量不足: ${files.length}/528`);
      for (const sym of ['BTC', 'ETH', 'SOL']) {
        const f = path.join(cacheDir, `${sym}.json`);
        if (!fs.existsSync(f)) continue;
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        const kl = d.klines || [];
        const last = kl[kl.length - 1];
        if (!last) { errors.push(`[kline] ${sym} 为空`); continue; }
        if (last.time === 0 || (last.time && last.time < 86400000)) errors.push(`[kline] ${sym} 时间戳异常`);
        if (!last.close || last.close <= 0) errors.push(`[kline] ${sym}.close 异常`);
      }
    }
  } catch(e) {}

  return errors;
}

// ═══ 持久状态：连续失败计数器 ═══
const STATE_FILE = path.join(DATA_DIR, 'market_data', 'alert_state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveState(s) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ═══ 主流程 ═══
async function main() {
  const timestamp = new Date().toISOString();
  const state = loadState();

  // 并行检查所有数据源
  const results = await Promise.all(SOURCES.map(s => checkSource(s)));
  const dataErrors = [];

  // 数据质量检查（只在有文件时做）
  try { dataErrors.push(...(await checkDataQuality())); } catch(e) {}

  // 统计
  const allErrors = results.flatMap(r => r.errors);
  const okCount = results.filter(r => r.status === 'ok').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const errCount = results.filter(r => r.status === 'error').length;
  const overallScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const overallStatus = overallScore >= 80 ? 'healthy' : overallScore >= 60 ? 'degraded' : 'unhealthy';

  // ── 告警判定：连续 3 次才告警 ──
  const alertFile = path.join(DATA_DIR, 'market_data', 'alerts_log.json');
  let alertLog = [];
  try { alertLog = JSON.parse(fs.readFileSync(alertFile, 'utf8')).alerts || []; } catch(e) {}

  const newAlerts = [];
  for (const r of results) {
    if (r.status === 'ok') {
      // 恢复：清除失败计数
      if (state[r.id] && state[r.id] > 0) {
        alertLog.unshift({
          time: timestamp,
          type: 'recovery',
          level: 'info',
          source: r.id,
          message: `${r.name} 恢复 (延迟${r.delay}s)`,
          errors: [],
          resolved: true,
        });
      }
      state[r.id] = 0;
      continue;
    }

    // 累加失败计数
    state[r.id] = (state[r.id] || 0) + 1;

    // 只有连续失败 3 次（15分钟）才告警
    if (state[r.id] >= 3 && state[r.id] % 3 === 0) {
      const level = r.status === 'error' ? 'critical' : 'warn';
      const verifyInfo = r.verified ? ` | 验证: ${r.verifyResult}` : '';
      newAlerts.push({
        time: timestamp,
        type: 'confirmed_failure',
        level,
        source: r.id,
        message: `${r.name} 连续${state[r.id]}次异常 (${r.delay}s未更新)${verifyInfo}`,
        errors: r.errors,
        resolved: false,
        consecutiveFailures: state[r.id],
      });
    }
  }

  // 清理不存在的源
  for (const k of Object.keys(state)) {
    if (!SOURCES.find(s => s.id === k)) delete state[k];
  }
  saveState(state);

  // 写入告警
  for (const a of newAlerts) alertLog.unshift(a);
  // 全部源健康 → 标记所有告警为已解决
  if (warnCount === 0 && errCount === 0) {
    let resolved = 0;
    for (const a of alertLog) { if (!a.resolved) { a.resolved = true; a.resolvedAt = timestamp; resolved++; } }
    if (resolved) L(`✅ 全部健康，清理 ${resolved} 条旧告警`);
  }
  // 超过 2 小时的告警自动过期
  const cutoff = Date.now() - 2 * 3600000;
  alertLog = alertLog.filter(a => {
    const at = new Date(a.time).getTime();
    if (!a.resolved && at < cutoff) { a.resolved = true; a.resolvedAt = new Date().toISOString(); a.expired = true; }
    return true;
  });
  if (alertLog.length > 200) alertLog = alertLog.slice(0, 200);
  fs.writeFileSync(alertFile, JSON.stringify({ alerts: alertLog, updated: timestamp, total: alertLog.length }, null, 2));

  // 输出质量报告
  const report = {
    timestamp,
    overall_score: overallScore,
    status: overallStatus,
    checks: Object.fromEntries(results.map(r => [
      r.id, { status: r.status, score: r.score, errors: r.errors, delay: r.delay, verified: r.verified, verifyResult: r.verifyResult }
    ])),
    dataErrors,
    errors: [...allErrors, ...dataErrors],
  };
  const outDir = path.join(DATA_DIR, 'market_data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data_quality.json'), JSON.stringify(report, null, 2));

  // 终端输出
  const alertCount = alertLog.filter(a => !a.resolved).length;
  console.log(`\nData Quality: ${overallScore}% ${overallStatus.toUpperCase()} | 源:${okCount}✅ ${warnCount}⚠️ ${errCount}❌ | 连续失败:${Object.entries(state).filter(([,v])=>v>0).map(([k,v])=>k+':'+v).join(',')||'无'} | 告警:${alertCount}`);
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
    const extra = r.verified ? ` [验证:${r.verifyResult}]` : '';
    const errInfo = r.errors.length ? ` (${r.errors.join('; ')})` : '';
    console.log(`  ${icon} ${r.name}: ${r.score}%${r.delay?' 延迟'+r.delay+'s':''}${errInfo}${extra}`);
  }

  if (newAlerts.length) {
    console.log(`\n🚨 新告警:`);
    for (const a of newAlerts) console.log(`  ${a.level==='critical'?'🔴':'⚠️'} ${a.message}`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); });
