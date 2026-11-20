#!/usr/bin/env node
'use strict';
/**
 * Antigravity Lite Meter — 极简纯本地安装器 / 还原器 / 命令行状态查看器
 * 零外部依赖、零外网请求、零凭据读写、零二进制补丁。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
  getRawFs,
  sha256Buffer,
  sha256File,
  extractFile,
  listPackage,
  collectUnpackedPaths,
  extractAll,
  createPackage,
  getStateDir,
  findAsarPath
} = require('./asar-lite');
const { getHistorySnapshot, getSessionSnapshot, getGeminiDataRoots } = require('./scanner');

const UTILS_START = '// --- AG Lite Meter Start ---';
const UTILS_END = '// --- AG Lite Meter End ---';
const PRELOAD_START = '// --- AG Lite Meter Preload Start ---';
const PRELOAD_END = '// --- AG Lite Meter Preload End ---';

const ADDITION_FILES = ['pricing.js', 'scanner.js', 'lite-main.js', 'lite-renderer.js'];

function validateJsSyntax(code, filename) {
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function cleanUtils(source) {
  const re = new RegExp(`\\n?[ \\t]*${UTILS_START}[\\s\\S]*?${UTILS_END}\\n?`, 'g');
  return String(source || '').replace(re, '\n');
}

function cleanPreload(source) {
  const re = new RegExp(`\\n?[ \\t]*${PRELOAD_START}[\\s\\S]*?${PRELOAD_END}\\n?`, 'g');
  return String(source || '').replace(re, '\n');
}

function patchUtils(source) {
  const clean = cleanUtils(source);
  const re = /^([ \t]*)void win\.loadURL\(url\);/gm;
  const matches = [...clean.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(`dist/utils.js 未找到唯一的窗口加载锚点 (匹配 ${matches.length} 处)，为保护客户端已中止安装。`);
  }
  const indent = matches[0][1];
  const hook = `${indent}${UTILS_START}\n${indent}require("./lite-main").installLiteMeter(win);\n${indent}${UTILS_END}\n${indent}void win.loadURL(url);`;
  const patched = clean.replace(re, hook);
  if (!validateJsSyntax(patched, 'dist/utils.js')) {
    throw new Error('注入后 dist/utils.js 语法校验失败，已中止安装。');
  }
  return patched;
}

function patchPreload(source) {
  const clean = cleanPreload(source).trimEnd();
  const block = [
    '',
    PRELOAD_START,
    'electron_1.contextBridge.exposeInMainWorld("agLiteMeterAPI", {',
    '  getInfo: () => electron_1.ipcRenderer.invoke("ag-lite-meter:info"),',
    '  getSession: (id) => electron_1.ipcRenderer.invoke("ag-lite-meter:session", id),',
    '  getHistory: () => electron_1.ipcRenderer.invoke("ag-lite-meter:history")',
    '});',
    PRELOAD_END,
    ''
  ].join('\n');
  const patched = clean + '\n' + block;
  if (!validateJsSyntax(patched, 'dist/preload.js')) {
    throw new Error('注入后 dist/preload.js 语法校验失败，已中止安装。');
  }
  return patched;
}

function getManifestPath(stateDir) {
  return path.join(stateDir, 'manifest.json');
}

function readManifest(stateDir) {
  const p = getManifestPath(stateDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function inspectAsarStatus(asarPath) {
  const rawFs = getRawFs();
  if (!asarPath || !rawFs.existsSync(asarPath)) {
    return { found: false, patched: false };
  }
  try {
    const utils = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const preload = extractFile(asarPath, 'dist/preload.js').toString('utf8');
    const pkg = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
    const patched = utils.includes(UTILS_START) && preload.includes(PRELOAD_START);
    return {
      found: true,
      asarPath,
      hostVersion: pkg.version || 'unknown',
      patched,
      sha256: sha256File(asarPath)
    };
  } catch (e) {
    return { found: true, asarPath, patched: false, error: e.message };
  }
}

function installMeter(options = {}) {
  const rawFs = getRawFs();
  const stateDir = getStateDir(options.stateDir);
  const asarPath = findAsarPath(options.asarPath);
  const manifest = readManifest(stateDir);

  const curUtils = extractFile(asarPath, 'dist/utils.js').toString('utf8');
  const alreadyPatched = curUtils.includes(UTILS_START);
  const pkg = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
  const hostVersion = pkg.version || 'unknown';

  const backupDir = path.join(stateDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const targetHash8 = sha256Buffer(Buffer.from(path.resolve(asarPath))).slice(0, 8);
  const backupPath = path.join(backupDir, `app-${hostVersion}-${targetHash8}-original.asar`);

  let sourceArchive = asarPath;
  let originalSha256 = null;

  if (!alreadyPatched) {
    originalSha256 = sha256File(asarPath);
    rawFs.copyFileSync(asarPath, backupPath);
  } else if (manifest && manifest.backup && rawFs.existsSync(manifest.backup) && manifest.hostVersion === hostVersion) {
    const bakSha = sha256File(manifest.backup);
    if (bakSha === manifest.originalSha256) {
      sourceArchive = manifest.backup;
      originalSha256 = bakSha;
    } else {
      originalSha256 = manifest.originalSha256 || null;
    }
  } else if (rawFs.existsSync(backupPath)) {
    sourceArchive = backupPath;
    originalSha256 = sha256File(backupPath);
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const staging = path.join(os.tmpdir(), `ag-lite-meter-stage-${stamp}`);
  const packed = path.join(os.tmpdir(), `ag-lite-meter-out-${stamp}.asar`);

  try {
    fs.mkdirSync(staging, { recursive: true });
    extractAll(sourceArchive, staging);

    const baseUtils = fs.readFileSync(path.join(staging, 'dist', 'utils.js'), 'utf8');
    const basePreload = fs.readFileSync(path.join(staging, 'dist', 'preload.js'), 'utf8');

    const newUtils = patchUtils(baseUtils);
    const newPreload = patchPreload(basePreload);

    fs.writeFileSync(path.join(staging, 'dist', 'utils.js'), newUtils, 'utf8');
    fs.writeFileSync(path.join(staging, 'dist', 'preload.js'), newPreload, 'utf8');

    const srcRoot = options.sourceDir || __dirname;
    for (const file of ADDITION_FILES) {
      const src = path.join(srcRoot, file);
      if (!fs.existsSync(src)) {
        throw new Error(`缺少必需模块文件: ${file}`);
      }
      fs.copyFileSync(src, path.join(staging, 'dist', file));
    }

    const unpackedPaths = collectUnpackedPaths(sourceArchive);
    createPackage(staging, packed, { unpackedPaths });

    // 校验所有未改动的原始文件字节完全一致
    const origEntries = listPackage(sourceArchive);
    const allowedChanged = new Set([
      'dist/utils.js',
      'dist/preload.js',
      ...ADDITION_FILES.map(f => `dist/${f}`)
    ]);
    let verifiedCount = 0;
    for (const entry of origEntries) {
      const rel = entry.replace(/^\/+/, '').replace(/\\/g, '/');
      if (allowedChanged.has(rel)) continue;
      try {
        const origBuf = extractFile(sourceArchive, rel);
        const newBuf = extractFile(packed, rel);
        if (sha256Buffer(origBuf) !== sha256Buffer(newBuf)) {
          throw new Error(`完整性校验失败：未预期改动的文件 ${rel}`);
        }
        verifiedCount++;
      } catch (e) {
        if (String(e.message).includes('完整性校验失败')) throw e;
      }
    }

    // 写入目标 app.asar（若 Windows 上客户端正在运行占用文件，给出明确提示）
    try {
      rawFs.copyFileSync(packed, asarPath);
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
        throw new Error(`目标 app.asar 正被 Antigravity 进程占用或无写权限 (${e.code})。请先完全退出 Antigravity 桌面客户端（含系统托盘）后重试。`);
      }
      throw e;
    }

    const installedSha256 = sha256File(asarPath);
    const newManifest = {
      version: '1.0.0',
      hostVersion,
      asarPath,
      backup: rawFs.existsSync(backupPath) ? backupPath : (manifest?.backup || null),
      originalSha256: originalSha256 || manifest?.originalSha256 || null,
      installedSha256,
      installedAt: new Date().toISOString()
    };
    fs.writeFileSync(getManifestPath(stateDir), JSON.stringify(newManifest, null, 2), 'utf8');

    return {
      ok: true,
      asarPath,
      hostVersion,
      backup: newManifest.backup,
      verifiedUntouchedFiles: verifiedCount,
      installedSha256
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(packed)) fs.unlinkSync(packed); } catch {}
  }
}

function restoreMeter(options = {}) {
  const rawFs = getRawFs();
  const stateDir = getStateDir(options.stateDir);
  const manifest = readManifest(stateDir);
  if (!manifest || !manifest.backup || !rawFs.existsSync(manifest.backup)) {
    throw new Error('未找到可用的原始 app.asar 备份记录，无法还原。');
  }

  const targetAsar = options.asarPath ? findAsarPath(options.asarPath) : manifest.asarPath;
  const bakSha = sha256File(manifest.backup);
  if (manifest.originalSha256 && bakSha !== manifest.originalSha256) {
    throw new Error(`备份文件 SHA-256 校验失败 (期望 ${manifest.originalSha256}，实际 ${bakSha})，已拒绝还原。`);
  }

  try {
    rawFs.copyFileSync(manifest.backup, targetAsar);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
      throw new Error(`目标 app.asar 正被 Antigravity 进程占用 (${e.code})。请先完全退出 Antigravity 后再执行 restore。`);
    }
    throw e;
  }

  const restoredSha = sha256File(targetAsar);
  if (restoredSha !== bakSha) {
    throw new Error('还原后 SHA-256 校验不一致。');
  }

  return {
    ok: true,
    asarPath: targetAsar,
    restoredFrom: manifest.backup,
    sha256: restoredSha
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
  let asarPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) {
      asarPath = args[i + 1];
      i++;
    }
  }
  return { cmd, asarPath };
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return String(Math.round(v));
}

function main() {
  const { cmd, asarPath } = parseArgs(process.argv);

  if (cmd === 'check') {
    const nodeVer = process.versions.node;
    const roots = getGeminiDataRoots();
    const existingRoots = roots.filter(r => fs.existsSync(path.join(r.dir, 'brain'))).map(r => r.dir);
    let asarInfo = { found: false };
    try {
      asarInfo = inspectAsarStatus(findAsarPath(asarPath));
    } catch (e) {
      asarInfo = { found: false, error: e.message };
    }
    console.log(JSON.stringify({
      ok: true,
      nodeVersion: nodeVer,
      asar: asarInfo,
      localLogDirs: existingRoots,
      securityMode: 'pure-local-readonly (zero network, zero oauth, zero binary patch)'
    }, null, 2));
    return;
  }

  if (cmd === 'install') {
    const res = installMeter({ asarPath });
    console.log('✅ 安装成功（纯本地只读极简版）');
    console.log(`   目标路径: ${res.asarPath}`);
    console.log(`   宿主版本: v${res.hostVersion}`);
    console.log(`   原版备份: ${res.backup}`);
    console.log(`   完整校验: ${res.verifiedUntouchedFiles} 个原始文件 SHA-256 100% 一致`);
    console.log('👉 请完全退出 Antigravity 桌面客户端（含系统托盘图标）并重新打开生效。');
    return;
  }

  if (cmd === 'restore' || cmd === 'uninstall') {
    const res = restoreMeter({ asarPath });
    console.log('✅ 已无损还原原始 app.asar');
    console.log(`   目标路径: ${res.asarPath}`);
    console.log(`   SHA-256 : ${res.sha256}`);
    console.log('👉 请重启 Antigravity 桌面客户端。');
    return;
  }

  if (cmd === 'status') {
    let asarInfo = { found: false };
    try {
      asarInfo = inspectAsarStatus(findAsarPath(asarPath));
    } catch (e) {
      asarInfo = { found: false, error: e.message };
    }
    const history = getHistorySnapshot();
    const latestSession = history.latestSessionId ? getSessionSnapshot(history.latestSessionId) : null;

    console.log('=== Antigravity Lite Meter (纯本地只读版) ===');
    console.log(`客户端状态 : ${asarInfo.found ? (asarInfo.patched ? `已安装 (宿主 v${asarInfo.hostVersion})` : `未安装 (宿主 v${asarInfo.hostVersion})`) : '未检测到 app.asar'}`);
    console.log(`日志来源   : Desktop ${history.sources.desktopFiles} 份 / CLI ${history.sources.cliFiles} 份`);
    console.log(`今日 Token : ${fmtNum(history.periods.today.totalTokens)} (${history.periods.today.calls} 次调用, 参考 $${history.periods.today.estimatedCostUsd.toFixed(2)})`);
    console.log(`近 7 天    : ${fmtNum(history.periods.week.totalTokens)} (${history.periods.week.calls} 次调用, 参考 $${history.periods.week.estimatedCostUsd.toFixed(2)})`);
    console.log(`近 30 天   : ${fmtNum(history.periods.month.totalTokens)} (${history.periods.month.calls} 次调用, 参考 $${history.periods.month.estimatedCostUsd.toFixed(2)})`);
    console.log(`累计全部   : ${fmtNum(history.periods.all.totalTokens)} (${history.periods.all.calls} 次调用, 参考 $${history.periods.all.estimatedCostUsd.toFixed(2)})`);
    console.log(`52 周活跃  : ${history.heatmap.activeDays} 天活跃 / 当前连续 ${history.heatmap.currentStreak} 天`);
    if (latestSession && latestSession.hasData) {
      console.log(`最近会话   : ${latestSession.cascadeId.slice(0, 8)} · 上下文 ${fmtNum(latestSession.contextTokens)} (${latestSession.modelLabel || '模型'})`);
    }
    return;
  }

  console.log('用法: node cli.js <check | install | status | restore> [--path "<app.asar路径>"]');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ ' + (err?.message || String(err)));
    process.exitCode = 1;
  }
}

module.exports = {
  UTILS_START,
  UTILS_END,
  PRELOAD_START,
  PRELOAD_END,
  cleanUtils,
  cleanPreload,
  patchUtils,
  patchPreload,
  inspectAsarStatus,
  installMeter,
  restoreMeter
};
