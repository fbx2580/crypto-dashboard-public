#!/usr/bin/env node
/**
 * P0: 进程守护 v2 — 不可删除
 * PID检查 + 心跳验证，双重保障
 */
const { execSync } = require('child_process');
const fs = require('fs');
const D = '/root/.openclaw/workspace/crypto-dashboard';
const LOG = '/tmp/supervisor.log';

function log(msg) {
  const ts = new Date().toISOString().slice(0,19);
  console.log(`[${ts}] ${msg}`);
  fs.appendFileSync(LOG, msg + '\n');
}

function checkDaemons() {
  // ── rt-daemon ──
  try {
    const rt = execSync('pgrep -cf rt-daemon', { encoding: 'utf8', timeout: 3000 }).trim();
    const rtCount = parseInt(rt) || 0;
    if (rtCount < 1) {
      log('⚠️ rt-daemon 挂了，拉起...');
      execSync(`cd ${D} && nohup node rt-daemon.js > /tmp/rt.log 2>&1 &`, { timeout: 5000 });
      log('✅ rt-daemon 已拉');
      return;
    }
    // 心跳检查：进程在但不输出 = 僵尸
    try {
      const rtLog = fs.statSync('/tmp/rt.log');
      const age = (Date.now() - rtLog.mtimeMs) / 1000;
      if (age > 120) {
        log(`⚠️ rt-daemon PID存在但 ${Math.round(age)}s无心跳 (僵尸)`);
        execSync('pkill -9 -f rt-daemon 2>/dev/null', { timeout: 3000 });
        execSync(`cd ${D} && nohup node rt-daemon.js > /tmp/rt.log 2>&1 &`, { timeout: 5000 });
        log('✅ rt-daemon 已杀旧启新');
      }
    } catch(e) {}
  } catch(e) { log('❌ rt检查失败'); }

  // ── jin10-http ──
  try {
    const jh = execSync('pgrep -cf jin10-http', { encoding: 'utf8', timeout: 3000 }).trim();
    const jhCount = parseInt(jh) || 0;
    if (jhCount < 1) {
      log('⚠️ jin10-http 挂了，拉起...');
      execSync(`cd ${D} && nohup node jin10-http.js > /tmp/jin10-http.log 2>&1 &`, { timeout: 5000 });
      log('✅ jin10-http 已拉');
      return;
    }
    try {
      const jhLog = fs.statSync('/tmp/jin10-http.log');
      const age = (Date.now() - jhLog.mtimeMs) / 1000;
      if (age > 120) {
        log(`⚠️ jin10-http PID存在但 ${Math.round(age)}s无心跳 (僵尸)`);
        execSync('pkill -9 -f jin10-http 2>/dev/null', { timeout: 3000 });
        execSync(`cd ${D} && nohup node jin10-http.js > /tmp/jin10-http.log 2>&1 &`, { timeout: 5000 });
        log('✅ jin10-http 已杀旧启新');
      }
    } catch(e) {}
  } catch(e) { log('❌ jin10-http检查失败'); }

  // ── jin10-scraper ──
  try {
    const j10 = execSync('pgrep -cf jin10-scraper', { encoding: 'utf8', timeout: 3000 }).trim();
    const j10Count = parseInt(j10) || 0;
    if (j10Count < 1) {
      log('⚠️ jin10-scraper 挂了，拉起...');
      execSync(`cd ${D} && nohup node jin10-scraper.js > /tmp/jin10.log 2>&1 &`, { timeout: 5000 });
      log('✅ jin10-scraper 已拉');
      return;
    }
    try {
      const j10Log = fs.statSync('/tmp/jin10.log');
      const age = (Date.now() - j10Log.mtimeMs) / 1000;
      if (age > 120) {
        log(`⚠️ jin10 PID存在但 ${Math.round(age)}s无心跳 (僵尸)`);
        execSync('pkill -9 -f jin10-scraper 2>/dev/null', { timeout: 3000 });
        execSync(`cd ${D} && nohup node jin10-scraper.js > /tmp/jin10.log 2>&1 &`, { timeout: 5000 });
        log('✅ jin10 已杀旧启新');
      }
    } catch(e) {}
  } catch(e) { log('❌ jin10检查失败'); }

  // ── eth-monitor ──
  try {
    const em = execSync('pgrep -cf eth-monitor', { encoding: 'utf8', timeout: 3000 }).trim();
    const emCount = parseInt(em) || 0;
    if (emCount < 1) {
      log('⚠️ eth-monitor 挂了，拉起...');
      execSync(`cd ${D} && nohup node eth-monitor.js > /tmp/eth-monitor.log 2>&1 &`, { timeout: 5000 });
      log('✅ eth-monitor 已拉');
      return;
    }
    try {
      const emLog = fs.statSync('/tmp/eth-monitor.log');
      const age = (Date.now() - emLog.mtimeMs) / 1000;
      if (age > 120) {
        log(`⚠️ eth-monitor PID存在但 ${Math.round(age)}s无心跳 (僵尸)`);
        execSync('pkill -9 -f eth-monitor 2>/dev/null', { timeout: 3000 });
        execSync(`cd ${D} && nohup node eth-monitor.js > /tmp/eth-monitor.log 2>&1 &`, { timeout: 5000 });
        log('✅ eth-monitor 已杀旧启新');
      }
    } catch(e) {}
  } catch(e) { log('❌ eth-monitor检查失败'); }

  // ── quant-server ──
  try {
    const qs = execSync('pgrep -cf quant-server', { encoding: 'utf8', timeout: 3000 }).trim();
    const qsCount = parseInt(qs) || 0;
    if (qsCount < 1) {
      log('⚠️ quant-server 挂了，拉起...');
      execSync(`cd ${D} && nohup node quant-server.js > /tmp/quant-server.log 2>&1 &`, { timeout: 5000 });
      log('✅ quant-server 已拉');
      return;
    }
  } catch(e) { log('❌ quant-server检查失败'); }
}

log('🛡 supervisor v2 启动 (PID+心跳)');
checkDaemons();
setInterval(checkDaemons, 30000);
