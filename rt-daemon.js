// P0: 实时数据采集 daemon — 不可修改采集间隔
// RSS: 1秒 | 鲸鱼: 1秒 | ETH: 1.5秒
const {execSync} = require('child_process');
const B = __dirname;
let n = 0;
(async () => {
  while (true) {
    n++;
    try {
      if (n % 2 === 0) execSync(`node ${B}/rss-fetcher.js`, {timeout: 8000, stdio: 'pipe'});  // 1秒
      if (n % 2 === 1) execSync(`node ${B}/whale-monitor.js`, {timeout: 8000, stdio: 'pipe'}); // 1秒
      if (n % 6 === 0) execSync(`node ${B}/eth-monitor.js`, {timeout: 8000, stdio: 'pipe'});   // 1.5秒
    } catch(e) {}
    await new Promise(r => setTimeout(r, 500)); // P0: 500ms 间隔 — 不可修改
  }
})();
