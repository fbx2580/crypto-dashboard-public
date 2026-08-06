#!/usr/bin/env node
/**
 * P0: 进程守护 v3 — 异步+心跳，不可删除
 * 每个 daemon 独立监控，用 fs.stat 检查日志心跳，避免 execSync 阻塞
 */
const fs = require('fs');
const { spawn } = require('child_process');

const D = '/root/.openclaw/workspace/crypto-dashboard';
const LOG = '/tmp/supervisor.log';
const PID_FILE = '/tmp/supervisor.pid';
const CHECK_MS = 30000;
const HEARTBEAT_MAX = 120; // 秒，超时视为僵尸

// ─── 单实例锁 ───
try {
  const oldPid = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8')) : 0;
  if (oldPid) {
    try { process.kill(oldPid, 0); console.log('[supervisor] 已有实例 PID=' + oldPid + '，退出'); process.exit(0); }
    catch(e) { /* 旧进程已死，继续 */ }
  }
} catch(e) {}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch(e) {} });

function log(msg) {
  const ts = new Date().toISOString().slice(0,19);
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(LOG, msg + '\n');
}

// ─── 启动 daemon ───
function startDaemon(name, script, logFile) {
  try {
    const proc = spawn('node', [script], { cwd: D, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')], detached: true });
    proc.unref();
    log(`✅ ${name} 已启动 PID=${proc.pid}`);
  } catch(e) {
    log(`❌ ${name} 启动失败: ${e.message}`);
  }
}

// ─── 检查 daemon（心跳）───
function checkDaemon(name, logFile) {
  if (!fs.existsSync(logFile)) { log(`⚠️ ${name} 日志不存在，拉起...`); startDaemon(name, name + '.js', logFile); return; }
  try {
    const st = fs.statSync(logFile);
    const age = (Date.now() - st.mtimeMs) / 1000;
    if (age > HEARTBEAT_MAX) {
      log(`⚠️ ${name} ${Math.round(age)}s无心跳 (僵尸)，杀旧启新`);
      // 杀旧进程
      const { execSync } = require('child_process');
      try { execSync(`pkill -9 -f 'node.*${name}' 2>/dev/null`, { timeout: 3000 }); } catch(e) {}
      setTimeout(() => startDaemon(name, name + '.js', logFile), 2000);
    }
  } catch(e) {}
}

// ─── daemon 列表 ───
const DAEMONS = [
  { name: 'quant-server',     log: '/tmp/quant-server.log' },
  { name: 'eth-monitor',      log: '/tmp/eth-monitor.log' },
  { name: 'jin10-http',       log: '/tmp/jin10-http.log' },
  { name: 'jin10-scraper',    log: '/tmp/jin10.log' },
  { name: 'binance-fetcher',  log: '/tmp/binance-fetcher.log' },
];

log('🛡 supervisor v3 启动 (异步+心跳) PID=' + process.pid);

// 启动时检查一遍
for (const d of DAEMONS) checkDaemon(d.name, d.log);

// 每30秒检查
setInterval(() => {
  for (const d of DAEMONS) checkDaemon(d.name, d.log);
}, CHECK_MS);
