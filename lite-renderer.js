(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__AGLiteMeter && typeof window.__AGLiteMeter.dispose === 'function') {
    try { window.__AGLiteMeter.dispose(); } catch {}
  }

  const HOST_ID = 'ag-lite-meter-host';
  const STORAGE_KEY_WINDOW = 'ag_lite_meter_display_window_v1';
  const REFRESH_MS = 4000;
  const HISTORY_REFRESH_MS = 20000;

  const state = {
    disposed: false,
    route: null,
    open: false,
    activeTab: 'session', // 'session' | 'history'
    period: 'today',      // 'today' | 'week' | 'month' | 'all'
    displayWindow: Number(localStorage.getItem(STORAGE_KEY_WINDOW)) || 256000,
    session: null,
    liveTurn: null,
    history: null,
    lastHistoryAt: 0,
    loading: false,
    timers: [],
    observers: []
  };

  function getRouteId() {
    const m = location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i);
    return m ? m[1] : null;
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B';
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
    if (v >= 10_000) return (v / 1_000).toFixed(1) + 'K';
    if (v >= 1_000) return (v / 1_000).toFixed(2) + 'K';
    return String(Math.round(v));
  }

  function fmtUsd(v) {
    const n = Number(v) || 0;
    if (n === 0) return '$0.00';
    if (n < 0.01) return '<$0.01';
    return '$' + n.toFixed(2);
  }

  function fmtTime(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function detectDarkTheme() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor || '';
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
        return lum < 140;
      }
    } catch {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // 仅向本机同源 127.0.0.1 读取当前会话最新一轮元数据（防止 transcript.jsonl 延迟刷盘）
  async function fetchSameOriginLiveTurn(cascadeId) {
    if (!cascadeId || location.hostname !== '127.0.0.1') return null;
    const csrf = window.__APP_CONFIG__ && window.__APP_CONFIG__.csrfToken;
    if (!csrf) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf
        },
        body: JSON.stringify({ cascadeId, generatorMetadataOffset: 0, includeMessages: false }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!resp.ok) return null;
      const data = await resp.json();
      const rows = Array.isArray(data && data.generatorMetadata) ? data.generatorMetadata : [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const cm = rows[i] && rows[i].chatModel;
        const u = cm && cm.usage;
        if (!u) continue;
        const inp = Number(u.inputTokens || 0);
        const cap = Number(u.cacheReadTokens || 0);
        const out = Number(u.outputTokens || 0);
        const thk = Number(u.thinkingOutputTokens || 0);
        if (inp + cap + out > 0) {
          const promptTot = inp + cap;
          return {
            cascadeId,
            modelLabel: cm.modelDisplayName || cm.responseModel || cm.model || '',
            inputTokens: inp,
            cacheReadTokens: cap,
            outputTokens: out,
            thinkingTokens: thk,
            contextTokens: promptTot,
            cacheHitRate: promptTot > 0 ? Number(((cap / promptTot) * 100).toFixed(1)) : 0,
            turnCount: rows.length
          };
        }
      }
    } catch {}
    return null;
  }

  function getEffectiveContext() {
    const diskLatest = state.session && state.session.latest ? state.session.latest : null;
    const live = state.liveTurn && state.liveTurn.cascadeId === state.route ? state.liveTurn : null;
    if (live && (!diskLatest || live.contextTokens >= diskLatest.contextTokens)) {
      return {
        modelLabel: live.modelLabel || (diskLatest && diskLatest.modelLabel) || '',
        inputTokens: live.inputTokens,
        cacheReadTokens: live.cacheReadTokens,
        outputTokens: live.outputTokens,
        thinkingTokens: live.thinkingTokens,
        contextTokens: live.contextTokens,
        cacheHitRate: live.cacheHitRate,
        source: 'live'
      };
    }
    if (diskLatest) {
      return {
        modelLabel: diskLatest.modelLabel || '',
        inputTokens: diskLatest.inputTokens,
        cacheReadTokens: diskLatest.cacheReadTokens,
        outputTokens: diskLatest.outputTokens,
        thinkingTokens: diskLatest.thinkingTokens,
        contextTokens: diskLatest.contextTokens,
        cacheHitRate: diskLatest.cacheHitRate,
        source: 'disk'
      };
    }
    return null;
  }

  // 创建宿主 DOM 与 Shadow DOM
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'display:inline-flex;align-items:center;position:relative;z-index:9999;-webkit-app-region:no-drag;app-region:no-drag;flex-shrink:0;margin-right:6px;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host {
        --bg: #1b1d22;
        --bg-elev: #23262e;
        --bg-soft: rgba(255, 255, 255, 0.05);
        --border: rgba(255, 255, 255, 0.11);
        --text: #e6e8ee;
        --muted: #9aa0ae;
        --accent: #4c9aff;
        --green: #38c172;
        --amber: #f59e0b;
        --red: #ef4444;
        --heat-0: rgba(255,255,255,0.06);
        --heat-1: #144620;
        --heat-2: #1f6f35;
        --heat-3: #2ea043;
        --heat-4: #56d364;
        --shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 12px;
        color: var(--text);
        user-select: none;
      }
      :host([data-theme="light"]) {
        --bg: #ffffff;
        --bg-elev: #f5f7fa;
        --bg-soft: rgba(0, 0, 0, 0.045);
        --border: rgba(0, 0, 0, 0.11);
        --text: #1c2026;
        --muted: #5d6675;
        --accent: #2563eb;
        --green: #16a34a;
        --amber: #d97706;
        --red: #dc2626;
        --heat-0: rgba(0,0,0,0.06);
        --heat-1: #c6e48b;
        --heat-2: #7bc96f;
        --heat-3: #239a3b;
        --heat-4: #196127;
        --shadow: 0 10px 28px rgba(15, 23, 42, 0.16);
      }
      * { box-sizing: border-box; }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 26px;
        padding: 0 10px;
        border-radius: 999px;
        background: var(--bg-soft);
        border: 1px solid var(--border);
        color: var(--text);
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .pill:hover {
        background: var(--bg-elev);
        border-color: var(--accent);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--green);
        flex-shrink: 0;
      }
      .dot.warn { background: var(--amber); }
      .dot.danger { background: var(--red); }
      .pill-bar-wrap {
        width: 34px;
        height: 5px;
        border-radius: 999px;
        background: rgba(128,128,128,0.22);
        overflow: hidden;
      }
      .pill-bar {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: var(--green);
        transition: width 0.25s ease;
      }
      .pill-bar.warn { background: var(--amber); }
      .pill-bar.danger { background: var(--red); }
      .pill-sep {
        width: 1px;
        height: 11px;
        background: var(--border);
      }
      .pill-today {
        color: var(--muted);
        font-size: 11px;
      }
      .panel {
        display: none;
        position: fixed;
        top: 42px;
        right: 14px;
        width: 440px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 60px);
        overflow-y: auto;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: var(--shadow);
        padding: 12px 14px 14px;
        z-index: 2147483647;
      }
      .panel.open { display: block; }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      .tabs {
        display: inline-flex;
        background: var(--bg-soft);
        border-radius: 8px;
        padding: 2px;
        gap: 2px;
      }
      .tab {
        border: none;
        background: transparent;
        color: var(--muted);
        padding: 5px 11px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
      }
      .tab.active {
        background: var(--bg-elev);
        color: var(--text);
        box-shadow: 0 1px 2px rgba(0,0,0,0.18);
      }
      .head-right {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .badge-local {
        font-size: 10px;
        color: var(--green);
        background: rgba(56, 193, 114, 0.12);
        border: 1px solid rgba(56, 193, 114, 0.25);
        padding: 2px 6px;
        border-radius: 999px;
      }
      .icon-btn {
        border: 1px solid var(--border);
        background: var(--bg-soft);
        color: var(--text);
        border-radius: 6px;
        height: 24px;
        padding: 0 8px;
        font-size: 11px;
        cursor: pointer;
      }
      .icon-btn:hover { border-color: var(--accent); }
      .card {
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 10px;
      }
      .row-between {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .big-num {
        font-size: 18px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .muted { color: var(--muted); font-size: 11px; }
      .progress-track {
        margin: 8px 0 6px;
        height: 8px;
        width: 100%;
        border-radius: 999px;
        background: rgba(128,128,128,0.2);
        overflow: hidden;
        display: flex;
      }
      .prog-cache { background: var(--accent); height: 100%; transition: width 0.25s; }
      .prog-input { background: var(--green); height: 100%; transition: width 0.25s; }
      .prog-input.warn { background: var(--amber); }
      .prog-input.danger { background: var(--red); }
      .legend {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: var(--muted);
        flex-wrap: wrap;
      }
      .legend i {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        margin-right: 4px;
        vertical-align: middle;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 10px;
      }
      .kpi {
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 10px;
      }
      .kpi-label { font-size: 11px; color: var(--muted); margin-bottom: 3px; }
      .kpi-val { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .win-select {
        background: var(--bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 2px 6px;
        font-size: 11px;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .turn-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        padding: 5px 8px;
        border-radius: 6px;
        background: var(--bg-soft);
        font-variant-numeric: tabular-nums;
      }
      .periods {
        display: flex;
        gap: 4px;
        margin-bottom: 10px;
      }
      .period-btn {
        flex: 1;
        border: 1px solid var(--border);
        background: var(--bg-soft);
        color: var(--muted);
        border-radius: 7px;
        padding: 5px 0;
        font-size: 11px;
        cursor: pointer;
      }
      .period-btn.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
        font-weight: 600;
      }
      .heatmap-wrap {
        overflow-x: auto;
        padding: 4px 0;
      }
      .heatmap-grid {
        display: grid;
        grid-template-rows: repeat(7, 6px);
        grid-auto-flow: column;
        grid-auto-columns: 6px;
        gap: 2px;
        width: max-content;
      }
      .heat-cell {
        width: 6px;
        height: 6px;
        border-radius: 1.5px;
        background: var(--heat-0);
      }
      .heat-cell[data-l="1"] { background: var(--heat-1); }
      .heat-cell[data-l="2"] { background: var(--heat-2); }
      .heat-cell[data-l="3"] { background: var(--heat-3); }
      .heat-cell[data-l="4"] { background: var(--heat-4); }
      .model-row {
        margin-bottom: 8px;
      }
      .model-bar-bg {
        height: 5px;
        background: rgba(128,128,128,0.18);
        border-radius: 999px;
        overflow: hidden;
        margin-top: 4px;
      }
      .model-bar-fill {
        height: 100%;
        background: var(--accent);
        border-radius: 999px;
      }
      .foot-note {
        font-size: 10px;
        color: var(--muted);
        text-align: center;
        margin-top: 6px;
      }
    </style>
    <button class="pill" id="pill" title="点击展开上下文与 Token 统计（纯本地只读）">
      <span class="dot" id="pill-dot"></span>
      <span class="pill-bar-wrap"><span class="pill-bar" id="pill-bar"></span></span>
      <span id="pill-ctx">上下文 --</span>
      <span class="pill-sep"></span>
      <span class="pill-today" id="pill-today">今日 --</span>
    </button>
    <div class="panel" id="panel">
      <div class="panel-head">
        <div class="tabs">
          <button class="tab active" data-tab="session">当前会话</button>
          <button class="tab" data-tab="history">历史 &amp; 热力图</button>
        </div>
        <div class="head-right">
          <span class="badge-local" title="仅只读本地日志，零外联、零凭据访问">纯本地只读</span>
          <button class="icon-btn" id="btn-refresh">刷新</button>
        </div>
      </div>
      <div id="body"></div>
      <div class="foot-note">Antigravity Lite Meter · 零外网请求 · API 费用仅为公开费率参考</div>
    </div>
  `;

  const pillEl = shadow.getElementById('pill');
  const pillDot = shadow.getElementById('pill-dot');
  const pillBar = shadow.getElementById('pill-bar');
  const pillCtx = shadow.getElementById('pill-ctx');
  const pillToday = shadow.getElementById('pill-today');
  const panelEl = shadow.getElementById('panel');
  const bodyEl = shadow.getElementById('body');
  const btnRefresh = shadow.getElementById('btn-refresh');

  function updateTheme() {
    host.setAttribute('data-theme', detectDarkTheme() ? 'dark' : 'light');
  }

  function positionPanel() {
    if (!state.open) return;
    const rect = pillEl.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 100, Math.max(36, Math.round(rect.bottom + 8)));
    const right = Math.max(12, Math.round(window.innerWidth - rect.right));
    panelEl.style.top = top + 'px';
    panelEl.style.right = right + 'px';
  }

  function renderPill() {
    const ctx = getEffectiveContext();
    const denom = state.displayWindow || 256000;
    const used = ctx ? ctx.contextTokens : 0;
    const pct = denom > 0 ? Math.min(100, Math.round((used / denom) * 100)) : 0;
    const levelClass = pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : '';

    pillDot.className = 'dot' + (levelClass ? ' ' + levelClass : '');
    pillBar.className = 'pill-bar' + (levelClass ? ' ' + levelClass : '');
    pillBar.style.width = pct + '%';

    if (ctx && used > 0) {
      pillCtx.textContent = `${fmtTokens(used)} / ${fmtTokens(denom)} · ${pct}%`;
    } else if (state.route) {
      pillCtx.textContent = '新会话 · 0%';
    } else {
      pillCtx.textContent = 'Token 看板';
    }

    const todayTok = state.history && state.history.periods && state.history.periods.today
      ? state.history.periods.today.totalTokens
      : null;
    pillToday.textContent = todayTok != null ? `今日 ${fmtTokens(todayTok)}` : '今日 --';
  }

  function renderSessionTab() {
    const ctx = getEffectiveContext();
    const denom = state.displayWindow || 256000;
    const used = ctx ? ctx.contextTokens : 0;
    const pct = denom > 0 ? Math.min(100, (used / denom) * 100) : 0;
    const pctStr = pct.toFixed(1) + '%';
    const remaining = Math.max(0, denom - used);
    const cachePct = denom > 0 && ctx ? Math.min(100, (ctx.cacheReadTokens / denom) * 100) : 0;
    const inputPct = denom > 0 && ctx ? Math.min(100 - cachePct, (ctx.inputTokens / denom) * 100) : 0;
    const warnCls = pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : '';

    const totals = (state.session && state.session.totals) || {
      inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, estimatedCostUsd: 0
    };
    const turns = (state.session && state.session.recentTurns) || [];
    const modelName = (ctx && ctx.modelLabel) || (state.session && state.session.modelLabel) || '等待对话数据';

    const winOptions = [
      { v: 256000, label: '256K (默认)' },
      { v: 512000, label: '512K' },
      { v: 1000000, label: '1M' }
    ].map(o => `<option value="${o.v}"${o.v === denom ? ' selected' : ''}>${o.label}</option>`).join('');

    const turnsHtml = turns.length > 0
      ? turns.slice(0, 8).map(t => `
          <div class="turn-item">
            <span>${fmtTime(t.ts)} · ${escapeHtml(t.modelLabel || '模型')}</span>
            <span>上下文 ${fmtTokens(t.contextTokens)} · 出 ${fmtTokens(t.outputTokens)} · ${fmtUsd(t.costUsd)}</span>
          </div>
        `).join('')
      : '<div class="muted" style="padding:8px 0;text-align:center;">当前会话暂无已落盘的 Token 记录（发送一轮消息后自动更新）</div>';

    bodyEl.innerHTML = `
      <div class="card">
        <div class="row-between">
          <div>
            <div class="muted">当前会话上下文占用 · ${escapeHtml(modelName)}</div>
            <div class="big-num">${fmtTokens(used)} <span class="muted">/ ${fmtTokens(denom)} (${pctStr})</span></div>
          </div>
          <select class="win-select" id="sel-window" title="仅调整显示分母，不修改客户端设置">${winOptions}</select>
        </div>
        <div class="progress-track">
          <div class="prog-cache" style="width:${cachePct.toFixed(2)}%"></div>
          <div class="prog-input ${warnCls}" style="width:${inputPct.toFixed(2)}%"></div>
        </div>
        <div class="legend">
          <span><i style="background:var(--accent)"></i>缓存命中 ${fmtTokens(ctx ? ctx.cacheReadTokens : 0)}</span>
          <span><i style="background:var(--green)"></i>新增输入 ${fmtTokens(ctx ? ctx.inputTokens : 0)}</span>
          <span>剩余空间 ${fmtTokens(remaining)}</span>
        </div>
      </div>

      <div class="grid-2">
        <div class="kpi">
          <div class="kpi-label">本轮缓存命中率</div>
          <div class="kpi-val">${ctx ? ctx.cacheHitRate + '%' : '--'}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">本轮输出 / 思考</div>
          <div class="kpi-val">${ctx ? fmtTokens(ctx.outputTokens) : '--'} <span class="muted">/ ${ctx ? fmtTokens(ctx.thinkingTokens) : '--'}</span></div>
        </div>
        <div class="kpi">
          <div class="kpi-label">会话累计 Token (${(state.session && state.session.turnCount) || 0} 轮)</div>
          <div class="kpi-val">${fmtTokens(totals.totalTokens)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">会话参考 API 费用</div>
          <div class="kpi-val">${fmtUsd(totals.estimatedCostUsd)}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:0;">
        <div class="row-between" style="margin-bottom:6px;">
          <span style="font-weight:600;">最近调用明细</span>
          <span class="muted">${state.route ? state.route.slice(0, 8) : '未进入会话'}</span>
        </div>
        <div class="list">${turnsHtml}</div>
      </div>
    `;

    const sel = bodyEl.querySelector('#sel-window');
    if (sel) {
      sel.addEventListener('change', () => {
        const val = Number(sel.value) || 256000;
        state.displayWindow = val;
        try { localStorage.setItem(STORAGE_KEY_WINDOW, String(val)); } catch {}
        render();
      });
    }
  }

  function renderHistoryTab() {
    const h = state.history;
    if (!h || !h.periods) {
      bodyEl.innerHTML = '<div class="muted" style="padding:20px;text-align:center;">正在扫描本地历史日志...</div>';
      return;
    }

    const p = h.periods[state.period] || h.periods.today;
    const periodBtns = [
      { id: 'today', label: '今日' },
      { id: 'week', label: '近 7 天' },
      { id: 'month', label: '近 30 天' },
      { id: 'all', label: '全部' }
    ].map(b => `<button class="period-btn${b.id === state.period ? ' active' : ''}" data-period="${b.id}">${b.label}</button>`).join('');

    const heatDays = (h.heatmap && h.heatmap.days) || [];
    const heatCells = heatDays.map(d =>
      `<div class="heat-cell" data-l="${d.level}" title="${d.date}: ${fmtTokens(d.tokens)} tokens (${d.calls} 次调用)"></div>`
    ).join('');

    const models = p.models || [];
    const maxModelTok = models.length > 0 ? Math.max(1, models[0].totalTokens) : 1;
    const modelsHtml = models.length > 0
      ? models.slice(0, 8).map(m => {
          const w = Math.max(3, Math.round((m.totalTokens / maxModelTok) * 100));
          return `
            <div class="model-row">
              <div class="row-between">
                <span>${escapeHtml(m.modelLabel)} <span class="muted">(${m.calls}次)</span></span>
                <span><b>${fmtTokens(m.totalTokens)}</b> · ${fmtUsd(m.estimatedCostUsd)}</span>
              </div>
              <div class="muted">输入 ${fmtTokens(m.inputTokens)} · 缓存 ${fmtTokens(m.cacheReadTokens)} · 输出 ${fmtTokens(m.outputTokens)}</div>
              <div class="model-bar-bg"><div class="model-bar-fill" style="width:${w}%"></div></div>
            </div>
          `;
        }).join('')
      : '<div class="muted" style="padding:8px 0;text-align:center;">该周期内暂无 Token 记录</div>';

    bodyEl.innerHTML = `
      <div class="periods">${periodBtns}</div>

      <div class="grid-2">
        <div class="kpi">
          <div class="kpi-label">周期总 Token</div>
          <div class="kpi-val">${fmtTokens(p.totalTokens)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">参考 API 费用</div>
          <div class="kpi-val">${fmtUsd(p.estimatedCostUsd)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">输入 / 缓存 / 输出</div>
          <div class="kpi-val" style="font-size:12px;">${fmtTokens(p.inputTokens)} / ${fmtTokens(p.cacheReadTokens)} / ${fmtTokens(p.outputTokens)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">调用次数 / 会话 / 缓存率</div>
          <div class="kpi-val" style="font-size:12px;">${p.calls} 次 / ${p.sessions} 会话 / ${p.cacheHitRate}%</div>
        </div>
      </div>

      <div class="card">
        <div class="row-between" style="margin-bottom:6px;">
          <span style="font-weight:600;">52 周活跃热力图</span>
          <span class="muted">活跃 ${h.heatmap.activeDays} 天 · 连续 ${h.heatmap.currentStreak} 天</span>
        </div>
        <div class="heatmap-wrap"><div class="heatmap-grid">${heatCells}</div></div>
      </div>

      <div class="card" style="margin-bottom:0;">
        <div class="row-between" style="margin-bottom:8px;">
          <span style="font-weight:600;">模型用量分布</span>
          <span class="muted">已扫描 ${h.sources.desktopFiles + h.sources.cliFiles} 个日志</span>
        </div>
        ${modelsHtml}
      </div>
    `;

    bodyEl.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.period = btn.getAttribute('data-period') || 'today';
        render();
      });
    });
  }

  function render() {
    updateTheme();
    renderPill();
    if (!state.open) return;
    positionPanel();
    shadow.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-tab') === state.activeTab);
    });
    if (state.activeTab === 'history') renderHistoryTab();
    else renderSessionTab();
  }

  function mountHost() {
    const titlebar = document.querySelector('[class*="@container/titlebar"]');
    if (titlebar) {
      const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
      const target = (rightGroup && rightGroup !== titlebar.firstElementChild) ? rightGroup : titlebar;
      host.style.position = 'relative';
      host.style.top = '';
      host.style.right = '';
      if (host.parentNode !== target) {
        if (target !== titlebar && target.firstChild) {
          target.insertBefore(host, target.firstChild);
        } else {
          target.appendChild(host);
        }
      }
      return;
    }
    // 兜底挂载：若宿主新版更改了标题栏类名，自动贴靠右上角显示
    host.style.position = 'fixed';
    host.style.top = '7px';
    host.style.right = '148px';
    if (host.parentNode !== document.body && document.body) {
      document.body.appendChild(host);
    }
  }

  async function refreshData(forceHistory = false) {
    if (state.disposed || state.loading) return;
    if (document.hidden && !forceHistory) return;
    state.loading = true;
    try {
      const api = window.agLiteMeterAPI;
      const cid = getRouteId();
      if (cid !== state.route) {
        state.route = cid;
        state.liveTurn = null;
      }

      const tasks = [];
      if (api && typeof api.getSession === 'function') {
        tasks.push(
          api.getSession(cid).then(res => { state.session = res; }).catch(() => {})
        );
      }
      if (cid) {
        tasks.push(
          fetchSameOriginLiveTurn(cid).then(live => {
            if (live) state.liveTurn = live;
          }).catch(() => {})
        );
      }
      const needHistory = forceHistory || !state.history || (Date.now() - state.lastHistoryAt >= HISTORY_REFRESH_MS);
      if (needHistory && api && typeof api.getHistory === 'function') {
        tasks.push(
          api.getHistory().then(res => {
            state.history = res;
            state.lastHistoryAt = Date.now();
          }).catch(() => {})
        );
      }

      await Promise.all(tasks);
      mountHost();
      render();
    } finally {
      state.loading = false;
    }
  }

  // 事件绑定
  pillEl.addEventListener('click', (e) => {
    e.stopPropagation();
    state.open = !state.open;
    panelEl.classList.toggle('open', state.open);
    if (state.open) {
      render();
      void refreshData(true);
    }
  });

  shadow.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.getAttribute('data-tab') || 'session';
      render();
      if (state.activeTab === 'history') void refreshData(true);
    });
  });

  btnRefresh.addEventListener('click', () => {
    void refreshData(true);
  });

  const onDocClick = (e) => {
    if (!state.open) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(host)) {
      state.open = false;
      panelEl.classList.remove('open');
    }
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && state.open) {
      state.open = false;
      panelEl.classList.remove('open');
    }
  };
  const onResize = () => positionPanel();
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  // 监听 DOM 变化保持顶栏挂载不丢失（SPA 路由切换时）
  const mo = new MutationObserver(() => {
    if (state.disposed) return;
    if (!host.isConnected || (document.querySelector('[class*="@container/titlebar"]') && host.style.position === 'fixed')) {
      mountHost();
    }
    const cid = getRouteId();
    if (cid !== state.route) {
      void refreshData(false);
    }
  });
  if (document.body) {
    mo.observe(document.body, { childList: true, subtree: true });
    state.observers.push(mo);
  }

  const pollTimer = setInterval(() => {
    if (!state.disposed) void refreshData(false);
  }, REFRESH_MS);
  state.timers.push(pollTimer);

  mountHost();
  render();
  void refreshData(true);

  window.__AGLiteMeter = {
    version: '1.0.0',
    refresh: () => refreshData(true),
    dispose: () => {
      state.disposed = true;
      state.timers.forEach(clearInterval);
      state.observers.forEach(o => { try { o.disconnect(); } catch {} });
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
      try { host.remove(); } catch {}
    }
  };
})();
