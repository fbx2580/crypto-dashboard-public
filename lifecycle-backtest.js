#!/usr/bin/env node
/**
 * 生命周期预测记录 & 自动回测模块
 *
 * 能力：
 * 1. 保存每次诊断作为预测快照
 * 2. 检查历史预测的7天/30天实际结果
 * 3. 生成阶段准确率统计
 * 4. 记录失败案例
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');
const PRED_FILE = path.join(DATA_DIR, 'lifecycle_prediction_history.json');
const BACKTEST_FILE = path.join(DATA_DIR, 'lifecycle_backtest_report.json');
const FAILED_FILE = path.join(DATA_DIR, 'lifecycle_failed_cases.json');
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const BINANCE_SPOT = 'https://api.binance.com/api/v3';

function L(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] [backtest] ${m}`); }

// ═══ 工具 ═══
async function getJSON(url, params = {}, timeout = 15000) {
  return (await axios.get(url, { params, timeout })).data;
}

async function getKlinesFrom(symbol, startMs, days = 60) {
  const symWithUSDT = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
  let raw;
  try {
    raw = await getJSON(`${BINANCE_FAPI}/klines`, { symbol: symWithUSDT, interval: '1d', startTime: startMs, limit: days + 5 });
  } catch (e) {
    try {
      raw = await getJSON(`${BINANCE_SPOT}/klines`, { symbol: symWithUSDT, interval: '1d', startTime: startMs, limit: days + 5 });
    } catch (e2) {
      return null;
    }
  }
  return raw.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
  }));
}

// ═══ 1. 保存预测快照 ═══
function savePredictions(diagnosisResults, scanTime) {
  let history = [];
  if (fs.existsSync(PRED_FILE)) {
    try { history = JSON.parse(fs.readFileSync(PRED_FILE, 'utf8')); } catch (e) {}
  }

  const newEntries = diagnosisResults.map(r => ({
    symbol: r.symbol,
    model_version: 'lifecycle-v1.0',
    score_version: 'score-v1.0',
    scan_time: scanTime || new Date().toISOString(),
    price_at_signal: r.price,
    lifecycle_stage: r.diagnosis.lifecycle_history.current?.phase || 'unknown',
    trading_role: r.diagnosis.trading_role.role,
    second_wave_potential: r.diagnosis.second_wave_potential.potential,
    accumulation_status: r.diagnosis.accumulation_status.status,
    opportunity_quality_score: r.diagnosis.scoring?.opportunity_quality_score?.score,
    trading_risk_score: r.diagnosis.scoring?.trading_risk_score?.score,
    confirmation_conditions: r.diagnosis.scoring?.confirmation_conditions || [],
    invalid_conditions: r.diagnosis.scoring?.invalid_conditions || [],
    confidence: {
      accScore: r.diagnosis.accumulation_status.score,
      waveScore: r.diagnosis.second_wave_potential.score,
    },
    factors: {
      priceVsMA60: r.diagnosis.trading_role?.metrics?.priceVsMA60 || 'N/A',
      rsi14: r.diagnosis.trading_role?.metrics?.rsi14 || 'N/A',
      ret30d: r.diagnosis.trading_role?.metrics?.ret30d || 'N/A',
      volTrend: r.diagnosis.trading_role?.metrics?.volTrend || 'N/A',
    },
    future_result: {
      status: 'pending',
      check_7d: false,
      check_30d: false,
      price_7d: null,
      price_30d: null,
      max_gain_7d_pct: null,
      max_drawdown_7d_pct: null,
      max_gain_30d_pct: null,
      max_drawdown_30d_pct: null,
      result: null,
    },
  }));

  history.push(...newEntries);
  fs.writeFileSync(PRED_FILE, JSON.stringify(history, null, 2));
  L(`✅ 保存 ${newEntries.length} 条预测 → ${PRED_FILE}`);
  return newEntries.length;
}

// ═══ 2. 自动回测：检查历史预测 ═══
async function checkPredictions() {
  if (!fs.existsSync(PRED_FILE)) {
    L('⚠ 无预测历史');
    return { checked: 0, updated: 0 };
  }

  const history = JSON.parse(fs.readFileSync(PRED_FILE, 'utf8'));
  const now = Date.now();
  const DAY_MS = 86400000;

  let checked = 0, updated = 0;

  // 只检查状态为 pending 的预测
  for (const pred of history) {
    if (pred.future_result.status !== 'pending') continue;

    const scanTime = new Date(pred.scan_time).getTime();
    const daysPassed = (now - scanTime) / DAY_MS;

    // 7天检查
    if (daysPassed >= 7 && !pred.future_result.check_7d) {
      const klines = await getKlinesFrom(pred.symbol, scanTime, 10);
      if (klines && klines.length >= 7) {
        const entryPrice = pred.price_at_signal || klines[0].close;
        const prices = klines.map(k => k.close);
        const highs = klines.map(k => k.high);
        const lows = klines.map(k => k.low);

        const price7d = prices[Math.min(6, prices.length - 1)];
        const maxHigh7d = Math.max(...highs.slice(0, 7));
        const maxLow7d = Math.min(...lows.slice(0, 7));

        pred.future_result.check_7d = true;
        pred.future_result.price_7d = price7d;
        pred.future_result.max_gain_7d_pct = ((maxHigh7d - entryPrice) / entryPrice * 100).toFixed(1);
        pred.future_result.max_drawdown_7d_pct = ((maxLow7d - entryPrice) / entryPrice * 100).toFixed(1);
        pred.future_result.price_change_7d_pct = ((price7d - entryPrice) / entryPrice * 100).toFixed(1);
        updated++;
      }
      await new Promise(r => setTimeout(r, 50));
      checked++;
    }

    // 30天检查
    if (daysPassed >= 30 && !pred.future_result.check_30d) {
      const klines = await getKlinesFrom(pred.symbol, scanTime, 35);
      if (klines && klines.length >= 30) {
        const entryPrice = pred.price_at_signal || klines[0].close;
        const prices = klines.map(k => k.close);
        const highs = klines.map(k => k.high);
        const lows = klines.map(k => k.low);

        const price30d = prices[Math.min(29, prices.length - 1)];
        const maxHigh30d = Math.max(...highs.slice(0, 30));
        const maxLow30d = Math.min(...lows.slice(0, 30));

        pred.future_result.check_30d = true;
        pred.future_result.price_30d = price30d;
        pred.future_result.max_gain_30d_pct = ((maxHigh30d - entryPrice) / entryPrice * 100).toFixed(1);
        pred.future_result.max_drawdown_30d_pct = ((maxLow30d - entryPrice) / entryPrice * 100).toFixed(1);
        pred.future_result.price_change_30d_pct = ((price30d - entryPrice) / entryPrice * 100).toFixed(1);
        updated++;
      }
      await new Promise(r => setTimeout(r, 50));
      checked++;
    }

    // 标记结果
    if (pred.future_result.check_7d || pred.future_result.check_30d) {
      const change7 = parseFloat(pred.future_result.price_change_7d_pct || '0');
      const change30 = parseFloat(pred.future_result.price_change_30d_pct || '0');

      if (pred.future_result.check_30d) {
        // 30天结果判定
        if (pred.trading_role === '底部发现' || pred.trading_role === '启动跟踪') {
          pred.future_result.result = change30 > 5 ? 'success' : change30 > -5 ? 'neutral' : 'failed';
        } else if (pred.trading_role === '趋势跟随') {
          pred.future_result.result = change30 > 3 ? 'success' : change30 > -8 ? 'neutral' : 'failed';
        } else if (pred.trading_role === '高位防守') {
          pred.future_result.result = change30 < 0 ? 'success' : change30 < 5 ? 'neutral' : 'failed';
        } else {
          pred.future_result.result = change30 > 0 ? 'success' : 'neutral';
        }
        pred.future_result.status = 'completed';
      } else if (pred.future_result.check_7d) {
        pred.future_result.status = 'partial';
      }
    }
  }

  if (updated > 0) {
    fs.writeFileSync(PRED_FILE, JSON.stringify(history, null, 2));
    L(`✅ 回测: 检查${checked}条, 更新${updated}条`);
  } else {
    L(`  回测: 检查${checked}条, 无需更新`);
  }

  return { checked, updated, total: history.length };
}

// ═══ 3. 生成阶段统计报告 ═══
function generateBacktestReport() {
  if (!fs.existsSync(PRED_FILE)) {
    L('⚠ 无预测历史，无法生成报告');
    return null;
  }

  const history = JSON.parse(fs.readFileSync(PRED_FILE, 'utf8'));
  const completed = history.filter(p => p.future_result.status === 'completed');

  if (completed.length === 0) {
    L('⚠ 无已完成预测（需30天后）');
    return { generatedAt: new Date().toISOString(), totalPredictions: history.length, completed: 0, message: '等待足够样本' };
  }

  // 按角色分组统计
  const roles = ['底部发现', '启动跟踪', '趋势跟随', '高位防守', '反弹交易', '观望'];
  const stats = {};

  for (const role of roles) {
    const group = completed.filter(p => p.trading_role === role);
    if (group.length === 0) continue;

    const successes = group.filter(p => p.future_result.result === 'success');
    const winRate = (successes.length / group.length * 100);

    const changes30 = group.map(p => parseFloat(p.future_result.price_change_30d_pct || '0'));
    const avgReturn = changes30.reduce((s, v) => s + v, 0) / changes30.length;
    const maxReturn = Math.max(...changes30);
    const maxGains = group.map(p => parseFloat(p.future_result.max_gain_30d_pct || '0'));
    const avgMaxGain = maxGains.reduce((s, v) => s + v, 0) / maxGains.length;
    const maxDrawdowns = group.map(p => parseFloat(p.future_result.max_drawdown_30d_pct || '0'));
    const avgMaxDD = maxDrawdowns.reduce((s, v) => s + v, 0) / maxDrawdowns.length;

    stats[role] = {
      samples: group.length,
      successCount: successes.length,
      winRate: winRate.toFixed(1) + '%',
      avgReturn30d: avgReturn.toFixed(1) + '%',
      maxReturn30d: maxReturn.toFixed(1) + '%',
      avgMaxGain: avgMaxGain.toFixed(1) + '%',
      avgMaxDrawdown: avgMaxDD.toFixed(1) + '%',
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalPredictions: history.length,
    completed: completed.length,
    overallWinRate: (completed.filter(p => p.future_result.result === 'success').length / completed.length * 100).toFixed(1) + '%',
    phaseStats: stats,
  };

  fs.writeFileSync(BACKTEST_FILE, JSON.stringify(report, null, 2));
  L(`✅ 回测报告 → ${BACKTEST_FILE}`);

  // 打印摘要
  console.log('\n📊 模型回测统计');
  console.log(`  总预测: ${history.length} | 已完成: ${completed.length}`);
  console.log(`  整体有效率: ${report.overallWinRate}`);
  for (const [role, s] of Object.entries(stats)) {
    console.log(`  ${role}: ${s.winRate} (${s.samples}样本) 均收益${s.avgReturn30d} 均回撤${s.avgMaxDrawdown}`);
  }

  return report;
}

// ═══ 4. 失败案例记录 ═══
function recordFailedCases() {
  if (!fs.existsSync(PRED_FILE)) return [];

  const history = JSON.parse(fs.readFileSync(PRED_FILE, 'utf8'));
  const failed = history.filter(p =>
    (p.future_result.result === 'failed') ||
    (p.future_result.check_30d && parseFloat(p.future_result.price_change_30d_pct) < -15)
  );

  if (failed.length === 0) return [];

  // 分类失败原因
  const cases = failed.map(f => {
    let category = '未知';
    const change30 = parseFloat(f.future_result.price_change_30d_pct || '0');
    const maxDD = parseFloat(f.future_result.max_drawdown_30d_pct || '0');

    if (maxDD > 30) category = 'V型反弹误判';
    else if (change30 < -20 && f.trading_role === '启动跟踪') category = '假突破';
    else if (Math.abs(change30) < 5 && f.trading_role === '趋势跟随') category = '市场横盘';
    else if (change30 < -15) category = '市场整体下跌';
    else category = '因子误判';

    return {
      symbol: f.symbol,
      scan_time: f.scan_time,
      trading_role: f.trading_role,
      price_at_signal: f.price_at_signal,
      result_30d: change30.toFixed(1) + '%',
      max_drawdown_30d: maxDD.toFixed(1) + '%',
      category,
    };
  });

  fs.writeFileSync(FAILED_FILE, JSON.stringify(cases, null, 2));
  L(`⚠ 失败案例: ${cases.length} 个 → ${FAILED_FILE}`);

  // 汇总原因
  const byCategory = {};
  for (const c of cases) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(byCategory)) {
    L(`  ${cat}: ${count}`);
  }

  return cases;
}

// ═══ 主入口 ═══
async function main() {
  if (require.main !== module) return;

  const args = process.argv.slice(2);
  const mode = args[0] || 'all';

  const t0 = Date.now();
  L('🔬 回测引擎启动');

  if (mode === 'check' || mode === 'all') {
    L('检查历史预测...');
    await checkPredictions();
  }

  if (mode === 'report' || mode === 'all') {
    L('生成统计报告...');
    generateBacktestReport();
    recordFailedCases();
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  L(`⏱ 总耗时: ${dur}s`);
}

main().catch(e => { L('❌ ' + e.message); console.error(e); process.exit(1); });

// ═══ 导出 ═══
module.exports = { savePredictions, checkPredictions, generateBacktestReport, recordFailedCases };
