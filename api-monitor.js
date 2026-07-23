// API Monitor - 追踪所有外接接口状态
// 每小时统计一次，北京时间 01:00-10:00 静默

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'data', 'api-stats.json');
const CACHE_DIR = path.join(__dirname, 'public', 'data');

// 已注册的外部接口
const ENDPOINTS = [
  { name: 'Etherscan-ETH', domain: 'api.etherscan.io', type: 'Etherscan V2', desc: 'ETH 原生转账 (proxy/eth_getBlockByNumber)' },
  { name: 'Etherscan-USDT', domain: 'api.etherscan.io', type: 'Etherscan V2', desc: 'USDT 大额转账 (tokentx)' },
  { name: 'Etherscan-USDC', domain: 'api.etherscan.io', type: 'Etherscan V2', desc: 'USDC 大额转账 (tokentx)' },
  { name: 'Mempool-BTC', domain: 'mempool.space', type: 'mempool API', desc: 'BTC 区块/交易数据' },
  { name: 'Blockchain-Info', domain: 'blockchain.info', type: 'BTC API', desc: 'BTC 原始区块数据 (备用)' },
  { name: 'Binance-Spot', domain: 'api.binance.com', type: 'Binance', desc: '币安现货行情' },
  { name: 'Binance-Futures', domain: 'fapi.binance.com', type: 'Binance', desc: '币安合约行情/K线' },
  { name: 'DeepSeek-AI', domain: 'api.deepseek.com', type: 'AI', desc: '后门聊天 AI' },
  { name: 'Jin10-快讯', domain: 'jin10.com', type: '新闻', desc: '金十财经快讯' },
  { name: 'Alternative-FNG', domain: 'api.alternative.me', type: 'CoinGecko', desc: '恐惧贪婪指数' },
  { name: 'CoinGecko', domain: 'api.coingecko.com', type: 'CoinGecko', desc: '全局市场数据' },
  { name: 'DexScreener', domain: 'api.dexscreener.com', type: 'DexScreener', desc: 'DEX 交易对数据' },
];

// 当前小时的统计
let currentHour = {
  hour: null,
  calls: {},     // { name: { total, ok, fail, latencyMs: [], errors: [] } }
};

// 总的历史统计
let allStats = { hours: [], endpoints: {} };

function load() {
  try { allStats = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  // 初始化 endpoint 索引
  for (const ep of ENDPOINTS) {
    if (!allStats.endpoints[ep.name]) {
      allStats.endpoints[ep.name] = { firstSeen: Date.now(), name: ep.name, desc: ep.desc, type: ep.type, domain: ep.domain };
    }
  }
}
load();

function getHourKey() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600000); // 北京时间
  return bj.getFullYear() + '-' + String(bj.getMonth()+1).padStart(2,'0') + '-' + String(bj.getDate()).padStart(2,'0') + ' ' + String(bj.getHours()).padStart(2,'0') + ':00';
}

function isQuietTime() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600000);
  const h = bj.getHours();
  return h >= 1 && h < 10; // 北京时间 01:00-10:00 静默
}

function recordCall(name, ok, latencyMs) {
  const hk = getHourKey();
  if (currentHour.hour !== hk) {
    // 新的一小时，保存上一小时数据
    if (currentHour.hour) {
      allStats.hours.push(currentHour);
      if (allStats.hours.length > 72) allStats.hours = allStats.hours.slice(-72); // 保持 3 天
    }
    currentHour = { hour: hk, calls: {} };
  }

  if (!currentHour.calls[name]) {
    currentHour.calls[name] = { total: 0, ok: 0, fail: 0, latencies: [], errors: [] };
  }
  const s = currentHour.calls[name];
  s.total++;
  if (ok) {
    s.ok++;
  } else {
    s.fail++;
    s.errors.push({ ts: Date.now(), err: latencyMs > 30000 ? 'TIMEOUT' : (latencyMs < 0 ? 'ERROR' : 'FAIL') });
    if (s.errors.length > 20) s.errors.shift();
  }
  s.latencies.push(latencyMs >= 0 ? latencyMs : 0);
  if (s.latencies.length > 100) s.latencies.shift();
}

function save() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600000);
  const quiet = isQuietTime();

  const report = {
    updated: Date.now(),
    bjTime: bj.toISOString().replace('T',' ').slice(0,19),
    quiet,
    endpoints: {},
    summary: { totalCalls: 0, totalOk: 0, totalFail: 0, online: 0, offline: 0 }
  };

  // 合并当前小时到 allStats
  const hk = getHourKey();
  if (currentHour.hour === hk) {
    // 查找是否已有该小时
    let found = false;
    for (const h of allStats.hours) {
      if (h.hour === hk) { found = true; h.calls = currentHour.calls; break; }
    }
    if (!found) allStats.hours.push(currentHour);
  }

  // 从最新数据往前统计所有接口状态
  const recentHours = allStats.hours.slice(-6); // 最近 6 小时
  const nowSec = Math.floor(Date.now() / 1000);
  const oneHourMs = 3600000;

  for (const ep of ENDPOINTS) {
    const name = ep.name;
    // 收集最近数据
    let totalCalls = 0, totalOk = 0, totalFail = 0, lastSeen = 0;
    const latencies = [];

    for (const h of recentHours) {
      const s = h.calls[name];
      if (s) {
        totalCalls += s.total;
        totalOk += s.ok;
        totalFail += s.fail;
        latencies.push(...s.latencies);
      }
    }

    // 如果没数据，用前一小时
    if (totalCalls === 0) {
      for (const h of allStats.hours) {
        const s = h.calls[name];
        if (s && s.total > 0) {
          totalCalls = s.total;
          totalOk = s.ok;
          totalFail = s.fail;
          latencies.push(...s.latencies);
          break;
        }
      }
    }

    // 确定是否在线（上一小时内有过成功调用）
    let status = 'unknown';
    let lastOk = 0;
    for (let i = allStats.hours.length - 1; i >= 0; i--) {
      const s = allStats.hours[i].calls[name];
      if (s && s.ok > 0) { status = 'online'; lastOk = allStats.hours[i].hour; break; }
    }
    if (totalFail > 0 && (totalFail / (totalCalls || 1)) > 0.8 && totalCalls > 5) {
      status = 'offline';
    }

    const avgLat = latencies.length ? (latencies.reduce((a,b)=>a+b, 0) / latencies.length).toFixed(0) : 0;
    const uptime = totalCalls > 0 ? (totalOk / totalCalls * 100).toFixed(1) : 0;

    report.endpoints[name] = {
      status,
      totalCalls,
      ok: totalOk,
      fail: totalFail,
      uptime: uptime + '%',
      avgLatMs: parseInt(avgLat),
      lastOk: lastOk || 'never',
      type: ep.type,
      domain: ep.domain,
      desc: ep.desc,
    };

    if (status === 'online') report.summary.online++;
    else if (status === 'offline') report.summary.offline++;
    report.summary.totalCalls += totalCalls;
    report.summary.totalOk += totalOk;
    report.summary.totalFail += totalFail;
  }

  // 写入公共目录供前端读取
  try {
    fs.mkdirSync(path.join(CACHE_DIR, 'system'), { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'system', 'api-health.json'), JSON.stringify(report, null, 2));
  } catch(e) {}

  // 保存原始数据
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(allStats, null, 2)); } catch(e) {}

  return report;
}

// 包装 axios 调用
function wrapAxios(axios) {
  const origGet = axios.get;
  const origPost = axios.post;

  axios.get = async function(url, config) {
    const start = Date.now();
    try {
      const r = await origGet.call(axios, url, config);
      const lat = Date.now() - start;
      _recordFromUrl(url, true, lat);
      return r;
    } catch(e) {
      const lat = Date.now() - start;
      _recordFromUrl(url, false, e.code === 'ECONNABORTED' ? lat + 30000 : lat);
      throw e;
    }
  };

  axios.post = async function(url, data, config) {
    const start = Date.now();
    try {
      const r = await origPost.call(axios, url, data, config);
      const lat = Date.now() - start;
      _recordFromUrl(url, true, lat);
      return r;
    } catch(e) {
      const lat = Date.now() - start;
      _recordFromUrl(url, false, e.code === 'ECONNABORTED' ? lat + 30000 : lat);
      throw e;
    }
  };
}

function _recordFromUrl(url, ok, lat) {
  const name = _matchEndpoint(url);
  if (name) recordCall(name, ok, lat);
}

function _matchEndpoint(url) {
  if (url.includes('api.etherscan.io')) {
    if (url.includes('eth_getBlockByNumber')) return 'Etherscan-ETH';
    if (url.includes('0xdAC17F958D2ee523a2206206994597C13D831ec7')) return 'Etherscan-USDT';
    if (url.includes('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')) return 'Etherscan-USDC';
    return 'Etherscan-USDT'; // default
  }
  if (url.includes('mempool.space')) return 'Mempool-BTC';
  if (url.includes('blockchain.info')) return 'Blockchain-Info';
  if (url.includes('api.binance.com')) return 'Binance-Spot';
  if (url.includes('fapi.binance.com')) return 'Binance-Futures';
  if (url.includes('api.deepseek.com')) return 'DeepSeek-AI';
  if (url.includes('jin10.com')) return 'Jin10-快讯';
  if (url.includes('api.alternative.me')) return 'Alternative-FNG';
  if (url.includes('api.coingecko.com')) return 'CoinGecko';
  if (url.includes('api.dexscreener.com')) return 'DexScreener';
  return null;
}

// 每小时检查-宕机告警
function hourlyCheck() {
  const report = save();
  if (isQuietTime()) {
    console.log('[api-mon] ⏰ 静默时段，跳过告警');
    return;
  }

  // 检查是否有接口宕机
  const offline = [];
  for (const [name, ep] of Object.entries(report.endpoints)) {
    if (ep.status === 'offline') offline.push(name);
  }

  console.log('[api-mon] 📊 小时报告 | 在线:', report.summary.online, '离线:', report.summary.offline, '调用:', report.summary.totalCalls);

  if (offline.length > 0) {
    // 检查宕机多久了
    const nowHour = getHourKey();
    const alerts = offline.map(name => {
      const ep = report.endpoints[name];
      // 找第一次失败的时间
      let failStart = null;
      for (let i = allStats.hours.length - 1; i >= 0; i--) {
        const s = allStats.hours[i].calls[name];
        if (s && s.ok === 0 && s.fail > 0) {
          failStart = allStats.hours[i].hour;
        } else if (s && s.ok > 0) {
          break;
        }
      }
      return { name, failStart: failStart || nowHour, uptime: ep.uptime, err: ep.fail };
    });

    console.log('[api-mon] 🔴 宕机接口:', alerts.map(a => a.name + '(' + a.failStart + ')').join(', '));
  }

  // 写入宕机日志
  const downLog = {
    ts: Date.now(),
    hour: getHourKey(),
    bjTime: new Date(Date.now() + 8*3600000).toISOString().slice(0,19),
    offline,
    report
  };
  try {
    fs.writeFileSync(path.join(CACHE_DIR, 'system', 'api-down.json'), JSON.stringify(downLog, null, 2));
  } catch(e) {}
}

// 定时器 - 每小时运行一次
function start() {
  console.log('[api-mon] 🩺 API 监控启动 (小时报告, 北京时间01-10静默)');

  // 立即保存一次
  save();

  // 每小时检查
  setInterval(hourlyCheck, 3600000);

  // 每天清理过旧数据
  setInterval(() => {
    if (allStats.hours && allStats.hours.length > 168) {
      allStats.hours = allStats.hours.slice(-168); // 保持 7 天
      try { fs.writeFileSync(LOG_FILE, JSON.stringify(allStats, null, 2)); } catch(e) {}
    }
  }, 86400000);
}

module.exports = { start, save, recordCall, wrapAxios, getHourKey, isQuietTime, ENDPOINTS };
