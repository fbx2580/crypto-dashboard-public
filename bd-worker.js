// ─── 后门 AI 工作器 ───
// 自动加载仪表盘所有 JSON 数据作为知识库
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BD_DIR = path.join(__dirname, 'public', 'data', 'bd');
const POLL_MS = 2000;
const MODEL = 'deepseek-chat';

// API Key
const API_KEY = (() => {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return fs.readFileSync(path.join(__dirname, 'secrets', 'deepseek.key'), 'utf8').trim(); } catch(e) {}
  return null;
})();
if (!API_KEY) { console.error('❌ 未找到 API KEY'); process.exit(1); }

// ─── 知识库：自动扫描所有 JSON ───
let _knowledgeCache = '';
let _knowledgeTime = 0;
const KNOWLEDGE_TTL = 60000;
const SKIP_FILES = ['history.json', 'seen_titles.json', 'live.json']; // 无用文件
const MAX_PER_FILE = 3000;
const TOTAL_MAX = 30000;

// 构建知识库
function getKnowledge() {
  const now = Date.now();
  if (now - _knowledgeTime < KNOWLEDGE_TTL && _knowledgeCache) return _knowledgeCache;

  const parts = [];
  let totalChars = 0;
  const add = (label, text) => { parts.push('## ' + label + '\n' + text); totalChars += text.length; };

  add('TUHASEN Terminal', '加密货币量化分析仪表盘。数据：DexScreener、Binance API、Jin10/RSS。\n分析：ADX/RSI/波动率/震荡区间/放量异动/吸筹检测。');

  function loadJson(path, label) {
    try {
      if (!fs.existsSync(path)) return;
      const d = JSON.parse(fs.readFileSync(path, 'utf8'));
      const t = JSON.stringify(d, null, 2).slice(0, MAX_PER_FILE);
      if (t.length > 50) add(label || path, t);
    } catch(e) {}
  }

  // 1. 分析结果（高优先级）
  const analysisDir = path.join(__dirname, 'public', 'analysis');
  try {
    for (const f of fs.readdirSync(analysisDir).sort()) {
      if (!f.endsWith('.json') || totalChars >= TOTAL_MAX) continue;
      loadJson(path.join(analysisDir, f), f.replace('.json',''));
    }
  } catch(e) {}

  // 2. 新闻快讯（高优先级，专门处理）
  const newsPaths = [
    ['data/alerts/news.json', '加密新闻快讯'],
    ['data/news/latest.json', '实时快讯'],
    ['data/news/jin10.json', 'Jin10快讯'],
  ];
  for (const [relPath, label] of newsPaths) {
    if (totalChars >= TOTAL_MAX) break;
    loadJson(path.join(__dirname, 'public', relPath), label);
  }

  // 3. Binance 数据摘要（中优先级）
  const binanceFile = path.join(__dirname, 'public', 'data', 'binance', 'latest_snapshot.json');
  loadJson(binanceFile, 'Binance数据');

  // 4. 其他 data/ 下的文件（低优先级，排个序）
  try {
    const scanDir = path.join(__dirname, 'public', 'data');
    for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
      if (totalChars >= TOTAL_MAX) break;
      if (!entry.isDirectory() || entry.name === 'bd') continue;
      // 只读一级目录下的 .json（跳过深层嵌套）
      try {
        for (const f of fs.readdirSync(path.join(scanDir, entry.name)).sort()) {
          if (totalChars >= TOTAL_MAX) break;
          if (!f.endsWith('.json') || SKIP_FILES.includes(f)) continue;
          loadJson(path.join(scanDir, entry.name, f), 'data/' + entry.name + '/' + f);
        }
      } catch(e) {}
    }
  } catch(e) {}

  _knowledgeCache = parts.join('\n\n');
  _knowledgeTime = now;
  console.log('📚 Knowledge rebuilt: ' + parts.length + ' sections, ' + totalChars + ' chars');
  return _knowledgeCache;
}

// ─── 系统提示词 ───
const BASE_PROMPT = `你是图哈森（Tuhasen），嵌入在加密货币量化分析仪表盘中的 AI 助手。
精通市场分析、技术指标、链上数据解读。简洁直接，数据说话。
以下所有数据均为仪表盘实时采集，回答问题优先基于这些实际数据。`;

// ─── 消息处理 ───
const processing = new Set();

async function processMessages() {
  if (!fs.existsSync(BD_DIR)) return;
  const files = fs.readdirSync(BD_DIR);
  const uids = new Set();
  for (const f of files) {
    if (f.endsWith('_thinking.flag')) uids.add(f.replace('_thinking.flag', ''));
  }
  for (const uid of uids) {
    if (processing.has(uid)) continue;
    processing.add(uid);
    try { await generateReply(uid); } catch (err) { console.error('[' + uid + ']', err.message); }
    finally { processing.delete(uid); }
  }
}

async function generateReply(uid) {
  const msgFile = path.join(BD_DIR, uid + '.json');
  const thinkingFile = path.join(BD_DIR, uid + '_thinking.flag');
  const replyFile = path.join(BD_DIR, uid + '_reply.json');
  if (!fs.existsSync(msgFile)) { try { fs.unlinkSync(thinkingFile); } catch(e) {} return; }

  const data = JSON.parse(fs.readFileSync(msgFile, 'utf8'));
  const recent = (data.messages || []).slice(-20);
  const knowledge = getKnowledge();

  const res = await axios.post('https://api.deepseek.com/chat/completions', {
    model: MODEL,
    messages: [
      { role: 'system', content: BASE_PROMPT + '\n\n' + knowledge },
      ...recent.map(m => ({ role: m.role, content: m.text }))
    ],
    max_tokens: 1024, temperature: 0.7, stream: false,
  }, {
    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  const reply = res.data.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Empty response');

  data.messages.push({ role: 'assistant', text: reply, time: Date.now() });
  fs.writeFileSync(msgFile, JSON.stringify(data, null, 2));
  fs.writeFileSync(replyFile, JSON.stringify({ reply, time: Date.now() }));
  try { fs.unlinkSync(thinkingFile); } catch(e) {}
  console.log('[' + uid + '] ✅ Reply sent');
}

// ─── 启动 ───
console.log('🧠 BD Worker started');
setInterval(processMessages, POLL_MS);
processMessages();
