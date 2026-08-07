/**
 * 社媒情绪采集模块 - Reddit RSS + 简单情绪分析
 * 数据源: Reddit RSS (无需认证)
 * 输出: 币种提及量 + 情绪评分
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');

// 监控的子版块（只保留核心，避免Reddit限流）
const SUBREDDITS = [
  'CryptoCurrency',
  'CryptoMarkets',
];

// 币种关键词映射（Reddit上常见的称呼 -> 标准符号）
const COIN_KEYWORDS = {
  // 主流
  'BTC': ['btc', 'bitcoin'],
  'ETH': ['eth', 'ethereum'],
  'SOL': ['sol', 'solana'],
  'BNB': ['bnb', 'binance coin'],
  'XRP': ['xrp', 'ripple'],
  'ADA': ['ada', 'cardano'],
  'DOGE': ['doge', 'dogecoin'],
  'DOT': ['dot', 'polkadot'],
  'AVAX': ['avax', 'avalanche'],
  'MATIC': ['matic', 'polygon'],
  'LINK': ['link', 'chainlink'],
  'UNI': ['uni', 'uniswap'],
  'ATOM': ['atom', 'cosmos'],
  'NEAR': ['near', 'near protocol'],
  'OP': ['op', 'optimism'],
  'ARB': ['arb', 'arbitrum'],
  'APT': ['apt', 'aptos'],
  'SUI': ['sui'],
  'SEI': ['sei'],
  'TIA': ['tia', 'celestia'],
  'INJ': ['inj', 'injective'],
  'RNDR': ['rndr', 'render'],
  'TAO': ['tao', 'bittensor'],
  'FET': ['fet', 'fetch'],
  'PENDLE': ['pendle'],
  'ENA': ['ena', 'ethena'],
  'WIF': ['wif', 'dogwifhat'],
  'BONK': ['bonk'],
  'PEPE': ['pepe'],
  'FLOKI': ['floki'],
  'SHIB': ['shib', 'shiba'],
  'LDO': ['ldo', 'lido'],
  'AAVE': ['aave'],
  'MKR': ['mkr', 'maker'],
  'SNX': ['snx', 'synthetix'],
  'CRV': ['crv', 'curve'],
  'GMX': ['gmx'],
  'DYDX': ['dydx'],
  'RUNE': ['rune', 'thorchain'],
  'FTM': ['ftm', 'fantom'],
  'ALGO': ['algo', 'algorand'],
  'FIL': ['fil', 'filecoin'],
  'ICP': ['icp', 'internet computer'],
  'GRT': ['grt', 'the graph'],
  'IMX': ['imx', 'immutable'],
  'STRK': ['strk', 'starknet'],
  'JUP': ['jup', 'jupiter'],
  'PYTH': ['pyth', 'pyth network'],
  'WLD': ['wld', 'worldcoin'],
  'ORDI': ['ordi'],
  'SATS': ['sats'],
  'STX': ['stx', 'stacks'],
  'CFX': ['cfx', 'conflux'],
};

// 情绪关键词
const BULLISH_WORDS = [
  'bullish', 'moon', 'pump', 'breakout', 'rally', 'surge', 'soar', 'rocket',
  'buy', 'long', 'accumulat', 'bottom', 'undervalued', 'gem', 'potential',
  'upgrade', 'partnership', 'launch', 'adoption', 'institutional', 'etf',
  'green', 'green dildo', 'ATH', 'new high', 'support', 'bounce',
];

const BEARISH_WORDS = [
  'bearish', 'dump', 'crash', 'collapse', 'rug', 'scam', 'hack', 'exploit',
  'sell', 'short', 'resistance', 'top', 'overvalued', 'bubble', 'correction',
  'delist', 'SEC', 'regulation', 'ban', 'shutdown', 'FUD', 'fud',
  'red', 'red dildo', 'capitulat', 'death', 'die', 'dead',
];

// 社交媒体情绪数据存储
const DATA_DIR = path.join(__dirname, '..', 'public', 'data', 'social');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 解析RSS XML
 */
function parseRSS(xml) {
  const entries = [];
  // 简单regex解析RSS（避免重量级xml解析器）
  const itemRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const id = (item.match(/<id[^>]*>([\s\S]*?)<\/id>/) || [])[1] || '';
    const updated = (item.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1] || '';
    entries.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'), id, updated });
    if (entries.length >= 25) break;
  }
  return entries;
}

/**
 * 分析单条标题的情绪
 */
function analyzeTitleSentiment(title) {
  const lower = title.toLowerCase();
  let bullish = 0, bearish = 0;

  for (const w of BULLISH_WORDS) {
    if (lower.includes(w)) bullish++;
  }
  for (const w of BEARISH_WORDS) {
    if (lower.includes(w)) bearish++;
  }

  return { bullish, bearish, net: bullish - bearish };
}

/**
 * 提取标题中提到的币种
 */
function extractCoinMentions(title) {
  const lower = title.toLowerCase();
  const mentions = [];

  for (const [symbol, keywords] of Object.entries(COIN_KEYWORDS)) {
    for (const kw of keywords) {
      // 单词边界匹配，避免 "the" 匹配 "ethereum" 部分
      const regex = new RegExp(`\\b${kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lower)) {
        mentions.push(symbol);
        break; // 一个币种只计数一次
      }
    }
  }

  return mentions;
}

/**
 * 从多个子版块拉取帖子（带限流控制）
 */
async function fetchAllSubreddits() {
  const allEntries = [];
  const UAS = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'tuhasen-crypto-dashboard/1.0 (by u/tuhasen)',
  ];

  for (let i = 0; i < SUBREDDITS.length; i++) {
    const sub = SUBREDDITS[i];
    const headers = { 'User-Agent': UAS[i % UAS.length] };
    try {
      // Reddit 公开API限流
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
      const url = `https://www.reddit.com/r/${sub}/.rss?limit=25`;
      const resp = await axios.get(url, { headers, timeout: 15000 });
      const entries = parseRSS(resp.data);
      for (const e of entries) {
        e.subreddit = sub;
      }
      allEntries.push(...entries);
      console.log(`[social] r/${sub}: ${entries.length} posts`);
    } catch (e) {
      const status = e.response?.status || e.code || e.message;
      console.log(`[social] r/${sub}: FAILED (${status})`);
      // 429后多等一会
      if (e.response?.status === 429) await new Promise(r => setTimeout(r, 10000));
    }
  }

  return allEntries;
}

/**
 * 聚合情绪数据
 */
function aggregateSentiment(entries) {
  const coinStats = {}; // symbol -> { mentions, bullish, bearish, posts }

  for (const entry of entries) {
    const sentiment = analyzeTitleSentiment(entry.title);
    const mentions = extractCoinMentions(entry.title);

    for (const symbol of mentions) {
      if (!coinStats[symbol]) {
        coinStats[symbol] = { symbol, mentions: 0, bullish: 0, bearish: 0, posts: 0 };
      }
      coinStats[symbol].mentions++;
      coinStats[symbol].bullish += sentiment.bullish;
      coinStats[symbol].bearish += sentiment.bearish;
      coinStats[symbol].posts++;
    }
  }

  // 计算情绪分数：净看涨占比，归一化到 -1 ~ 1
  const results = Object.values(coinStats).map(s => {
    const total = s.bullish + s.bearish;
    const netScore = total > 0 ? (s.bullish - s.bearish) / total : 0;
    return {
      ...s,
      sentiment: parseFloat(netScore.toFixed(2)),
      // 热度 = 提及次数（可加权子版块）
      heat: s.mentions,
    };
  });

  // 按热度排序
  results.sort((a, b) => b.heat - a.heat);

  return results;
}

/**
 * CoinGecko Trending 采集
 */
async function fetchCoinGeckoTrending() {
  try {
    const resp = await axios.get('https://api.coingecko.com/api/v3/search/trending', { timeout: 15000 });
    const coins = (resp.data?.coins || []).map(c => ({
      symbol: (c.item?.symbol || '').toUpperCase(),
      name: c.item?.name || '',
      mcapRank: c.item?.market_cap_rank || 9999,
      score: c.item?.score || 0,
    }));
    console.log(`[social] CoinGecko Trending: ${coins.length} coins`);
    return coins;
  } catch (e) {
    console.log(`[social] CoinGecko: FAILED - ${e.code || e.message}`);
    return [];
  }
}

/**
 * Santiment Trending Words 采集
 */
async function fetchSantimentTrending() {
  try {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const query = `{ getTrendingWords(size: 30, from: "${yesterday}", to: "${now}", interval: "1d") { datetime topWords { word score } } }`;
    const resp = await axios.post('https://api.santiment.net/graphql', { query }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const tw = resp.data?.data?.getTrendingWords;
    if (!tw || !tw.length) return [];
    const words = tw[0].topWords || [];
    console.log(`[social] Santiment Trending: ${words.length} words`);
    return words.map(w => ({ word: w.word.toLowerCase(), score: w.score }));
  } catch (e) {
    console.log(`[social] Santiment: FAILED - ${e.code || e.message}`);
    return [];
  }
}

/**
 * 统一社媒情绪评分（融合三源）
 */
function mergeSocialScores(redditSentiment, cgTrending, santimentTrending) {
  const scores = {}; // symbol -> composite score

  // Reddit: 热度 + 情绪
  for (const s of redditSentiment) {
    if (!scores[s.symbol]) scores[s.symbol] = { symbol: s.symbol, redditHeat: 0, redditSent: 0, cgScore: 0, santimentScore: 0, composite: 0 };
    scores[s.symbol].redditHeat = s.heat;
    scores[s.symbol].redditSent = s.sentiment;
  }

  // CoinGecko Trending: score 越大越靠前（CG用越小越靠前，转换）
  for (let i = 0; i < cgTrending.length; i++) {
    const c = cgTrending[i];
    if (!scores[c.symbol]) scores[c.symbol] = { symbol: c.symbol, redditHeat: 0, redditSent: 0, cgScore: 0, santimentScore: 0, composite: 0 };
    // score: rank 1 = 15分, rank 15 = 1分
    scores[c.symbol].cgScore = Math.max(0, cgTrending.length - i);
  }

  // Santiment: 匹配词到币种
  for (const sw of santimentTrending) {
    for (const [symbol, keywords] of Object.entries(COIN_KEYWORDS)) {
      if (keywords.some(kw => kw === sw.word || sw.word.includes(kw) || kw.includes(sw.word))) {
        if (!scores[symbol]) scores[symbol] = { symbol, redditHeat: 0, redditSent: 0, cgScore: 0, santimentScore: 0, composite: 0 };
        scores[symbol].santimentScore += sw.score;
        break;
      }
    }
  }

  // 计算综合分：归一化后加权
  const entries = Object.values(scores);
  const maxReddit = Math.max(1, ...entries.map(e => e.redditHeat));
  const maxCG = Math.max(1, ...entries.map(e => e.cgScore));
  const maxSantiment = Math.max(1, ...entries.map(e => e.santimentScore));

  for (const e of entries) {
    e.redditNorm = parseFloat((e.redditHeat / maxReddit).toFixed(2));
    e.cgNorm = parseFloat((e.cgScore / maxCG).toFixed(2));
    e.santimentNorm = parseFloat((Math.min(e.santimentScore / maxSantiment, 1)).toFixed(2));
    // 加权: Reddit 40% + CG Trending 30% + Santiment 30%
    e.composite = parseFloat((e.redditNorm * 0.4 + e.cgNorm * 0.3 + e.santimentNorm * 0.3).toFixed(3));
  }

  entries.sort((a, b) => b.composite - a.composite);
  return entries;
}

/**
 * 主采集函数
 */
async function collectSocialSentiment() {
  console.log('[social] 开始多源社媒采集...');

  // 并行拉三个数据源
  const [entries, cgTrending, santimentTrending] = await Promise.all([
    fetchAllSubreddits(),
    fetchCoinGeckoTrending(),
    fetchSantimentTrending(),
  ]);

  const redditSentiment = aggregateSentiment(entries);
  const merged = mergeSocialScores(redditSentiment, cgTrending, santimentTrending);

  const result = {
    timestamp: Date.now(),
    sources: {
      reddit: { posts: entries.length, subreddits: [...new Set(entries.map(e => e.subreddit))], coinMentions: redditSentiment.length },
      coingecko: { trending: cgTrending.length },
      santiment: { words: santimentTrending.length },
    },
    sentiment: merged,
    redditRaw: redditSentiment,
    cgRaw: cgTrending,
    santimentRaw: santimentTrending.slice(0, 15),
    recentPosts: entries.slice(0, 50).map(e => ({
      title: e.title,
      subreddit: e.subreddit,
      time: e.updated,
      coins: extractCoinMentions(e.title),
    })),
  };

  const file = path.join(DATA_DIR, 'latest.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[social] 完成: Reddit ${entries.length}帖 + CG ${cgTrending.length}热门 + Santiment ${santimentTrending.length}词 -> ${merged.length}币种`);

  // 历史快照
  const archiveDir = path.join(DATA_DIR, 'archive');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const archiveFile = path.join(archiveDir, `${dateStr}.json`);
  let archive = [];
  if (fs.existsSync(archiveFile)) {
    try { archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8')); } catch(e) {}
  }
  archive.push({
    timestamp: result.timestamp,
    sources: result.sources,
    topCoins: merged.slice(0, 20).map(s => ({
      symbol: s.symbol, composite: s.composite,
      reddit: s.redditNorm, cg: s.cgNorm, santiment: s.santimentNorm,
    })),
  });
  if (archive.length > 24) archive = archive.slice(-24);
  fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2));

  return result;
}

/**
 * API 路由
 */
function createRouter() {
  const router = require('express').Router();

  // 获取最新社媒情绪
  router.get('/sentiment', (req, res) => {
    try {
      const file = path.join(DATA_DIR, 'latest.json');
      if (fs.existsSync(file)) {
        return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      res.json({ timestamp: Date.now(), totalPosts: 0, sentiment: [], recentPosts: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 获取历史趋势
  router.get('/trend/:symbol', (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const archiveDir = path.join(DATA_DIR, 'archive');
      const trend = [];
      if (fs.existsSync(archiveDir)) {
        const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json')).sort();
        for (const f of files.slice(-7)) { // 最近7天
          const archive = JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
          for (const snap of archive) {
            const coin = snap.sentiment.find(s => s.symbol === symbol);
            if (coin) {
              trend.push({
                time: snap.timestamp,
                mentions: coin.mentions,
                sentiment: coin.sentiment,
              });
            }
          }
        }
      }
      res.json({ symbol, trend });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// 直接运行
if (require.main === module) {
  collectSocialSentiment().then(() => {
    console.log('[social] 采集完成');
    process.exit(0);
  }).catch(e => {
    console.error('[social] 采集失败:', e);
    process.exit(1);
  });
}

module.exports = { collectSocialSentiment, createRouter };
