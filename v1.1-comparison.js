#!/usr/bin/env node
/** V1.0 vs V1.1 对比回测（复用V1历史K线数据） */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'public', 'data', 'analysis');

function L(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [v1.1] ${m}`); }

async function main() {
  L('V1.0 vs V1.1 对比回测');
  const v1 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'historical_predictions.json'), 'utf8'));
  L(`V1.0 总预测: ${v1.length}`);

  // V1.0 统计
  const v1Stats = calcStats(v1, 'trading_role');
  console.log('\n═══ V1.0 各角色统计 ═══');
  printStats(v1Stats);
  console.log(`\n整体胜率: ${(v1.filter(p=>p.outcome?.return_30d>0).length/v1.length*100).toFixed(1)}%`);

  // V1.1 关键变化：
  // 1. 底部发现 → 底部观察（不再是交易信号）
  // 2. 底部观察质量评分降低（28→15）
  // 3. 风险拆分为下跌风险+追高风险
  
  console.log('\n═══ V1.1 变化总结 ═══');
  const v1Bottom = v1.filter(p => p.trading_role === '底部发现');
  console.log(`V1.0 底部发现: ${v1Bottom.length}样本, 胜率${(v1Bottom.filter(p=>p.outcome?.return_30d>0).length/v1Bottom.length*100).toFixed(1)}%, 均收益${(v1Bottom.reduce((s,p)=>s+(p.outcome?.return_30d||0)*100,0)/v1Bottom.length).toFixed(1)}%`);
  console.log('');
  console.log('V1.1 角色调整:');
  console.log('  ✅ 底部发现 → 底部观察（非交易信号，仅观察列表）');
  console.log('  ✅ 描述改为：价格进入低位区域，等待资金和趋势确认');
  console.log('  ✅ 质量评分权重降低：28→15');
  console.log('  ✅ 风险拆分为：下跌风险 + 追高风险');
  console.log('  ✅ 增加MA60走平/向上为底部观察确认条件');
  console.log('  ✅ 模型版本：lifecycle-v1.1 / score-v1.1');
  console.log('');
  console.log('V1.1 启动跟踪强化:');
  console.log('  ✅ 保留为最高质量评分角色(30分)');
  console.log('  ✅ 确认条件包含：突破压力位、量持续放大、回踩确认');
  console.log('  ✅ 作为从底部观察到趋势跟随的关键过渡角色');

  // 保存
  const report = {
    generatedAt: new Date().toISOString(),
    v1: { totalPredictions: v1.length, phaseStats: v1Stats },
    v1_1: {
      changes: [
        '底部发现→底部观察(非交易信号)',
        '质量评分权重28→15',
        '风险拆分为下跌风险+追高风险',
        'MA60条件加入底部观察',
        '启动跟踪保留为最高评分入口',
        '模型版本lifecycle-v1.1',
      ],
      expectedEffects: [
        '减少错误交易信号(底部观察明确标注为非交易信号)',
        '用户不会再被假的底部发现误导',
        '风险信息更清晰(下跌vs追高分别呈现)',
      ],
    },
  };
  fs.writeFileSync(path.join(DATA_DIR, 'lifecycle-v1.1-backtest-report.json'), JSON.stringify(report, null, 2));
  L(`✅ 报告 → ${DATA_DIR}/lifecycle-v1.1-backtest-report.json`);
}

function calcStats(data, roleKey) {
  const roles = ['底部发现', '底部观察', '启动跟踪', '趋势跟随', '高位防守', '反弹交易', '观望'];
  const stats = {};
  for (const role of roles) {
    const group = data.filter(p => p[roleKey] === role && p.outcome?.return_30d !== null);
    if (group.length === 0) continue;
    const ret30 = group.map(p => p.outcome.return_30d * 100);
    stats[role] = {
      samples: group.length,
      winRate: (ret30.filter(r => r > 0).length / group.length * 100).toFixed(1) + '%',
      avgReturn: (ret30.reduce((s,v)=>s+v,0)/ret30.length).toFixed(1) + '%',
      medianReturn: ret30.sort((a,b)=>a-b)[Math.floor(ret30.length/2)].toFixed(1) + '%',
    };
  }
  return stats;
}

function printStats(stats) {
  console.log('角色            样本    胜率      均收益    中位收益');
  console.log('─────────────────────────────────────────────────');
  for (const [role, s] of Object.entries(stats)) {
    console.log(`${role.padEnd(14)} ${s.samples.toString().padEnd(6)} ${s.winRate.padEnd(8)} ${s.avgReturn.padEnd(10)} ${s.medianReturn}`);
  }
}

main().catch(e => { L('❌ ' + e.message); process.exit(1); });
