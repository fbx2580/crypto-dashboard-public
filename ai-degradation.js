#!/usr/bin/env node
/**
 * AI 降级包装模块
 *
 * 原则：
 * - AI 是可选增强，不是必需依赖
 * - AI 调用失败不阻断核心流程
 * - 规则模型始终独立运行
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STATUS_FILE = path.join(__dirname, 'public', 'data', 'analysis', 'ai_status.json');

function L(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] [ai] ${m}`); }

// ═══ AI 状态管理 ═══
let aiState = {
  status: 'unknown',      // available | unavailable | degraded
  lastCheck: null,
  errorReason: null,       // billing_error | timeout | api_error | no_key
  consecutiveFailures: 0,
  totalCalls: 0,
  totalFailures: 0,
};

function loadState() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      aiState = { ...aiState, ...JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) };
    }
  } catch (e) {}
}

function saveState() {
  try {
    const dir = path.dirname(STATUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...aiState, lastCheck: new Date().toISOString() }, null, 2));
  } catch (e) {}
}

// ═══ 获取 API Key ═══
function getApiKey() {
  try { return fs.readFileSync(path.join(__dirname, 'secrets', 'deepseek.key'), 'utf8').trim(); } catch (e) { return null; }
}

// ═══ AI 调用（带回退） ═══
async function callAI(prompt, options = {}) {
  const {
    model = 'deepseek-chat',
    maxTokens = 500,
    temperature = 0.7,
    timeout = 30000,
  } = options;

  const apiKey = getApiKey();
  if (!apiKey) {
    aiState.status = 'unavailable';
    aiState.errorReason = 'no_key';
    saveState();
    return { success: false, error: 'no_key', content: null };
  }

  aiState.totalCalls++;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.post('https://api.deepseek.com/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout,
      });

      const content = res.data?.choices?.[0]?.message?.content || '';
      aiState.status = 'available';
      aiState.errorReason = null;
      aiState.consecutiveFailures = 0;
      saveState();
      return { success: true, content };
    } catch (e) {
      const status = e.response?.status || 0;
      const msg = e.message || '';

      if (status === 402 || msg.includes('billing') || msg.includes('balance') || msg.includes('quota')) {
        aiState.errorReason = 'billing_error';
      } else if (msg.includes('timeout') || e.code === 'ECONNABORTED') {
        aiState.errorReason = 'timeout';
      } else {
        aiState.errorReason = 'api_error';
      }

      aiState.consecutiveFailures++;
      aiState.totalFailures++;

      if (aiState.consecutiveFailures >= 3) {
        aiState.status = 'unavailable';
        L(`⚠ AI 连续失败 ${aiState.consecutiveFailures} 次，标记不可用`);
      } else {
        aiState.status = 'degraded';
      }

      saveState();

      if (attempt < maxRetries) {
        L(`⚠ AI 调用失败 (${aiState.errorReason}), 重试 ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  return { success: false, error: aiState.errorReason, content: null };
}

// ═══ AI 增强包装（规则模型 + 可选AI解释） ═══
async function enhanceWithAI(ruleResult, context = {}) {
  if (aiState.status === 'unavailable') {
    return { ...ruleResult, aiExplanation: null, aiStatus: 'unavailable' };
  }

  const prompt = `简短分析以下加密货币的诊断结果：

币种: ${context.symbol || 'N/A'}
价格: ${context.price || 'N/A'}
生命周期阶段: ${ruleResult.lifecycleStage || 'N/A'}
交易角色: ${ruleResult.tradingRole || 'N/A'}
稀筹状态: ${ruleResult.accumulationStatus || 'N/A'}
二次上涨可能: ${ruleResult.secondWave || 'N/A'}

用1-2句中文给出交易建议。`;

  const ai = await callAI(prompt, { maxTokens: 150 });

  if (ai.success) {
    return {
      ...ruleResult,
      aiExplanation: ai.content,
      aiStatus: 'available',
    };
  }

  return {
    ...ruleResult,
    aiExplanation: null,
    aiStatus: aiState.status,
    aiError: aiState.errorReason,
  };
}

// ═══ 健康检查 ═══
function getAIStatus() {
  return { ...aiState };
}

// ═══ 重置状态（手动恢复） ═══
function resetAIState() {
  aiState.status = 'unknown';
  aiState.errorReason = null;
  aiState.consecutiveFailures = 0;
  saveState();
  L('🔄 AI 状态已重置');
}

// 初始化加载状态
loadState();

module.exports = { callAI, enhanceWithAI, getAIStatus, resetAIState };
