// ─── 吸筹雷达 Dashboard ───
let _radarData = null;
async function refreshAccumulationMonitor() {
  try {
    const [rd, ov] = await Promise.all([
      fetch('/api/accumulation/radar').then(r => r.json()),
      fetch('/api/market/overview').then(r => r.json()),
    ]);
    _radarData = rd;
    const results = rd.results || [];
    const tiers = rd.tiers || {};
    const regime = results[0]?.marketRegime || 'neutral';
    const btcP = ov.crypto?.btcPrice || 0;

    // ① 市场环境
    const rLabels = { strong_bull:'🟢 强牛 · 突破跟随优先', bull:'🟢 牛市 · 双模型并行', neutral:'⚪ 中性 · 吸筹布局优先', bear:'🔴 熊市 · 仅吸筹布局', panic:'🛑 恐慌 · 暂停新仓' };
    document.getElementById('radarEnv').querySelector('.radar-card-bd').innerHTML =
      '<div style="font-size:13px;font-weight:700;">' + (rLabels[regime] || regime) + '</div>' +
      '<div style="font-size:10px;color:var(--text-dim);margin-top:4px;">BTC $' + btcP.toLocaleString('en') + ' | 当前策略: ' + (regime.includes('bull') ? '双模型' : '吸筹布局(A)') + '</div>';

    // ② 总览
    document.getElementById('radarHighCount').innerHTML = '🔥<b>' + (tiers.high || 0) + '</b>';
    document.getElementById('radarCandCount').innerHTML = '⭐<b>' + (tiers.candidate || 0) + '</b>';
    document.getElementById('radarWatchCount').innerHTML = '👀<b>' + (tiers.watch || 0) + '</b>';

    // ③ 候选池
    const pool = document.getElementById('radarPool');
    if (pool && results.length) {
      let html = '';
      for (const r of results.slice(0, 30)) {
        const scClr = r.total >= 90 ? '#22c55e' : r.total >= 70 ? '#f0b90b' : 'var(--text-dim)';
        const b = r.breakdown || {};
        const dd = (b.drawdown || {}).label || '?';
        const tt = (b.time || {}).label || '?';
        const risks = r.risks || [];
        const riskTxt = risks.length ? ' ⚠' + risks.length : '';
        html += '<div class="radar-row" onclick="showRadarDetail(\'' + r.symbol + '\')">' +
          '<span class="radar-tier-badge" style="color:' + scClr + '">' + (r.total >= 90 ? '🔥' : r.total >= 70 ? '⭐' : '👀') + '</span>' +
          '<span style="width:70px;font-weight:700;">' + r.symbol + '</span>' +
          '<b style="color:' + scClr + ';width:30px;">' + r.total + '分</b>' +
          '<span style="flex:1;"><span class="radar-score-bar"><span class="radar-score-fill" style="width:' + r.total + '%;background:' + scClr + ';"></span></span></span>' +
          '<span style="font-size:9px;color:var(--text-dim);">' + dd + ' ' + tt + riskTxt + '</span>' +
          '</div>';
      }
      pool.innerHTML = html;
    }

    // ⑤ 历史验证
    const trackBody = document.getElementById('radarTrackBody');
    document.getElementById('radarTrackUpdate').textContent = '更新于' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (trackBody) {
      trackBody.innerHTML = '<div style="font-size:10px;color:var(--text-dim);line-height:1.6;">' +
        '<b>7日追踪:</b> 数据积累中（需≥7天历史快照）<br>' +
        '<b>30日追踪:</b> 数据积累中（需≥30天历史快照）<br>' +
        '<b>60日追踪:</b> 数据积累中（需≥60天历史快照）<br>' +
        '<br>每日中午12:00 UTC自动更新。' +
        '</div>';
    }
  } catch (e) {}
}

// ═══ 币种详情展开 ═══
function showRadarDetail(sym) {
  if (!_radarData) return;
  const r = (_radarData.results || []).find(x => x.symbol === sym);
  if (!r) return;
  const detail = document.getElementById('radarDetail');
  const body = document.getElementById('radarDetailBody');
  if (!detail || !body) return;
  const b = r.breakdown || {};
  const risks = r.risks || [];
  const ddPct = (b.drawdown?.value || 0);
  const scoreClr = r.total >= 90 ? '#22c55e' : r.total >= 70 ? '#f0b90b' : 'var(--text-dim)';

  let html = '';

  // ===== ① 顶部概览 =====
  html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0 8px;">';
  html += '<div>';
  html += '<span style="font-size:16px;font-weight:800;">' + r.symbol + '</span>';
  html += '<span style="font-size:10px;color:var(--text-dim);margin-left:6px;">$' + (r.price || 0).toFixed(6).replace(/\.?0+$/, '') + '</span>';
  html += '<span style="margin-left:6px;font-size:10px;color:' + scoreClr + ';font-weight:700;">' + (r.total >= 90 ? '🔥高关注' : r.total >= 70 ? '⭐候选' : '👀观察') + '</span>';
  html += '</div>';
  html += '<div style="text-align:right;">';
  html += '<span style="font-size:28px;font-weight:800;color:' + scoreClr + ';">' + r.total + '</span>';
  html += '<span style="font-size:10px;color:var(--text-dim);">/100</span>';
  html += '<div style="font-size:8px;color:var(--text-dim);">' + (r.marketRegime || 'neutral') + '</div>';
  html += '</div></div>';

  // ===== ② 五维评分 =====
  html += '<div style="font-size:10px;font-weight:700;margin:8px 0 4px;color:var(--text);">📊 吸筹评分拆解</div>';
  const dims = [
    { icon: '📉', label: '回撤', d: b.drawdown, max: 25, help: '从历史最高点跌了多少。>50%回撤是庄家接筹的必要条件。' },
    { icon: '⏱', label: '时间', d: b.time, max: 25, help: '已横盘多久。60-75天是最佳窗口(回测验证),90天以上效用递减。' },
    { icon: '📊', label: '波动', d: b.volatility, max: 20, help: 'ATR是否收缩。波动越小=庄控盘越强,吸筹越接近完成。' },
    { icon: '🏗', label: '结构', d: b.structure, max: 20, help: '价格距MA60多远。贴近均线意味着底部结构确立。' },
    { icon: '💧', label: '流动', d: b.liquidity, max: 10, help: '市值+日交易量。流动性过低(<1M)无法操作。' },
  ];
  for (const { icon, label, d, max, help } of dims) {
    if (!d) continue;
    const pct = Math.round((d.score / max) * 100);
    const clr = pct >= 80 ? '#22c55e' : pct >= 50 ? '#f0b90b' : 'var(--text-dim)';
    html += '<div class="radar-dim" onclick="this.classList.toggle(\'expanded\')" style="padding:4px 6px;margin:3px 0;background:var(--surface2);border-radius:3px;cursor:default;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    html += '<span style="font-size:10px;">' + icon + ' <b>' + label + '</b> <span style="font-size:8px;color:var(--text-dim);">' + (d.reason || '') + '</span></span>';
    html += '<span style="font-weight:700;color:' + clr + ';">' + d.score + '/' + max + '</span>';
    html += '</div>';
    html += '<div class="radar-dim-detail" style="display:none;font-size:8px;color:var(--text-dim);margin-top:3px;padding-top:3px;border-top:1px solid var(--border);">';
    html += '当前: ' + d.label + ' | ' + help;
    html += '</div>';
    html += '</div>';
  }

  // ===== ③ 结构走势 =====
  html += '<div style="font-size:10px;font-weight:700;margin:8px 0 4px;color:var(--text);">📈 结构走势</div>';
  const drawdownPct = Math.abs(ddPct * 100).toFixed(0);
  const athPrice = r.price ? r.price / (1 + ddPct) : 0;
  const zonePos = Math.min(100, parseInt(drawdownPct));
  html += '<div style="font-size:10px;padding:6px;background:var(--surface2);border-radius:3px;">';
  html += '<div style="display:flex;justify-content:space-between;font-size:8px;color:var(--text-dim);margin-bottom:2px;">';
  html += '<span>ATH $' + (athPrice > 0 ? athPrice.toFixed(6) : '?') + '</span>';
  html += '<span>当前 $' + (r.price || 0).toFixed(6) + '</span>';
  html += '</div>';
  html += '<div style="height:8px;background:var(--surface3);border-radius:4px;position:relative;overflow:hidden;">';
  html += '<div style="position:absolute;left:0;top:0;height:8px;width:' + zonePos + '%;background:linear-gradient(90deg,#ef4444,#fbbf24);border-radius:4px;"></div>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;font-size:7px;color:var(--text-dim);margin-top:2px;">';
  html += '<span>↑ 最高点</span><span>← ' + drawdownPct + '% 回撤 →</span><span>🏁 当前</span>';
  html += '</div>';
  html += '<div style="margin-top:4px;font-size:8px;color:var(--text-dim);">';
  html += '已横盘' + (b.time?.value || '?') + '天 | 吸筹状态: ' + (ddPct < -0.3 ? '二次探底中' : ddPct < -0.15 ? '筑底完成' : '底部确认') + '';
  html += '</div></div>';

  // ===== ④ 风险分析 =====
  html += '<div style="font-size:10px;font-weight:700;margin:8px 0 4px;color:var(--text);">⚠ 风险分析</div>';
  if (risks.length === 0) {
    html += '<div style="font-size:9px;color:#22c55e;padding:4px;background:var(--surface2);border-radius:3px;">✅ 无风险扣分</div>';
  } else {
    for (const ri of risks) {
      html += '<div style="padding:4px 6px;margin:2px 0;background:rgba(255,150,0,0.08);border:1px solid rgba(255,150,0,0.2);border-radius:3px;font-size:9px;">';
      html += '<b style="color:#fbbf24;">' + ri.reason + '</b> <span style="color:var(--text-dim);">' + ri.detail + '</span>';
      html += '<span style="float:right;color:#ef4444;font-weight:700;">-' + ri.deduct + '</span>';
      html += '</div>';
    }
    html += '<div style="font-size:8px;color:var(--text-dim);margin-top:2px;">总扣分: -' + (r.riskDeduct || 0) + '</div>';
  }

  // ===== ⑤ 历史验证 =====
  html += '<div style="font-size:10px;font-weight:700;margin:8px 0 4px;color:var(--text);">📈 历史验证</div>';
  html += '<div style="font-size:9px;color:var(--text-dim);padding:4px;background:var(--surface2);border-radius:3px;">';
  html += '⏳ 随每日追踪积累，此模块将显示7/30/60天真实表现<br>';
  html += '当前样本不足（首次记录于' + new Date().toISOString().slice(0, 10) + '）';
  html += '</div>';

  // ===== ⑥ 研究结论 =====
  html += '<div style="font-size:10px;font-weight:700;margin:8px 0 4px;color:var(--text);">🧠 研究结论</div>';
  const strengths = [];
  const concerns = [];
  if (ddPct <= -0.50) strengths.push('回撤充分(' + drawdownPct + '%)');
  if ((b.time?.value || 0) >= 60) strengths.push('吸筹已持续' + b.time?.value + '天');
  if ((b.volatility?.value || 0) < -0.10) strengths.push('波动显著收缩');
  if ((b.structure?.score || 0) >= 15) strengths.push('价格结构良好');
  if (risks.length > 0) concerns.push('存在' + risks.length + '项风险');
  if (ddPct > -0.30) concerns.push('回撤不足,庄可能未进场');
  if ((b.liquidity?.score || 0) < 5) concerns.push('流动性偏低');
  if (r.total < 70) concerns.push('评分未达候选线');

  html += '<div style="padding:6px;background:var(--surface2);border-radius:3px;font-size:10px;line-height:1.6;">';
  html += '<b>当前阶段: ' + (r.total >= 90 ? '底部确认,等待启动' : r.total >= 70 ? '底部结构观察' : '初期筛查') + '</b><br>';
  if (strengths.length) html += '<span style="color:#22c55e;">优势: ' + strengths.join('、') + '</span><br>';
  if (concerns.length) html += '<span style="color:#fbbf24;">关注: ' + concerns.join('、') + '</span><br>';
  html += '<span style="font-size:8px;color:var(--text-dim);">⚠ 本结论基于技术形态+市场环境,不含链上验证。仅供参考,不构成交易建议。</span>';
  html += '</div>';

  body.innerHTML = html;
  detail.style.display = '';
}
