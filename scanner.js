'use strict';
/**
 * 纯本地只读会话与历史 Token 扫描引擎
 * - 仅只读访问 ~/.gemini/antigravity/brain 与 ~/.gemini/antigravity-cli/brain 下的 transcript.jsonl
 * - 零网络请求、零凭据访问、零文件写入
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getModelInfo, estimateReferenceCostUsd, getDefaultDisplayWindow } = require('./pricing');

const SKIP_DIRS = new Set(['node_modules', '.git', 'scratch', 'steps', 'artifacts']);
const fileCache = new Map(); // filePath -> { size, mtimeMs, records }

function formatLocalDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getGeminiDataRoots(options = {}) {
  if (Array.isArray(options.roots) && options.roots.length > 0) {
    return options.roots;
  }
  const home = options.homeDir || os.homedir();
  const roots = [
    { dir: path.join(home, '.gemini', 'antigravity'), source: 'desktop' },
    { dir: path.join(home, '.gemini', 'antigravity-cli'), source: 'cli' }
  ];
  return roots;
}

function collectTranscriptFiles(roots) {
  const files = [];
  const visitedDirs = new Set();

  function walk(dir, source, depth) {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    let realDir = dir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {}
    const dirKey = process.platform === 'win32' ? realDir.toLowerCase() : realDir;
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0) {
          const stdPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
          const directPath = path.join(fullPath, 'transcript.jsonl');
          let matched = false;
          if (fs.existsSync(stdPath)) {
            files.push({ filePath: stdPath, source, cascadeIdHint: entry.name });
            matched = true;
          }
          if (fs.existsSync(directPath)) {
            files.push({ filePath: directPath, source, cascadeIdHint: entry.name });
            matched = true;
          }
          if (matched) continue;
        }
        walk(fullPath, source, depth + 1);
      } else if (entry.isFile() && entry.name === 'transcript.jsonl') {
        const brainMatch = fullPath.match(/[\\/]brain[\\/]([^\\/]+)[\\/]/i);
        files.push({
          filePath: fullPath,
          source,
          cascadeIdHint: brainMatch ? brainMatch[1] : path.basename(path.dirname(fullPath))
        });
      }
    }
  }

  for (const r of roots) {
    if (!r || !r.dir) continue;
    walk(path.join(r.dir, 'brain'), r.source || 'desktop', 0);
  }
  return files;
}

function extractRecordFromEvent(event, cascadeIdFallback, lineIndex, source) {
  if (!event || typeof event !== 'object') return null;

  const rawDate = event.created_at || event.createdAt || event.timestamp;
  const ts = rawDate ? Date.parse(rawDate) : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens = 0;

  if (
    event.input_tokens != null ||
    event.output_tokens != null ||
    event.cache_read_tokens != null ||
    event.inputTokens != null ||
    event.outputTokens != null ||
    event.cacheReadTokens != null
  ) {
    inputTokens = Number(event.input_tokens ?? event.inputTokens ?? 0) || 0;
    outputTokens = Number(event.output_tokens ?? event.outputTokens ?? 0) || 0;
    cacheReadTokens = Number(event.cache_read_tokens ?? event.cacheReadTokens ?? 0) || 0;
    thinkingTokens = Number(event.thinking_output_tokens ?? event.thinkingOutputTokens ?? 0) || 0;
  } else if (event.chatModel && event.chatModel.usage) {
    const u = event.chatModel.usage;
    inputTokens = Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
    outputTokens = Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
    cacheReadTokens = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0) || 0;
    thinkingTokens = Number(u.thinkingOutputTokens ?? u.thinking_output_tokens ?? 0) || 0;
  }

  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  if (totalTokens <= 0) return null;

  const rawModel =
    event.chatModel?.modelDisplayName ||
    event.chatModel?.responseModel ||
    event.chatModel?.model ||
    event.modelDisplayName ||
    event.model ||
    event.modelId ||
    '';

  const cascadeId = String(event.cascadeId || event.cascade_id || cascadeIdFallback || '').trim();
  const rawStep = event.step_index ?? event.stepIndex;
  const stepIndex = Number.isInteger(Number(rawStep)) && Number(rawStep) >= 0 ? Number(rawStep) : lineIndex;
  const responseId = String(
    event.responseId ||
      event.response_id ||
      event.chatModel?.responseId ||
      event.id ||
      ''
  ).trim();

  const dedupeKey = responseId
    ? `resp:${responseId}`
    : `step:${cascadeId}:${stepIndex}:${ts}`;

  const modelInfo = getModelInfo(rawModel);
  const costUsd = estimateReferenceCostUsd({ inputTokens, cacheReadTokens, outputTokens }, rawModel);

  return {
    dedupeKey,
    cascadeId,
    stepIndex,
    source,
    ts,
    dateKey: formatLocalDate(new Date(ts)),
    modelKey: modelInfo.key,
    modelLabel: modelInfo.label,
    rawModel: String(rawModel || ''),
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    totalTokens,
    contextTokens: inputTokens + cacheReadTokens,
    costUsd
  };
}

function parseTranscriptFile(filePath, source, cascadeIdHint) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.records;
  }

  const records = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = extractRecordFromEvent(parsed, cascadeIdHint, i, source);
      if (rec) records.push(rec);
    }
  } catch {
    return [];
  }

  if (fileCache.size > 1200) fileCache.clear();
  fileCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, records });
  return records;
}

function findSessionTranscript(cascadeId, roots) {
  const cid = String(cascadeId || '').trim();
  if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) return null;
  for (const r of roots) {
    const candidates = [
      path.join(r.dir, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl'),
      path.join(r.dir, 'brain', cid, 'transcript.jsonl')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return { filePath: p, source: r.source };
    }
  }
  return null;
}

function summarizeSessionRecords(cascadeId, records) {
  const deduped = new Map();
  for (const rec of records) {
    const prev = deduped.get(rec.dedupeKey);
    if (!prev || rec.totalTokens >= prev.totalTokens) {
      deduped.set(rec.dedupeKey, rec);
    }
  }
  const list = Array.from(deduped.values()).sort((a, b) => (a.ts - b.ts) || (a.stepIndex - b.stepIndex));

  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;

  for (const r of list) {
    totalInput += r.inputTokens;
    totalCacheRead += r.cacheReadTokens;
    totalOutput += r.outputTokens;
    totalThinking += r.thinkingTokens;
    totalTokens += r.totalTokens;
    estimatedCostUsd += r.costUsd;
  }

  const latest = list.length > 0 ? list[list.length - 1] : null;
  const contextTokens = latest ? latest.contextTokens : 0;
  const latestPromptTotal = latest ? (latest.inputTokens + latest.cacheReadTokens) : 0;
  const cacheHitRate = latestPromptTotal > 0 ? Number(((latest.cacheReadTokens / latestPromptTotal) * 100).toFixed(1)) : 0;
  const sessionPromptTotal = totalInput + totalCacheRead;
  const sessionCacheHitRate = sessionPromptTotal > 0 ? Number(((totalCacheRead / sessionPromptTotal) * 100).toFixed(1)) : 0;
  const modelLabel = latest ? latest.modelLabel : '';
  const modelKey = latest ? latest.modelKey : 'unknown';

  return {
    ok: true,
    cascadeId: cascadeId || null,
    hasData: list.length > 0,
    turnCount: list.length,
    modelKey,
    modelLabel,
    defaultWindow: getDefaultDisplayWindow(modelKey),
    contextTokens,
    latest: latest
      ? {
          ts: latest.ts,
          stepIndex: latest.stepIndex,
          modelKey: latest.modelKey,
          modelLabel: latest.modelLabel,
          inputTokens: latest.inputTokens,
          cacheReadTokens: latest.cacheReadTokens,
          outputTokens: latest.outputTokens,
          thinkingTokens: latest.thinkingTokens,
          contextTokens: latest.contextTokens,
          totalTokens: latest.totalTokens,
          cacheHitRate
        }
      : null,
    totals: {
      inputTokens: totalInput,
      cacheReadTokens: totalCacheRead,
      outputTokens: totalOutput,
      thinkingTokens: totalThinking,
      totalTokens,
      cacheHitRate: sessionCacheHitRate,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4))
    },
    recentTurns: list.slice(-12).reverse().map(r => ({
      ts: r.ts,
      stepIndex: r.stepIndex,
      modelLabel: r.modelLabel,
      inputTokens: r.inputTokens,
      cacheReadTokens: r.cacheReadTokens,
      outputTokens: r.outputTokens,
      contextTokens: r.contextTokens,
      costUsd: Number(r.costUsd.toFixed(4))
    }))
  };
}

function getSessionSnapshot(cascadeId, options = {}) {
  const roots = getGeminiDataRoots(options);
  if (!cascadeId) {
    return summarizeSessionRecords(null, []);
  }
  const hit = findSessionTranscript(cascadeId, roots);
  if (!hit) {
    return summarizeSessionRecords(cascadeId, []);
  }
  const records = parseTranscriptFile(hit.filePath, hit.source, cascadeId);
  return summarizeSessionRecords(cascadeId, records);
}

function createEmptyBucket() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    calls: 0,
    estimatedCostUsd: 0,
    _sessions: new Set(),
    _models: new Map()
  };
}

function addToBucket(bucket, rec) {
  bucket.inputTokens += rec.inputTokens;
  bucket.cacheReadTokens += rec.cacheReadTokens;
  bucket.outputTokens += rec.outputTokens;
  bucket.thinkingTokens += rec.thinkingTokens;
  bucket.totalTokens += rec.totalTokens;
  bucket.calls += 1;
  bucket.estimatedCostUsd += rec.costUsd;
  if (rec.cascadeId) bucket._sessions.add(rec.cascadeId);

  let m = bucket._models.get(rec.modelKey);
  if (!m) {
    m = {
      modelKey: rec.modelKey,
      modelLabel: rec.modelLabel,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      calls: 0,
      estimatedCostUsd: 0
    };
    bucket._models.set(rec.modelKey, m);
  }
  m.inputTokens += rec.inputTokens;
  m.cacheReadTokens += rec.cacheReadTokens;
  m.outputTokens += rec.outputTokens;
  m.totalTokens += rec.totalTokens;
  m.calls += 1;
  m.estimatedCostUsd += rec.costUsd;
}

function finalizeBucket(bucket) {
  const models = Array.from(bucket._models.values())
    .map(m => ({ ...m, estimatedCostUsd: Number(m.estimatedCostUsd.toFixed(4)) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const promptTot = bucket.inputTokens + bucket.cacheReadTokens;
  return {
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    thinkingTokens: bucket.thinkingTokens,
    totalTokens: bucket.totalTokens,
    calls: bucket.calls,
    sessions: bucket._sessions.size,
    cacheHitRate: promptTot > 0 ? Number(((bucket.cacheReadTokens / promptTot) * 100).toFixed(1)) : 0,
    estimatedCostUsd: Number(bucket.estimatedCostUsd.toFixed(4)),
    models
  };
}

function buildHeatmap(dailyMap, nowDate) {
  const TOTAL_DAYS = 52 * 7; // 364 天 (52 周)
  const end = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const days = [];
  let maxTokens = 0;
  let activeDays = 0;

  for (let i = TOTAL_DAYS - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    const key = formatLocalDate(d);
    const stat = dailyMap.get(key) || { tokens: 0, calls: 0 };
    if (stat.tokens > 0) activeDays++;
    if (stat.tokens > maxTokens) maxTokens = stat.tokens;
    days.push({
      date: key,
      weekday: d.getDay(),
      tokens: stat.tokens,
      calls: stat.calls,
      level: 0
    });
  }

  // 计算 5 档强度（0..4），按活跃天数的分位数映射，视觉层次清晰
  const nonZero = days.filter(d => d.tokens > 0).map(d => d.tokens).sort((a, b) => a - b);
  if (nonZero.length > 0) {
    const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
    const q2 = nonZero[Math.floor(nonZero.length * 0.50)] || q1;
    const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || q2;
    for (const day of days) {
      if (day.tokens <= 0) day.level = 0;
      else if (day.tokens <= q1) day.level = 1;
      else if (day.tokens <= q2) day.level = 2;
      else if (day.tokens <= q3) day.level = 3;
      else day.level = 4;
    }
  }

  // 计算当前连续活跃天数
  let currentStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].tokens > 0) currentStreak++;
    else if (i === days.length - 1) continue; // 今天还没发消息时允许看昨天开始的连续天数
    else break;
  }

  return {
    totalDays: TOTAL_DAYS,
    activeDays,
    currentStreak,
    maxDailyTokens: maxTokens,
    days
  };
}

function getHistorySnapshot(options = {}) {
  const roots = getGeminiDataRoots(options);
  const now = options.now instanceof Date ? options.now : new Date();
  const todayKey = formatLocalDate(now);

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekCutoff = startOfToday - 6 * 24 * 60 * 60 * 1000;
  const monthCutoff = startOfToday - 29 * 24 * 60 * 60 * 1000;

  const files = collectTranscriptFiles(roots);
  const globalDedup = new Map();
  let desktopFiles = 0;
  let cliFiles = 0;

  for (const f of files) {
    if (f.source === 'cli') cliFiles++;
    else desktopFiles++;
    const recs = parseTranscriptFile(f.filePath, f.source, f.cascadeIdHint);
    for (const rec of recs) {
      const prev = globalDedup.get(rec.dedupeKey);
      if (!prev || rec.totalTokens >= prev.totalTokens) {
        globalDedup.set(rec.dedupeKey, rec);
      }
    }
  }

  const buckets = {
    today: createEmptyBucket(),
    week: createEmptyBucket(),
    month: createEmptyBucket(),
    all: createEmptyBucket()
  };
  const dailyMap = new Map();
  let latestSessionId = null;
  let latestTs = 0;

  for (const rec of globalDedup.values()) {
    addToBucket(buckets.all, rec);
    if (rec.ts >= monthCutoff) addToBucket(buckets.month, rec);
    if (rec.ts >= weekCutoff) addToBucket(buckets.week, rec);
    if (rec.dateKey === todayKey) addToBucket(buckets.today, rec);

    const dStat = dailyMap.get(rec.dateKey) || { tokens: 0, calls: 0 };
    dStat.tokens += rec.totalTokens;
    dStat.calls += 1;
    dailyMap.set(rec.dateKey, dStat);

    if (rec.ts > latestTs && rec.cascadeId) {
      latestTs = rec.ts;
      latestSessionId = rec.cascadeId;
    }
  }

  return {
    ok: true,
    generatedAt: now.toISOString(),
    todayKey,
    latestSessionId,
    sources: {
      desktopFiles,
      cliFiles
    },
    periods: {
      today: finalizeBucket(buckets.today),
      week: finalizeBucket(buckets.week),
      month: finalizeBucket(buckets.month),
      all: finalizeBucket(buckets.all)
    },
    heatmap: buildHeatmap(dailyMap, now)
  };
}

function clearCache() {
  fileCache.clear();
}

module.exports = {
  getGeminiDataRoots,
  getSessionSnapshot,
  getHistorySnapshot,
  summarizeSessionRecords,
  formatLocalDate,
  clearCache
};
