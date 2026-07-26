#!/usr/bin/env node
/**
 * Data Quality Monitor v2.1 — 深度诊断版
 * 
 * 告警三步：
 *   1. 文件时间初筛（宽松阈值）
 *   2. 深度诊断（查进程、查日志、查API、查具体原因）
 *   3. 连续3次确认才告警 + 自带修复建议
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'public', 'data');
const BINANCE = 'https://fapi.binance.com/fapi/v1';

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [dq] ${m}`); }
function pgrep(name) { try { return execSync(`pgrep -cf '${name}'`,{encoding:'utf8',timeout:3000}).trim(); } catch(e) { return '0'; } }
function logTail(f, n) { try { const l=fs.readFileSync(f,'utf8').trim().split('\n'); return l.slice(-n).join('\n'); } catch(e) { return ''; } }
function getKey() { try { return fs.readFileSync(path.join(__dirname,'secrets','etherscan.key'),'utf8').trim().split('\n')[0]||''; } catch(e) { return ''; } }

// ═══ 数据源：带深度诊断 ═══
const SOURCES = [
  {
    id: 'jin10', name: '金十快讯',
    file: 'news/jin10.json', field: 'items',
    expectSec: 10, warnSec: 300,
    diagnose: async () => {
      const d = { ok: false, detail: '', fix: '' };
      const pid = pgrep('jin10-scraper');
      if (pid === '0') { d.detail = 'jin10-scraper 进程不存在'; d.fix = '启动 jin10-scraper'; return d; }
      // 查日志最后更新时间
      try {
        const st = fs.statSync('/tmp/jin10.log');
        const logAge = Math.round((Date.now() - st.mtimeMs) / 1000);
        const log = logTail('/tmp/jin10.log', 10);
        // 日志超过120秒没更新 = 采集循环卡住了
        if (logAge > 120) { d.detail = `采集循环卡住: 日志${logAge}s无输出，可能page.goto挂起`; d.fix = '强制重启 jin10-scraper'; return d; }
        if (log.includes('closed') || log.includes('page.goto')) { d.detail = 'Chromium浏览器崩溃(page.goto/closed错误)'; d.fix = '强制重启 jin10-scraper'; return d; }
        if (log.includes('✅') || log.includes('浏览器已启动')) { d.detail = `进程运行正常(PID${pid})，日志${logAge}s前更新`; d.ok = true; return d; }
      } catch(e) {}
      d.detail = `进程运行中(PID${pid})`; d.ok = true; return d;
    },
  },
  {
    id: 'rss', name: 'RSS新闻',
    file: 'news/latest.json', field: 'items',
    expectSec: 10, warnSec: 300,
    diagnose: async () => {
      const d = { ok: false, detail: '', fix: '' };
      const pid = pgrep('rt-daemon');
      if (pid === '0') { d.detail = 'rt-daemon 进程不存在'; d.fix = '启动 rt-daemon'; return d; }
      const log = logTail('/tmp/rt.log', 5);
      if (!log) { d.detail = 'rt-daemon运行中但零输出——所有采集循环全哑'; d.fix = '重启 rt-daemon'; return d; }
      try { await axios.get('https://cointelegraph.com/rss',{timeout:8000}); d.ok = true; d.detail = 'rt-daemon运行中，RSS源正常'; } catch(e) { d.detail = 'CoinTelegraph RSS不可达'; d.fix = '检查RSS源或网络'; }
      return d;
    },
  },
  {
    id: 'whale', name: '鲸鱼转账',
    file: 'whale/transfers.json', field: 'transfers',
    expectSec: 10, warnSec: 300,
    diagnose: async () => {
      const d = { ok: false, detail: '', fix: '' };
      const KEY = getKey();
      if (!KEY) { d.detail = 'Etherscan API Key 缺失'; d.fix = '配置 secrets/etherscan.key'; return d; }
      // 试 V1 API
      try {
        const r = await axios.get(`https://api.etherscan.io/api?module=proxy&action=eth_blockNumber&apikey=***)}`, { timeout: 8000 });
        if (r.data?.result?.startsWith('0x')) { d.ok = true; d.detail = `Etherscan V1正常，区块${parseInt(r.data.result,16)}`; return d; }
        d.detail = `Etherscan V1返回异常: ${JSON.stringify(r.data).slice(0,80)}`;
      } catch(e) { d.detail = `Etherscan V1不可达: ${e.message.slice(0,40)}`; }
      // 试 V2
      try {
        const r = await axios.get(`https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=***)}`, { timeout: 8000 });
        if (r.data?.result) { d.ok = true; d.detail = `Etherscan V2正常，但V1失败`; d.fix = '切换whale-monitor到V2 API'; return d; }
      } catch(e) { d.detail += ` | V2也失败`; }
      d.fix = '检查Etherscan API或更换代理';
      return d;
    },
  },
  {
    id: 'eth', name: 'ETH大户',
    file: 'analysis/eth_whales.json', field: 'whales',
    expectSec: 30, warnSec: 3600,
    // ETH大户是静态地址数据库，API正常=数据正常
    diagnose: async () => {
      const d = { ok: false, detail: '', fix: '' };
      // ETH大户用 Alchemy JSON-RPC，不是 Etherscan
      const ALCHEMY = 'https://eth-mainnet.g.alchemy.com/v2/alch_E3kX4fkHDTYOIEWORr0nd';
      try {
        const r = await axios.post(ALCHEMY, { jsonrpc:'2.0', id:1, method:'eth_blockNumber', params:[] }, { timeout: 8000 });
        if (r.data?.result) { d.ok = true; d.detail = `Alchemy正常，区块${parseInt(r.data.result,16)}`; return d; }
        d.detail = 'Alchemy JSON-RPC返回异常';
      } catch(e) { d.detail = `Alchemy不可达: ${e.message.slice(0,40)}`; }
      d.fix = '检查Alchemy API Key或网络';
      return d;
    },
  },
  {
    id: 'alerts', name: '异动数据',
    file: 'alerts/price_alerts.json', field: 'alerts',
    expectSec: 60, warnSec: 3600,
    diagnose: async () => {
      try { await axios.get(`${BINANCE}/ticker/price?symbol=BTCUSDT`,{timeout:5000}); return { ok: true, detail: 'Binance API正常', fix: '' }; }
      catch(e) { return { ok: false, detail: 'Binance API不可达', fix: '检查Binance网络' }; }
    },
  },
  {
    id: 'market_snapshot', name: '市场快照',
    file: 'market_data/latest.json', field: null,
    expectSec: 86400, warnSec: 90000,
    diagnose: async () => {
      try { await axios.get(`${BINANCE}/ticker/price?symbol=BTCUSDT`,{timeout:5000}); return { ok: true, detail: 'Binance正常', fix: '' }; }
      catch(e) { return { ok: false, detail: 'Binance API不可达', fix: '检查网络' }; }
    },
  },
  { id: 'data_quality', name: '数据质量', file: 'market_data/data_quality.json', field: null, expectSec: 300, warnSec: 900, diagnose: async () => ({ ok: true, detail: '自身', fix: '' }) },
  { id: 'alerts_log', name: '告警日志', file: 'market_data/alerts_log.json', field: 'alerts', expectSec: 300, warnSec: 900, diagnose: async () => ({ ok: true, detail: '自身', fix: '' }) },
];

// ═══ 两段式检查（带深度诊断）═══
async function checkSource(src) {
  const result = { id: src.id, name: src.name, status: 'unknown', score: 100, delay: null, updated: null, errors: [], diagnosis: null };

  const fp = path.join(DATA_DIR, src.file);
  if (!fs.existsSync(fp)) { result.errors.push('文件不存在'); result.status = 'error'; result.score = 0; return result; }

  let st;
  try { st = fs.statSync(fp); } catch(e) { result.errors.push('文件不可读'); result.status = 'error'; result.score = 0; return result; }

  const delay = Math.round((Date.now() - st.mtimeMs) / 1000);
  result.delay = delay;
  result.updated = new Date(st.mtimeMs).toISOString();

  // 初筛通过
  if (delay < src.warnSec) { result.status = 'ok'; result.score = 100; return result; }

  // ── 深度诊断 ──
  L(`[${src.name}] 延迟 ${delay}s，触发深度诊断...`);
  let diagnosis;
  try { diagnosis = await src.diagnose(); } catch(e) { diagnosis = { ok: false, detail: `诊断异常: ${e.message}`, fix: '' }; }
  result.diagnosis = diagnosis;

  if (diagnosis.ok) {
    result.status = 'warn'; result.score = 70;
    result.errors.push(`延迟${delay}s但诊断通过: ${diagnosis.detail}`);
  } else {
    const sev = diagnosis.detail.includes('崩溃') || diagnosis.detail.includes('不存在') || diagnosis.detail.includes('不可达') ? 'error' : 'warn';
    result.status = sev;
    result.score = sev === 'error' ? 30 : 50;
    result.errors.push(`${diagnosis.detail}`);
    if (diagnosis.fix) result.errors.push(`建议修复: ${diagnosis.fix}`);
  }

  return result;
}

// ═══ 数据质量检查 ═══
async function checkDataQuality() {
  const errors = [];
  try {
    const f = path.join(DATA_DIR, 'market_data', 'latest.json');
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const b = d.btc || {};
      if (b.price == null || isNaN(b.price) || b.price <= 0) errors.push('[btc] price 异常');
      if (b.ma200 == null || isNaN(b.ma200)) errors.push('[btc] ma200 缺失');
    }
  } catch(e) {}
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
        if (!last) continue;
        if (last.time < 86400000) errors.push(`[kline] ${sym} 时间戳异常`);
        if (!last.close || last.close <= 0) errors.push(`[kline] ${sym}.close 异常`);
      }
    }
  } catch(e) {}
  return errors;
}

// ═══ 连续失败跟踪 ═══
const STATE_FILE = path.join(DATA_DIR, 'market_data', 'alert_state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { return {}; } }
function saveState(s) { const dir = path.dirname(STATE_FILE); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ═══ 主流程 ═══
async function main() {
  const timestamp = new Date().toISOString();
  const state = loadState();
  const results = await Promise.all(SOURCES.map(s => checkSource(s)));
  const dataErrors = [];
  try { dataErrors.push(...(await checkDataQuality())); } catch(e) {}

  const allErrors = results.flatMap(r => r.errors);
  const okCount = results.filter(r => r.status === 'ok').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const errCount = results.filter(r => r.status === 'error').length;
  const overallScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const overallStatus = overallScore >= 80 ? 'healthy' : overallScore >= 60 ? 'degraded' : 'unhealthy';

  // 告警日志
  const alertFile = path.join(DATA_DIR, 'market_data', 'alerts_log.json');
  let alertLog = [];
  try { alertLog = JSON.parse(fs.readFileSync(alertFile, 'utf8')).alerts || []; } catch(e) {}

  const newAlerts = [];
  const sdef = Object.fromEntries(SOURCES.map(s => [s.id, s]));
  for (const r of results) {
    if (r.status === 'ok') {
      if (state[r.id] && state[r.id] > 0) {
        alertLog.unshift({ time: timestamp, type: 'recovery', level: 'info', source: r.id, message: `${r.name} 已恢复`, errors: [], resolved: true });
      }
      state[r.id] = 0;
      continue;
    }
    state[r.id] = (state[r.id] || 0) + 1;
    // 文件超过阈值就立即告警（不等3次）
    const sd = sdef[r.id];
    if (r.delay > sd.warnSec) {
      const diag = r.diagnosis || {};
      // 去重
      const existing = alertLog.find(a => !a.resolved && a.source === r.id);
      if (!existing) {
        newAlerts.push({
          time: timestamp, type: 'staleness',
          level: r.status === 'error' ? 'critical' : 'warn',
          source: r.id,
          message: `${r.name}: ${diag.detail || '文件超过阈值未更新'} (${Math.round(r.delay/60)}分钟)`,
          errors: r.errors,
          fix: diag.fix || '',
          resolved: false,
        });
      }
    }

    if (state[r.id] >= 3 && state[r.id] % 3 === 0) {
      const diag = r.diagnosis || {};
      // 去重：同一 source 已有相同活跃告警就不再重复创建
      const existing = alertLog.find(a => !a.resolved && a.source === r.id);
      if (existing && existing.message && existing.message.slice(0,20) === diag.detail?.slice(0,20)) {
        existing.updatedAt = timestamp;
        existing.consecutiveFailures = state[r.id];
        continue;
      }
      newAlerts.push({
        time: timestamp, type: 'confirmed_failure',
        level: r.status === 'error' ? 'critical' : 'warn',
        source: r.id,
        message: `${r.name}: ${diag.detail || r.errors.join('; ')}`,
        errors: r.errors,
        fix: diag.fix || '',
        resolved: false,
        consecutiveFailures: state[r.id],
      });
    }
  }

  for (const k of Object.keys(state)) { if (!SOURCES.find(s => s.id === k)) delete state[k]; }
  saveState(state);

  for (const a of newAlerts) alertLog.unshift(a);

  // ═══ 回归检查：逐个验证未解决告警是否已自愈 ═══
  const rmap = Object.fromEntries(results.map(r => [r.id, r]));
  let regressed = 0;
  for (const a of alertLog) {
    if (a.resolved) continue;
    // 清理旧版无 source 的告警
    if (!a.source) { a.resolved = true; a.resolvedAt = timestamp; a.legacy = true; regressed++; continue; }
    const r = rmap[a.source];
    const sd = sdef[a.source];
    if (!r || !sd) continue; // 源不存在，保留告警
    // 诊断 ok 且 延迟已在阈值内 = 真正恢复
    const diagOk = r.diagnosis?.ok === true;
    const delayOk = (r.delay || 99999) < sd.warnSec;
    const improved = (a.level === 'critical' && r.status !== 'error') || (a.level === 'warn' && r.status === 'ok');
    if ((r.status === 'ok' && delayOk) || (diagOk && delayOk) || improved) {
      a.resolved = true; a.resolvedAt = timestamp; a.regressed = true; regressed++;
    }
  }
  if (regressed) L(`🔄 回归: ${regressed} 条告警已自愈`);

  if (warnCount === 0 && errCount === 0) {
    let res = 0;
    for (const a of alertLog) { if (!a.resolved) { a.resolved = true; a.resolvedAt = timestamp; res++; } }
    if (res) L(`✅ 全部健康，清理 ${res} 条告警`);
  }
  // 2小时过期
  const cutoff = Date.now() - 2*3600000;
  for (const a of alertLog) { if (!a.resolved && new Date(a.time).getTime() < cutoff) { a.resolved = true; a.resolvedAt = timestamp; a.expired = true; } }
  if (alertLog.length > 200) alertLog = alertLog.slice(0, 200);
  fs.writeFileSync(alertFile, JSON.stringify({ alerts: alertLog, updated: timestamp, total: alertLog.length }, null, 2));

  // 终出报告
  const report = {
    timestamp, overall_score: overallScore, status: overallStatus,
    checks: Object.fromEntries(results.map(r => [r.id, {
      status: r.status, score: r.score, errors: r.errors, delay: r.delay,
      diagnosis: r.diagnosis,
    }])),
    dataErrors, errors: [...allErrors, ...dataErrors],
  };
  const outDir = path.join(DATA_DIR, 'market_data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data_quality.json'), JSON.stringify(report, null, 2));

  // 清理旧归档
  try { const m = require('./archive-manager'); const r = m.cleanup(30); if (r) console.log(`  🗑 清理 ${r} 个过期归档`); } catch(e) {}

  console.log(`\nData Quality: ${overallScore}% ${overallStatus.toUpperCase()} | ${okCount}✅ ${warnCount}⚠️ ${errCount}❌ | 连续:${Object.entries(state).filter(([,v])=>v>0).map(([k,v])=>k+':'+v).join(',')||'无'}`);
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
    const diag = r.diagnosis ? ` [诊断: ${r.diagnosis.detail}]${r.diagnosis.fix?` → ${r.diagnosis.fix}`:''}` : '';
    console.log(`  ${icon} ${r.name}: ${r.score}%${r.delay?' +'+r.delay+'s':''}${diag}`);
  }
  if (newAlerts.length) {
    console.log(`\n🚨 新告警 (${newAlerts.length}条):`);
    for (const a of newAlerts) console.log(`  ${a.level==='critical'?'🔴':'⚠️'} ${a.message}${a.fix?` → ${a.fix}`:''}`);
  }
}

main().catch(e => { console.error('FATAL:', e.message); });
