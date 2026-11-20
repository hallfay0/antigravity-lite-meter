#!/usr/bin/env node
'use strict';
/**
 * Antigravity Lite Meter — 零改盘本地网页看板服务器
 * - 严格仅监听本机回环地址 127.0.0.1（不对外暴露、不发起任何外网请求）
 * - 完全不修改 Antigravity 任何文件（真正 0% 封号风险）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { getHistorySnapshot, getSessionSnapshot } = require('./scanner');

function buildDashboardPayload(options = {}) {
  const history = getHistorySnapshot(options);
  const allSessions = [];
  const seen = new Set();

  // 汇总最近活跃会话列表（按最新时间戳倒序，最多保留 15 条）
  const roots = require('./scanner').getGeminiDataRoots(options);
  for (const r of roots) {
    const brainDir = path.join(r.dir, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const cid = ent.name;
      if (seen.has(cid)) continue;
      const snap = getSessionSnapshot(cid, options);
      if (snap && snap.hasData && snap.latest) {
        seen.add(cid);
        allSessions.push({
          cascadeId: cid,
          lastTs: snap.latest.ts,
          modelLabel: snap.modelLabel,
          contextTokens: snap.contextTokens,
          inputTokens: snap.latest.inputTokens,
          cacheReadTokens: snap.latest.cacheReadTokens,
          outputTokens: snap.latest.outputTokens,
          thinkingTokens: snap.latest.thinkingTokens,
          cacheHitRate: snap.latest.cacheHitRate,
          turnCount: snap.turnCount,
          totalTokens: snap.totals.totalTokens,
          estimatedCostUsd: snap.totals.estimatedCostUsd,
          recentTurns: snap.recentTurns
        });
      }
    }
  }
  allSessions.sort((a, b) => b.lastTs - a.lastTs);

  return {
    ok: true,
    generatedAt: history.generatedAt,
    sources: history.sources,
    periods: history.periods,
    heatmap: history.heatmap,
    sessions: allSessions.slice(0, 15)
  };
}

function createDashboardServer(options = {}) {
  const htmlPath = path.join(__dirname, 'dashboard.html');
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/data') {
      const payload = buildDashboardPayload(options);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

if (require.main === module) {
  const portArgIdx = process.argv.indexOf('--port');
  const port = portArgIdx >= 0 && process.argv[portArgIdx + 1] ? Number(process.argv[portArgIdx + 1]) : 18765;
  const server = createDashboardServer();
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`✅ Antigravity Lite Meter 本地网页看板已启动（零改盘、零外联）`);
    console.log(`   浏览器打开: http://127.0.0.1:${addr.port}`);
    console.log(`   按 Ctrl+C 停止`);
  });
}

module.exports = {
  buildDashboardPayload,
  createDashboardServer
};
