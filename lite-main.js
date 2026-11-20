'use strict';
/**
 * Antigravity Lite Meter — 极简只读 Electron 主进程钩子
 *
 * 安全边界：
 * - 仅注册 3 个只读 IPC 通道（session / history / info）
 * - 仅允许来自本机 127.0.0.1 主 Frame 的调用
 * - 零外网请求、零代理修改、零凭据读写、零二进制补丁
 */
const fs = require('fs');
const path = require('path');
const { getSessionSnapshot, getHistorySnapshot } = require('./scanner');

let ipcMain = null;
let app = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') {
    ipcMain = electron.ipcMain;
    app = electron.app;
  }
} catch {}

const VERSION = '1.0.0';
let ipcRegistered = false;
const boundWindows = new WeakSet();
const boundWebContents = new WeakSet();
const injectTimers = new WeakMap();
const probeTimers = new WeakMap();

function isLocalMainFrameSender(event) {
  try {
    const rawUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    const u = new URL(rawUrl);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname !== '127.0.0.1') {
      return false;
    }
    if (event.senderFrame && event.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getWindowWebContents(win) {
  if (!win || win.isDestroyed?.()) return null;
  if (win.webContents && !win.webContents.isDestroyed?.()) {
    return win.webContents;
  }
  try {
    const children = win.contentView?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const u = child.webContents.getURL?.() || '';
          if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(u)) return child.webContents;
        }
      }
      for (const child of children) {
        if (child?.webContents && !child.webContents.isDestroyed?.()) {
          const u = child.webContents.getURL?.() || '';
          if (!u.startsWith('data:')) return child.webContents;
        }
      }
    }
  } catch {}
  return null;
}

function registerIpcOnce() {
  if (ipcRegistered || !ipcMain || typeof ipcMain.handle !== 'function') return;
  ipcRegistered = true;

  ipcMain.handle('ag-lite-meter:info', (event) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Forbidden');
    return {
      ok: true,
      version: VERSION,
      mode: 'local-readonly',
      networkAccess: false
    };
  });

  ipcMain.handle('ag-lite-meter:session', (event, cascadeId) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Forbidden');
    const cleanId = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    return getSessionSnapshot(cleanId || null);
  });

  ipcMain.handle('ag-lite-meter:history', (event) => {
    if (!isLocalMainFrameSender(event)) throw new Error('Forbidden');
    return getHistorySnapshot();
  });
}

function getRendererSource() {
  try {
    return fs.readFileSync(path.join(__dirname, 'lite-renderer.js'), 'utf8') + '\ntrue;';
  } catch {
    return '';
  }
}

async function ensureInjected(win, options = {}) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const wc = getWindowWebContents(win);
    const url = wc?.getURL?.() || '';
    if (!wc || wc.isDestroyed?.() || !/^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      const attempt = Number(options.attempt || 0);
      const delays = [300, 700, 1500, 2500];
      if (attempt < delays.length && !win.isDestroyed?.()) {
        const prev = injectTimers.get(win);
        if (prev) clearTimeout(prev);
        injectTimers.set(
          win,
          setTimeout(() => {
            injectTimers.delete(win);
            void ensureInjected(win, { ...options, attempt: attempt + 1 });
          }, delays[attempt])
        );
      }
      return false;
    }

    if (!options.force) {
      try {
        const alive = await wc.executeJavaScript(
          'Boolean(window.__AGLiteMeter && document.getElementById("ag-lite-meter-host"))'
        );
        if (alive === true) return true;
      } catch {}
    }

    const code = getRendererSource();
    if (!code) return false;
    await wc.executeJavaScript(code);
    return true;
  } catch {
    return false;
  }
}

function installLiteMeter(win) {
  registerIpcOnce();
  if (!win || win.isDestroyed?.()) return;

  if (!boundWindows.has(win)) {
    boundWindows.add(win);
    const onActivate = () => void ensureInjected(win, { force: false });
    win.on?.('show', onActivate);
    win.on?.('focus', onActivate);
    win.on?.('restore', onActivate);
  }

  const bindWc = (wc) => {
    if (!wc || boundWebContents.has(wc)) return;
    boundWebContents.add(wc);
    wc.on('dom-ready', () => void ensureInjected(win, { force: false }));
    wc.on('did-finish-load', () => void ensureInjected(win, { force: true }));
    wc.on('did-navigate', () => void ensureInjected(win, { force: false }));
    wc.on('did-navigate-in-page', () => void ensureInjected(win, { force: false }));
  };

  const wc = getWindowWebContents(win);
  if (wc) {
    bindWc(wc);
  } else {
    const prev = probeTimers.get(win);
    if (prev) clearInterval(prev);
    let retries = 0;
    const timer = setInterval(() => {
      retries++;
      const found = getWindowWebContents(win);
      if (found) {
        clearInterval(timer);
        probeTimers.delete(win);
        bindWc(found);
        void ensureInjected(win, { force: false });
      } else if (retries >= 12 || win.isDestroyed?.()) {
        clearInterval(timer);
        probeTimers.delete(win);
      }
    }, 200);
    probeTimers.set(win, timer);
    win.once?.('closed', () => {
      const t = probeTimers.get(win);
      if (t) {
        clearInterval(t);
        probeTimers.delete(win);
      }
    });
  }
}

try {
  if (app && typeof app.on === 'function') {
    const onWin = (_ev, win) => {
      try {
        installLiteMeter(win);
        void ensureInjected(win, { force: false });
      } catch {}
    };
    app.on('browser-window-created', onWin);
    app.on('base-window-created', onWin);
  }
} catch {}

module.exports = {
  VERSION,
  installLiteMeter,
  ensureInjected,
  isLocalMainFrameSender
};
