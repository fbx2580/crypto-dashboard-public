#!/usr/bin/env node
/**
 * 市场扫描模块（供 lifecycle-diagnosis-v2.js 使用）
 *
 * 能力：
 * 1. 获取币安全量 USDT 交易对
 * 2. 获取每个交易对的基础数据（价格、成交量、市值）
 * 3. 基础过滤（流动性、已下架）
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';

function L(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] [scanner] ${m}`); }

async function getJSON(url, params = {}, timeout = 15000) {
  return (await axios.get(url, { params, timeout })).data;
}

// 主流币 + 稳定币，不参与扫描（或单独处理）
const SKIP_SYMBOLS = new Set([
  'USDC', 'DAI', 'TUSD', 'BUSD', 'USDP', 'FDUSD', 'USDE', 'USDD',
  'FRAX', 'LUSD', 'GUSD', 'MIM', 'USTC', 'sUSD', 'USDX', 'USR',
  'EURS', 'EURC', 'AEUR', 'crvUSD', 'GHO', 'PYUSD', 'XUSD', 'BFUSD',
  'USDS', 'USDCUSDT', 'DAIUSDT', 'TUSDUSDT', 'BUSDUSDT',
]);

// ═══ 1. 获取全量 USDT 交易对 ═══
async function fetchAllSymbols(options = {}) {
  const { includeSpot = true, includeFutures = true, excludeStablecoins = true } = options;
  const symbols = [];

  let futuresCount = 0, spotCount = 0;

  // 合约
  if (includeFutures) {
    try {
      const info = await getJSON(`${BINANCE_FAPI}/exchangeInfo`);
      for (const s of (info.symbols || [])) {
        if (s.quoteAsset !== 'USDT') continue;
        if (s.status !== 'TRADING') continue;
        if (s.contractType !== 'PERPETUAL') continue;
        const base = s.baseAsset;
        if (excludeStablecoins && SKIP_SYMBOLS.has(base)) continue;
        symbols.push({ symbol: s.symbol, baseAsset: base, market: 'futures', hasFutures: true });
        futuresCount++;
      }
      L(`合约: ${futuresCount} 个 USDT 永续`);
    } catch (e) {
      L(`⚠ 合约交易对获取失败: ${e.message}`);
    }
  }

  // 现货（去重 + 标记）
  if (includeSpot) {
    try {
      const seen = new Set(symbols.map(s => s.baseAsset));
      const info = await getJSON(`${BINANCE_SPOT}/exchangeInfo`);
      for (const s of (info.symbols || [])) {
        if (s.quoteAsset !== 'USDT') continue;
        if (s.status !== 'TRADING') continue;
        const base = s.baseAsset;
        if (excludeStablecoins && SKIP_SYMBOLS.has(base)) continue;
        if (seen.has(base)) {
          // 合约已存在，标记为同时支持合约
          const existing = symbols.find(x => x.baseAsset === base);
          if (existing) existing.hasSpot = true;
          continue;
        }
        symbols.push({ symbol: s.symbol, baseAsset: base, market: 'spot', hasFutures: false, hasSpot: true });
        spotCount++;
      }
      L(`现货: ${spotCount} 个（仅现货，去重后）`);
    } catch (e) {
      L(`⚠ 现货交易对获取失败: ${e.message}`);
    }
  }

  return {
    symbols,
    spotCount,
    futuresCount,
    totalUnique: symbols.length,
  };
}

// ═══ 2. 批量获取 ticker 基础数据 ═══
async function fetchTickers(symbols, isFutures = true) {
  const baseUrl = isFutures ? BINANCE_FAPI : BINANCE_SPOT;
  const results = {};

  // 批量拉取价格和成交量
  try {
    const tickers = await getJSON(`${baseUrl}/ticker/24hr`);
    for (const t of (tickers || [])) {
      const sym = t.symbol;
      results[sym] = {
        price: parseFloat(t.lastPrice || 0),
        change24h: parseFloat(t.priceChangePercent || 0),
        high24h: parseFloat(t.highPrice || 0),
        low24h: parseFloat(t.lowPrice || 0),
        volume24h: parseFloat(t.quoteVolume || 0), // USDT 计价成交量
        trades: parseInt(t.count || 0),
      };
    }
  } catch (e) {
    L(`⚠ ticker 批量获取失败: ${e.message}`);
  }

  return results;
}

// ═══ 3. 基础过滤 ═══
function filterByLiquidity(symbols, tickers, minVolume24h = 50000) {
  const filtered = [];
  const skipped = { lowVol: 0, noData: 0 };

  for (const s of symbols) {
    const t = tickers[s.symbol];
    if (!t) { skipped.noData++; continue; }
    if (t.volume24h < minVolume24h) { skipped.lowVol++; continue; }
    filtered.push({ ...s, ticker: t });
  }

  L(`过滤: ${filtered.length} 通过 (低量${skipped.lowVol} 无数据${skipped.noData})`);
  return { filtered, skipped };
}

// ═══ 4. 获取币安合约资金费率（辅助判断市场情绪） ═══
async function fetchFundingRates() {
  try {
    const data = await getJSON(`${BINANCE_FAPI}/premiumIndex`);
    const map = {};
    for (const p of (data || [])) {
      map[p.symbol] = parseFloat(p.lastFundingRate || 0);
    }
    return map;
  } catch (e) {
    return {};
  }
}

// ═══ 5. 扫描优先级评分（替代硬截断） ═══
// 评分因素：24h成交量、量变化、波动异常、接近历史低位、资金费率
function calcPriorityScore(ticker, fundingRate = 0) {
  let score = 0;

  // 24h 成交量（非稳定币里量大的优先）
  const vol24h = ticker.volume24h || 0;
  if (vol24h > 100e6) score += 20;          // 1亿+
  else if (vol24h > 10e6) score += 15;       // 1000万+
  else if (vol24h > 1e6) score += 10;        // 100万+
  else if (vol24h > 100e3) score += 5;       // 10万+

  // 24h 涨跌幅异常（大涨或大跌可能意味着机会）
  const absChange = Math.abs(ticker.change24h || 0);
  if (absChange > 20) score += 15;
  else if (absChange > 10) score += 12;
  else if (absChange > 5) score += 8;
  else if (absChange > 2) score += 5;

  // 24h 震幅（高振幅意味着活跃）
  const high = ticker.high24h || 0;
  const low = ticker.low24h || 0;
  const price = ticker.price || 0;
  const amplitude = price > 0 ? (high - low) / price : 0;
  if (amplitude > 0.20) score += 10;
  else if (amplitude > 0.10) score += 7;
  else if (amplitude > 0.05) score += 4;

  // 资金费率极端（正极高=市场过热/做空挤仓，负极低=恐慌/做空机会）
  if (Math.abs(fundingRate) > 0.005) score += 5;
  else if (Math.abs(fundingRate) > 0.001) score += 3;

  // 交易笔数（活跃度）
  const trades = ticker.trades || 0;
  if (trades > 50000) score += 5;
  else if (trades > 10000) score += 3;

  return score;
}

module.exports = {
  fetchAllSymbols,
  fetchTickers,
  filterByLiquidity,
  fetchFundingRates,
  calcPriorityScore,
  SKIP_SYMBOLS,
};
