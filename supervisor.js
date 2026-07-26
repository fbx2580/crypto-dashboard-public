#!/usr/bin/env node
/**
 * P0: 进程守护 — 不可删除
 * 每30秒巡检 rt-daemon 和 jin10-scraper，死了就自动拉起
 */
const { execSync } = require('child_process');
const fs = require('fs');
const D = '/root/.openclaw/workspace/crypto-dashboard';
const LOG = '/tmp/supervisor.log';

function log(msg) {
  const ts = new Date().toISOString().slice(0,19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

function checkDaemons() {
  try {
    // rt-daemon
    const rt = execSync('pgrep -cf rt-daemon', { encoding: 'utf8', timeout: 3000 }).trim();
    const rtCount = parseInt(rt) || 0;
    if (rtCount < 1) {
      log(`⚠️ rt-daemon 挂了，拉起...`);
      execSync(`cd ${D} && nohup node rt-daemon.js > /tmp/rt.log 2>&1 &`, { timeout: 5000 });
      log('✅ rt-daemon 已拉');
    }
  } catch(e) { log('❌ rt-daemon检查失败: '+e.message); }

  try {
    // jin10
    const j10 = execSync('pgrep -cf jin10-scraper', { encoding: 'utf8', timeout: 3000 }).trim();
    const j10Count = parseInt(j10) || 0;
    if (j10Count < 1) {
      log(`⚠️ jin10-scraper 挂了，拉起...`);
      execSync(`cd ${D} && nohup node jin10-scraper.js > /tmp/jin10.log 2>&1 &`, { timeout: 5000 });
      log('✅ jin10-scraper 已拉');
    }
  } catch(e) { log('❌ jin10检查失败: '+e.message); }
}

// 立即检查一次，然后每30秒
log('🛡 supervisor 启动');
checkDaemons();
setInterval(checkDaemons, 30000);
