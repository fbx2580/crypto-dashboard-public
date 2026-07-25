// ─── AI 新闻分析模块 v2 ───
// 分析价格异动原因：新闻驱动 / 技术面 / 市场行为 / 链上行为
// 给出推理过程

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');

function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return fs.readFileSync(path.join(__dirname, 'secrets', 'deepseek.key'), 'utf8').trim(); } catch(e) {}
  return null;
}

const API_KEY = getApiKey();
const API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 获取近期新闻（24小时，取有具体内容的）
function getRecentNews(hours = 24, limit = 40) {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  try {
    const rows = db.prepare(
      "SELECT source, title, content, url, ts FROM news_archive WHERE ts > ? AND title IS NOT NULL AND title != '' ORDER BY ts DESC LIMIT ?"
    ).all(cutoff, limit);
    return rows.map(r => ({
      time: new Date(r.ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      source: r.source,
      title: (r.title || '').trim(),
      content: ((r.content || '').trim()).slice(0, 150),
    })).filter(r => r.title.length > 3);
  } catch(e) { return []; }
}

// 获取近期巨鲸转账（用于链上分析）
function getWhaleContext() {
  const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1小时内
  try {
    const rows = db.prepare(
      "SELECT chain, value, from_addr, to_addr, ex_from, ex_to, ts FROM whale_transfers WHERE ts > ? ORDER BY value DESC LIMIT 10"
    ).all(cutoff);
    return rows.map(r => ({
      chain: r.chain,
      value: r.chain === 'BTC' ? `${r.value.toFixed(2)} BTC` : r.chain === 'ETH' ? `${r.value.toFixed(0)} ETH` : `$${(r.value/10000).toFixed(0)}万`,
      from: (r.ex_from || r.from_addr || '').slice(0, 12),
      to: (r.ex_to || r.to_addr || '').slice(0, 12),
      time: new Date(r.ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    }));
  } catch(e) { return []; }
}

// ─── AI分析主函数 ───
async function analyze(name, price, pctChange, pct5m, level, depthRatio, volRatio) {
  if (!API_KEY) return { conclusion: 'AI分析不可用（无API Key）', evidence: [] };

  const news = getRecentNews(24, 40);
  const whales = getWhaleContext();

  // 构建新闻文本
  let newsText = '无近期新闻';
  if (news.length > 0) {
    const items = news.slice(0, 20).map(n =>
      `[${n.time} ${n.source}] ${n.title}${n.content ? ' — ' + n.content : ''}`
    );
    newsText = items.join('\n');
  }

  // 构建巨鲸文本
  let whaleText = '无近期大额转账';
  if (whales.length > 0) {
    whaleText = whales.slice(0, 8).map(w =>
      `[${w.time}] ${w.chain} ${w.value} ${w.from} → ${w.to}`
    ).join('\n');
  }

  const direction = pctChange > 0 ? '上涨' : '下跌';
  const depthDesc = depthRatio < 0.6 ? '卖压重（买单/卖单比 ' + depthRatio.toFixed(2) + '）' 
    : depthRatio > 1.5 ? '买盘强（买单/卖单比 ' + depthRatio.toFixed(2) + '）'
    : '买卖均衡（' + depthRatio.toFixed(2) + '）';
  
  // 流动性描述（从depth返回的额外字段）
  let liquidityDesc = '未知';
  if (arguments.length > 5 && arguments[5]) {
    const l = arguments[5];
    liquidityDesc = l === '充足' ? '盘口厚度充足，不易被大单打穿' 
      : l === '一般' ? '盘口厚度一般，中等单量即可推动价格' 
      : '盘口偏薄，少量资金即可显著影响价格';
  }

  const prompt = `你是一个专业的加密货币市场分析师。你的任务是基于当前数据，分析BTC/ETH价格异动的原因。

当前数据：
- 品种：${name}
- 当前价格：$${price.toLocaleString('en')}
- 1分钟变动：${Math.abs(pctChange).toFixed(2)}%（${direction}）
- 5分钟变动：${Math.abs(pct5m).toFixed(2)}%（${pct5m > 0 ? '涨' : '跌'}）
- 异动级别：${level}
- 盘口状态：${depthDesc}
- 成交量：${volRatio ? (volRatio > 2 ? '放量(' + volRatio.toFixed(1) + 'x均值)' : '正常(' + volRatio.toFixed(1) + 'x均值)') : '未知'}

近期新闻（24小时内）：
${newsText}

近期大额链上转账（1小时内）：
${whaleText}

请从以下几个角度逐条分析可能的原因，每条给出推理依据：

1️⃣ **新闻驱动** — 近期有没有哪条新闻直接可能导致这次波动？请引用具体新闻标题和时间。如果没有，说"无明显新闻驱动"。

2️⃣ **市场行为** — 是不是可能的获利了结、恐慌抛售、轧空、流动性枯竭等原因？依据是什么？（如盘口失衡、放量等）

3️⃣ **技术面** — 是不是接近某个关键价位（整数关口、前高前低）导致自动触发买卖？这个需要你根据价格位置做推断。

4️⃣ **链上行为** — 近期有没有大额转账到交易所（提现＝准备卖）或从交易所提走（囤币＝看好）？

5️⃣ **综合结论** — 给出你最确定的判断（1-2句话），格式：【原因类型】具体原因

要求：
- 每条必须写推理依据，不能只说结论
- 不确定就说"不确定"，不瞎编
- 语言简洁，每条不超过2句话`;

  try {
    const res = await axios.post(API_URL, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个严谨的加密货币市场分析师。只用数据说话，不确定就说不知道。每个结论必须写明依据。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 800,
      temperature: 0.3,
    }, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });

    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '分析无结果';

    // 提取综合结论（最后一行或含【】的行）
    let conclusion = raw;
    const concMatch = raw.match(/【.*?】.*/);
    if (concMatch) conclusion = concMatch[0];

    return { conclusion, raw, newsCount: news.length, whaleCount: whales.length };
  } catch(e) {
    console.error('[ai-news] error:', e.message);
    return { conclusion: 'AI分析暂不可用', raw: null, newsCount: news.length, whaleCount: whales.length };
  }
}

module.exports = { analyze, getRecentNews, getWhaleContext };
