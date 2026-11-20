'use strict';
/**
 * 零依赖纯原生 Node.js ASAR 读写与宿主定位模块
 * 仅使用内置 fs / os / path / crypto，不发起任何网络请求。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function getRawFs() {
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    try {
      return require('original-fs');
    } catch {}
  }
  return fs;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const rawFs = getRawFs();
  return sha256Buffer(rawFs.readFileSync(filePath));
}

function readHeader(archivePath) {
  const rawFs = getRawFs();
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    rawFs.readSync(fd, pre, 0, 16, 0);
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    rawFs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, baseOffset: 16 + jsonSize + padding };
  } finally {
    rawFs.closeSync(fd);
  }
}

function getNode(header, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      throw new Error(`ASAR 内未找到文件: ${relPath}`);
    }
    cur = cur.files[part];
  }
  return cur;
}

function extractFile(archivePath, relPath) {
  const rawFs = getRawFs();
  const { header, baseOffset } = readHeader(archivePath);
  const node = getNode(header, relPath);
  if (node.unpacked) {
    const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
    if (rawFs.existsSync(unpackedSrc)) return rawFs.readFileSync(unpackedSrc);
    return Buffer.alloc(node.size || 0);
  }
  const buf = Buffer.alloc(node.size);
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    rawFs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
    return buf;
  } finally {
    rawFs.closeSync(fd);
  }
}

function listPackage(archivePath) {
  const { header } = readHeader(archivePath);
  const list = [];
  function walk(tree, prefix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const cur = prefix + '/' + name;
      list.push(cur);
      if (info.files) walk(info, cur);
    }
  }
  walk(header, '');
  return list;
}

function collectUnpackedPaths(archivePath) {
  const { header } = readHeader(archivePath);
  const unpacked = new Set();
  function walk(tree, relPosix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const child = relPosix ? `${relPosix}/${name}` : name;
      if (info.unpacked) unpacked.add(child);
      if (info.files) walk(info, child);
    }
  }
  walk(header, '');
  return unpacked;
}

function extractAll(archivePath, destDir) {
  const rawFs = getRawFs();
  const { header, baseOffset } = readHeader(archivePath);
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    function walk(tree, currentDir, relDir) {
      fs.mkdirSync(currentDir, { recursive: true });
      for (const [name, info] of Object.entries(tree.files || {})) {
        const targetPath = path.join(currentDir, name);
        const relPath = relDir ? path.join(relDir, name) : name;
        if (info.files) {
          walk(info, targetPath, relPath);
        } else if (info.unpacked) {
          const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          if (rawFs.existsSync(unpackedSrc)) {
            rawFs.copyFileSync(unpackedSrc, targetPath);
          } else {
            fs.writeFileSync(targetPath, Buffer.alloc(0));
          }
        } else {
          const buf = Buffer.alloc(info.size);
          rawFs.readSync(fd, buf, 0, info.size, baseOffset + Number(info.offset));
          fs.writeFileSync(targetPath, buf);
        }
      }
    }
    walk(header, destDir, '');
  } finally {
    rawFs.closeSync(fd);
  }
}

function createPackage(srcDir, destAsar, options = {}) {
  const rawFs = getRawFs();
  let offset = 0;
  const chunks = [];
  const unpackedSet = options.unpackedPaths instanceof Set ? options.unpackedPaths : new Set();

  function build(currentDir, relPosix) {
    const files = {};
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const childPosix = relPosix ? `${relPosix}/${entry.name}` : entry.name;
      const isUnpacked = unpackedSet.has(childPosix);
      if (entry.isDirectory()) {
        const node = { files: build(fullPath, childPosix) };
        if (isUnpacked) node.unpacked = true;
        files[entry.name] = node;
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(fullPath);
        const hash = sha256Buffer(buf);
        const blockSize = 4 * 1024 * 1024;
        const blocks = [];
        for (let i = 0; i < buf.length; i += blockSize) {
          blocks.push(sha256Buffer(buf.subarray(i, i + blockSize)));
        }
        if (blocks.length === 0) blocks.push(sha256Buffer(Buffer.alloc(0)));
        const integrity = { algorithm: 'SHA256', hash, blockSize, blocks };
        if (isUnpacked) {
          files[entry.name] = { size: buf.length, unpacked: true, integrity };
        } else {
          files[entry.name] = { size: buf.length, offset: String(offset), integrity };
          offset += buf.length;
          chunks.push(buf);
        }
      }
    }
    return files;
  }

  const headerObj = { files: build(srcDir, '') };
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const jsonSize = jsonBuf.length;
  const padding = (4 - (jsonSize % 4)) % 4;
  const alignedSize = jsonSize + padding;
  const headerBuf = Buffer.alloc(16 + alignedSize);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedSize, 4);
  headerBuf.writeUInt32LE(4 + alignedSize, 8);
  headerBuf.writeUInt32LE(jsonSize, 12);
  jsonBuf.copy(headerBuf, 16);

  const fd = rawFs.openSync(destAsar, 'w');
  try {
    rawFs.writeSync(fd, headerBuf);
    for (const chunk of chunks) {
      rawFs.writeSync(fd, chunk);
    }
  } finally {
    rawFs.closeSync(fd);
  }
}

function getStateDir(customDir) {
  const dirOverride = customDir || process.env.AG_LITE_METER_STATE_DIR;
  if (dirOverride && String(dirOverride).trim()) {
    const resolved = path.resolve(String(dirOverride).trim());
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'));
  const dir = path.join(base, 'AntigravityLiteMeter');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findAsarPath(customPath) {
  const rawFs = getRawFs();
  const explicit = customPath || process.env.AG_ASAR_PATH;
  if (explicit && String(explicit).trim()) {
    const resolved = path.resolve(String(explicit).trim());
    if (rawFs.existsSync(resolved) && rawFs.statSync(resolved).isDirectory()) {
      for (const rel of [
        path.join('Contents', 'Resources', 'app.asar'),
        path.join('resources', 'app.asar'),
        'app.asar'
      ]) {
        const cand = path.join(resolved, rel);
        if (rawFs.existsSync(cand)) return cand;
      }
    }
    if (rawFs.existsSync(resolved)) return resolved;
    throw new Error(`未在指定路径找到 app.asar: ${explicit}`);
  }

  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar'),
      path.join(home, 'AppData', 'Roaming', 'antigravity', 'resources', 'app.asar')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Google Antigravity.app/Contents/Resources/app.asar'
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }

  for (const p of candidates) {
    if (rawFs.existsSync(p)) return p;
  }
  throw new Error('未能自动检测到 Antigravity 客户端 app.asar，请通过 --path "<app.asar路径>" 指定。');
}

module.exports = {
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
};
