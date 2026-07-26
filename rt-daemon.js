// P0: 实时数据采集 daemon — 不可修改采集间隔
// RSS: 每1秒 | 鲸鱼: 每1秒 | ETH: 每1秒
const {execSync} = require('child_process');
const B = __dirname;

// 三个并行，各自独立1秒间隔
let tick=0;
function heartbeat(){tick++;console.log(`[rt] 💓 ${new Date().toISOString().slice(11,19)} #${tick}`)}
setInterval(heartbeat,30000); heartbeat();
async function rssLoop() { while(1){try{execSync(`node ${B}/rss-fetcher.js`,{timeout:8000,stdio:'pipe'})}catch(e){}await new Promise(r=>setTimeout(r,1000))} }
async function whaleLoop() { while(1){try{execSync(`node ${B}/whale-monitor.js`,{timeout:8000,stdio:'pipe'})}catch(e){}await new Promise(r=>setTimeout(r,1000))} }
async function ethLoop() { while(1){try{execSync(`node ${B}/eth-monitor.js`,{timeout:8000,stdio:'pipe'})}catch(e){}await new Promise(r=>setTimeout(r,1000))} }

rssLoop(); whaleLoop(); ethLoop();
