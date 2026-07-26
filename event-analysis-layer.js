#!/usr/bin/env node
/**
 * Data Layer V1 — Layer 4+5: 事件 + 新闻 + 分析报表
 * 整合已有数据源，生成每日市场状态报告
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'market_data');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [l45] ${m}`); }
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0; }

async function main() {
  L('Layer 4+5: 事件整合 + 分析报表');
  const today = new Date().toISOString().slice(0, 10);

  // ═══ Layer 4: 事件数据整合 ═══
  const events = [];

  // 4a. 鲸鱼转账
  try {
    const whaleFile = path.join(__dirname, 'public', 'data', 'whale', 'transfers.json');
    if (fs.existsSync(whaleFile)) {
      const whale = JSON.parse(fs.readFileSync(whaleFile, 'utf8'));
      const dayMs = 86400000;
      const recent = (whale.transfers || []).filter(t => Date.now() - (t.ts || 0) < dayMs);
      for (const t of recent) {
        events.push({
          time: new Date(t.ts).toISOString(),
          type: 'whale_transfer',
          chain: t.chain || 'ETH',
          value: t.val || 0,
          from: t.from || '',
          to: t.to || '',
          category: 'whale',
        });
      }
    }
  } catch(e) {}

  // 4b. 价格异动
  try {
    const alertFile = path.join(__dirname, 'public', 'data', 'alerts', 'price_alerts.json');
    if (fs.existsSync(alertFile)) {
      const alerts = JSON.parse(fs.readFileSync(alertFile, 'utf8'));
      for (const a of (alerts.alerts || []).slice(0, 20)) {
        events.push({
          time: new Date(a.time || Date.now()).toISOString(),
          type: 'price_alert',
          symbol: a.symbol || '',
          change: a.change || 0,
          level: a.level || '',
          category: 'market',
        });
      }
    }
  } catch(e) {}

  // 4c. 新闻事件
  try {
    const newsFile = path.join(__dirname, 'public', 'data', 'news', 'jin10.json');
    if (fs.existsSync(newsFile)) {
      const news = JSON.parse(fs.readFileSync(newsFile, 'utf8'));
      for (const n of (news.items || []).slice(0, 30)) {
        events.push({
          time: n.t || '',
          type: 'news',
          title: (n.body || n.title || '').slice(0, 100),
          source: 'jin10',
          category: 'news',
        });
      }
    }
  } catch(e) {}

  // ═══ Layer 5: 市场状态分析 ═══
  const latestFile = path.join(DATA_DIR, 'latest.json');
  if (!fs.existsSync(latestFile)) {
    L('⚠ market_data/latest.json 不存在，跳过分析');
    // Still save events
    saveEvents(events, today);
    return;
  }

  const mkt = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  const coinFile = path.join(DATA_DIR, 'coins', `${today}.json`);
  const coins = fs.existsSync(coinFile) ? JSON.parse(fs.readFileSync(coinFile, 'utf8')) : null;

  // === 市场状态判定 ===
  const btc = mkt.btc || {};
  const ethbtc = mkt.ethbtc || {};
  const cg = mkt.coingecko || {};
  const funding = mkt.funding || {};

  // BTC 状态
  let btcState = 'sideways';
  if (btc.price > btc.ma200) {
    btcState = btc.ret30d > 5 ? 'bull' : 'weak_bull';
  } else {
    btcState = btc.ret30d < -5 ? 'bear' : 'weak_bear';
  }
  if (btc.volatility30d > 0.60) btcState = 'risk_off';

  // 山寨环境
  let altState = 'neutral';
  if (cg.btcDominance > 60) altState = 'btc_season';
  else if (cg.btcDominance < 50 && ethbtc.ret30d > 5) altState = 'alt_season';
  else if (ethbtc.ret30d > 3) altState = 'eth_leading';

  // 资金情绪
  let sentiment = 'neutral';
  const posRatio = funding.positiveRatio || 50;
  if (posRatio > 70) sentiment = 'greedy';
  else if (posRatio < 30) sentiment = 'fearful';

  // 风险等级
  let riskLevel = 'medium';
  if (btcState === 'risk_off' || altState === 'btc_season') riskLevel = 'high';
  else if (btcState === 'bull' && altState === 'alt_season') riskLevel = 'low';

  // 建议仓位
  let suggestedPosition = '30-50%';
  if (riskLevel === 'high') suggestedPosition = '0-20%';
  else if (btcState === 'bear') suggestedPosition = '10-30%';
  else if (btcState === 'bull') suggestedPosition = '50-80%';

  const report = {
    timestamp: new Date().toISOString(),
    date: today,
    marketState: {
      btc: { state: btcState, price: btc.price, vsMA200: btc.price > btc.ma200 ? 'above' : 'below', volatility: btc.volatility30d },
      altcoin: { state: altState, btcDominance: cg.btcDominance, ethbtcRet30d: ethbtc.ret30d },
      sentiment: { state: sentiment, fundingAvg: funding.avgFunding, posRatio },
      riskLevel,
      suggestedPosition,
    },
    topMovers: coins ? {
      gainers: [...coins.coins].sort((a,b) => b.change24h - a.change24h).slice(0, 10).map(c => ({ symbol: c.symbol, change24h: c.change24h, price: c.price, volume24h: c.volume24h })),
      losers: [...coins.coins].sort((a,b) => a.change24h - b.change24h).slice(0, 10).map(c => ({ symbol: c.symbol, change24h: c.change24h, price: c.price, volume24h: c.volume24h })),
      topVolume: [...coins.coins].sort((a,b) => b.volume24h - a.volume24h).slice(0, 10).map(c => ({ symbol: c.symbol, volume24h: c.volume24h, change24h: c.change24h })),
      extremeFunding: [...coins.coins].filter(c => Math.abs(c.fundingRate) > 0.005).sort((a,b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate)).slice(0, 5).map(c => ({ symbol: c.symbol, fundingRate: c.fundingRate, change24h: c.change24h })),
    } : null,
    events: events.slice(0, 50),
    eventsByCategory: {
      whale: events.filter(e => e.category === 'whale').length,
      market: events.filter(e => e.category === 'market').length,
      news: events.filter(e => e.category === 'news').length,
    },
  };

  // 保存分析报告
  const analysisDir = path.join(DATA_DIR, 'analysis');
  if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(path.join(analysisDir, `${today}.json`), JSON.stringify(report, null, 2));

  // 摘要
  fs.writeFileSync(path.join(DATA_DIR, 'market_report_latest.json'), JSON.stringify({
    timestamp: report.timestamp,
    date: report.date,
    btcState: report.marketState.btc.state,
    altState: report.marketState.altcoin.state,
    sentiment: report.marketState.sentiment.state,
    riskLevel: report.marketState.riskLevel,
    suggestedPosition: report.marketState.suggestedPosition,
    topGainer: report.topMovers?.gainers?.[0]?.symbol || 'N/A',
    topLoser: report.topMovers?.losers?.[0]?.symbol || 'N/A',
    eventsToday: events.length,
  }, null, 2));

  saveEvents(events, today);

  // ===== 打印 =====
  console.log('\n' + '═'.repeat(55));
  console.log(`📊 市场分析报告 — ${today}`);
  console.log('═'.repeat(55));
  console.log(`\n🪙 BTC: ${btcState.toUpperCase()} | $${btc.price?.toFixed(0) || 'N/A'}`);
  console.log(`🌐 山寨: ${altState.toUpperCase()} | BTC.D ${cg.btcDominance?.toFixed(1) || 'N/A'}%`);
  console.log(`😱 情绪: ${sentiment.toUpperCase()} | 风险: ${riskLevel.toUpperCase()}`);
  console.log(`📦 建议仓位: ${suggestedPosition}`);
  console.log(`\n📈 今日涨幅Top3: ${report.topMovers?.gainers?.slice(0,3).map(c=>c.symbol+'+'+c.change24h.toFixed(0)+'%').join(' ')}`);
  console.log(`📉 今日跌幅Top3: ${report.topMovers?.losers?.slice(0,3).map(c=>c.symbol+c.change24h.toFixed(0)+'%').join(' ')}`);
  console.log(`📰 事件: ${events.length}条 (鲸鱼${report.eventsByCategory.whale} 行情${report.eventsByCategory.market} 新闻${report.eventsByCategory.news})`);

  L(`✅ 分析报告 → ${analysisDir}/${today}.json`);
}

function saveEvents(events, today) {
  const eventDir = path.join(DATA_DIR, 'events');
  if (!fs.existsSync(eventDir)) fs.mkdirSync(eventDir, { recursive: true });
  fs.writeFileSync(path.join(eventDir, `${today}.json`), JSON.stringify({
    timestamp: new Date().toISOString(), date: today, events,
  }, null, 2));
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
