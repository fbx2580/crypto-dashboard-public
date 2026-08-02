// P0: 实时数据采集 daemon — 不可修改采集间隔
// RSS: 每1秒 | 鲸鱼: 每1秒 | ETH: 每1秒
const {spawn} = require('child_process');
const B = __dirname;

// execSync timeout 后子进程可能泄漏 → 改用 spawn + 强制 SIGKILL
function runOne(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn('node', [script], {
      cwd: B,
      stdio: 'pipe',
      detached: false,
    });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGKILL');
        resolve();
      }
    }, timeoutMs);
    child.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

let tick = 0;
function heartbeat() { tick++; console.log(`[rt] 💓 ${new Date().toISOString().slice(11,19)} #${tick}`); }
setInterval(heartbeat, 30000); heartbeat();

async function rssLoop() { while (1) { await runOne(`${B}/rss-fetcher.js`); await new Promise(r => setTimeout(r, 1000)); } }
async function whaleLoop() { while (1) { await runOne(`${B}/whale-monitor.js`); await new Promise(r => setTimeout(r, 1000)); } }
async function ethLoop() { while (1) { await runOne(`${B}/eth-monitor.js`); await new Promise(r => setTimeout(r, 1000)); } }

rssLoop(); whaleLoop(); ethLoop();
