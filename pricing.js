'use strict';
/**
 * 模型名称归一化、默认上下文窗口与公开 API 参考费率表 (USD / 1M tokens)
 * 说明：费用仅按公开 Developer API 标准单价估算，仅供参考，不代表订阅扣费。
 */

const MODEL_PRICING = {
  'gemini-4-hydrogen': {
    label: 'Gemini 4 Hydrogen',
    contextWindow: 1000000,
    input: 1.50,
    output: 7.50,
    cacheRead: 0.075
  },
  'gemini-4-argon': {
    label: 'Gemini 4 Argon',
    contextWindow: 1000000,
    input: 2.00,
    output: 10.00,
    cacheRead: 0.10
  },
  'gemini-4-carbon': {
    label: 'Gemini 4 Carbon',
    contextWindow: 1000000,
    input: 2.00,
    output: 10.00,
    cacheRead: 0.10
  },
  'gemini-3.8-flash': {
    label: 'Gemini 3.8 Flash',
    contextWindow: 1000000,
    input: 0.75,
    output: 3.75,
    cacheRead: 0.075
  },
  'gemini-3.5-flash-lite': {
    label: 'Gemini 3.5 Flash-Lite',
    contextWindow: 1000000,
    input: 0.30,
    output: 2.50,
    cacheRead: 0.03
  },
  'gemini-3.1-pro': {
    label: 'Gemini 3.1 Pro',
    contextWindow: 1000000,
    input: 2.00,
    output: 12.00,
    cacheRead: 0.20
  },
  'gemini-2.5-pro': {
    label: 'Gemini 2.5 Pro',
    contextWindow: 1000000,
    input: 1.25,
    output: 10.00,
    cacheRead: 0.125
  },
  'gemini-2.5-flash': {
    label: 'Gemini 2.5 Flash',
    contextWindow: 1000000,
    input: 0.30,
    output: 2.50,
    cacheRead: 0.03
  },
  'claude-opus-5-5': {
    label: 'Claude Opus 5.5',
    contextWindow: 256000,
    input: 4.00,
    output: 20.00,
    cacheRead: 0.20
  },
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5',
    contextWindow: 256000,
    input: 2.00,
    output: 10.00,
    cacheRead: 0.10
  },
  'claude-sonnet-4': {
    label: 'Claude Sonnet 4',
    contextWindow: 200000,
    input: 3.00,
    output: 15.00,
    cacheRead: 0.30
  },
  'claude-opus-4': {
    label: 'Claude Opus 4',
    contextWindow: 200000,
    input: 15.00,
    output: 75.00,
    cacheRead: 1.50
  }
};

const FALLBACK_PRICING = {
  label: 'Unknown Model',
  contextWindow: 256000,
  input: 1.50,
  output: 7.50,
  cacheRead: 0.10
};

function normalizeModelKey(rawModel) {
  const s = String(rawModel || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (s.includes('argon')) return 'gemini-4-argon';
  if (s.includes('carbon')) return 'gemini-4-carbon';
  if (s.includes('3.8') && s.includes('flash')) return 'gemini-3.8-flash';
  if (s.includes('3.5') && s.includes('flash')) return 'gemini-3.5-flash-lite';
  if (s.includes('3.1') && s.includes('pro')) return 'gemini-3.1-pro';
  if (s.includes('2.5') && s.includes('pro')) return 'gemini-2.5-pro';
  if (s.includes('2.5') && s.includes('flash')) return 'gemini-2.5-flash';
  if (s.includes('opus') && (s.includes('5.5') || s.includes('5-5'))) return 'claude-opus-5-5';
  if (s.includes('sonnet') && (s.includes('5.5') || s.includes('5-5'))) return 'claude-sonnet-5-5';
  if (s.includes('opus')) return 'claude-opus-4';
  if (s.includes('sonnet') || s.includes('claude')) return 'claude-sonnet-4';
  if (s.includes('flash')) return 'gemini-3.8-flash';
  if (s.includes('gemini')) return 'gemini-4-hydrogen';
  return s;
}

function getModelInfo(rawModel) {
  const key = normalizeModelKey(rawModel);
  const known = MODEL_PRICING[key];
  if (known) return { key, ...known, isKnown: true };
  const cleanLabel = String(rawModel || '').trim() || '未知模型';
  return { key, ...FALLBACK_PRICING, label: cleanLabel, isKnown: false };
}

function estimateReferenceCostUsd({ inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 }, rawModel) {
  const info = getModelInfo(rawModel);
  const inp = Math.max(0, Number(inputTokens) || 0);
  const cap = Math.max(0, Number(cacheReadTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  const cost =
    (inp / 1_000_000) * info.input +
    (cap / 1_000_000) * info.cacheRead +
    (out / 1_000_000) * info.output;
  return Number(cost.toFixed(6));
}

function getDefaultDisplayWindow(rawModel) {
  // Antigravity 2.x 桌面端默认 checkpoint 上限为 256K，作为保守默认分母
  return 256000;
}

module.exports = {
  MODEL_PRICING,
  normalizeModelKey,
  getModelInfo,
  estimateReferenceCostUsd,
  getDefaultDisplayWindow
};
