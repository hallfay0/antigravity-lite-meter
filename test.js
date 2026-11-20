'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { createPackage, extractFile, sha256File } = require('./asar-lite');
const { getModelInfo, estimateReferenceCostUsd } = require('./pricing');
const { getSessionSnapshot, getHistorySnapshot, clearCache } = require('./scanner');
const { installMeter, restoreMeter, inspectAsarStatus } = require('./cli');

test('安全红线静态审计：全项目零外网模块、零外部 URL、零 OAuth/凭据/二进制补丁', () => {
  const runtimeFiles = [
    'asar-lite.js',
    'pricing.js',
    'scanner.js',
    'lite-main.js',
    'lite-renderer.js',
    'cli.js'
  ];

  const forbiddenPatterns = [
    { name: 'Node 网络模块', re: /require\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)['"]\s*\)/ },
    { name: '外部 HTTPS/HTTP 域名', re: /https?:\/\/(?!127\.0\.0\.1)[a-zA-Z0-9.-]+/ },
    { name: 'Google CloudCode 私有接口', re: /cloudcode-pa|googleapis\.com|oauth2|accounts\.google\.com/i },
    { name: '凭据与钥匙串读写', re: /CredRead|CredWrite|keychain|state\.vscdb|oauth_creds|refresh_token/i },
    { name: '二进制补丁或系统提示词篡改', re: /language_server\.exe|bin[\\/]language_server|gopclntab|embed\.FS|system_prompts|GetCheckpointConfig/i },
    { name: '非同源相对路径的 fetch 调用', re: /\bfetch\s*\(\s*['"`](?!\/)/ },
    { name: '动态代码执行', re: /\beval\s*\(|new\s+Function\s*\(/ }
  ];

  for (const file of runtimeFiles) {
    const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
    for (const rule of forbiddenPatterns) {
      assert.equal(
        rule.re.test(content),
        false,
        `文件 ${file} 违反安全红线: ${rule.name}`
      );
    }
    // 确认所有运行时脚本语法合法
    new vm.Script(content, { filename: file });
  }
});

test('模型归一化与参考 API 费用估算准确', () => {
  const info = getModelInfo('Gemini 4 Hydrogen (High)');
  assert.equal(info.key, 'gemini-4-hydrogen');
  assert.equal(info.isKnown, true);

  // 1M input ($1.50) + 1M cacheRead ($0.075) + 1M output ($7.50) = $9.075
  const cost = estimateReferenceCostUsd(
    { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
    'Gemini 4 Hydrogen'
  );
  assert.equal(cost, 9.075);
});

test('本地 transcript.jsonl 扫描：上下文占用、去重、周期汇总与 52 周热力图', () => {
  clearCache();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lite-scan-'));
  try {
    const cid = '11111111-2222-3333-4444-555555555555';
    const logDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });

    const now = new Date('2026-11-19T12:00:00Z');
    const twoDaysAgo = new Date('2026-11-17T12:00:00Z');

    const lines = [
      // 2 天前调用
      JSON.stringify({
        created_at: twoDaysAgo.toISOString(),
        step_index: 1,
        responseId: 'resp-1',
        model: 'Gemini 3.8 Flash',
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 2000
      }),
      // 重复 responseId（应去重，仅保留较大一条）
      JSON.stringify({
        created_at: twoDaysAgo.toISOString(),
        step_index: 1,
        responseId: 'resp-1',
        model: 'Gemini 3.8 Flash',
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 2000
      }),
      // 今天最新调用（带缓存命中与思考输出）
      JSON.stringify({
        created_at: now.toISOString(),
        step_index: 2,
        responseId: 'resp-2',
        chatModel: {
          modelDisplayName: 'Gemini 4 Hydrogen',
          usage: {
            inputTokens: 12000,
            cacheReadTokens: 48000,
            outputTokens: 3000,
            thinkingOutputTokens: 1000
          }
        }
      })
    ];
    fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf8');

    const session = getSessionSnapshot(cid, { homeDir: tmpHome });
    assert.equal(session.hasData, true);
    assert.equal(session.turnCount, 2);
    // 最新上下文 = 12000 + 48000 = 60000
    assert.equal(session.contextTokens, 60000);
    assert.equal(session.latest.cacheHitRate, 80);
    assert.equal(session.latest.thinkingTokens, 1000);
    assert.equal(session.totals.totalTokens, 12000 + 63000);

    const history = getHistorySnapshot({ homeDir: tmpHome, now });
    assert.equal(history.sources.desktopFiles, 1);
    assert.equal(history.periods.today.totalTokens, 63000);
    assert.equal(history.periods.today.calls, 1);
    assert.equal(history.periods.week.totalTokens, 75000);
    assert.equal(history.periods.week.calls, 2);
    assert.equal(history.periods.all.models.length, 2);
    assert.equal(history.heatmap.days.length, 364);
    assert.equal(history.heatmap.activeDays, 2);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('ASAR 安装、重复安装幂等性、未修改文件校验与无损还原', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lite-asar-'));
  const stateDir = path.join(tmpDir, 'state');
  const mockSrc = path.join(tmpDir, 'mock-app');
  const asarPath = path.join(tmpDir, 'app.asar');

  try {
    fs.mkdirSync(path.join(mockSrc, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mockSrc, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.32.1' }));
    fs.writeFileSync(
      path.join(mockSrc, 'dist', 'utils.js'),
      '"use strict";\nfunction createWindow(url) {\n    const win = {};\n    void win.loadURL(url);\n    return win;\n}\nmodule.exports = { createWindow };\n'
    );
    fs.writeFileSync(
      path.join(mockSrc, 'dist', 'preload.js'),
      '"use strict";\nconst electron_1 = require("electron");\nelectron_1.contextBridge.exposeInMainWorld("hostAPI", {});\n'
    );
    fs.writeFileSync(path.join(mockSrc, 'dist', 'unchanged.txt'), 'DO NOT TOUCH THIS FILE');

    createPackage(mockSrc, asarPath);
    const origSha = sha256File(asarPath);

    // 1. 首次安装
    const res1 = installMeter({ asarPath, stateDir });
    assert.equal(res1.ok, true);
    assert.equal(res1.hostVersion, '2.32.1');
    assert.ok(res1.verifiedUntouchedFiles >= 2);
    assert.equal(inspectAsarStatus(asarPath).patched, true);
    assert.equal(extractFile(asarPath, 'dist/unchanged.txt').toString('utf8'), 'DO NOT TOUCH THIS FILE');

    // 验证注入文件存在且语法正确
    const patchedUtils = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const patchedPreload = extractFile(asarPath, 'dist/preload.js').toString('utf8');
    new vm.Script(patchedUtils, { filename: 'dist/utils.js' });
    new vm.Script(patchedPreload, { filename: 'dist/preload.js' });
    assert.ok(patchedUtils.includes('require("./lite-main").installLiteMeter(win);'));
    assert.ok(patchedPreload.includes('agLiteMeterAPI'));

    // 2. 幂等重复安装
    const res2 = installMeter({ asarPath, stateDir });
    assert.equal(res2.ok, true);
    const patchedUtils2 = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    assert.equal(patchedUtils2.split('installLiteMeter').length, 2);

    // 3. 无损还原，字节级恢复原版 SHA-256
    const restored = restoreMeter({ asarPath, stateDir });
    assert.equal(restored.ok, true);
    assert.equal(restored.sha256, origSha);
    assert.equal(sha256File(asarPath), origSha);
    assert.equal(inspectAsarStatus(asarPath).patched, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('macOS 原生菜单栏 Swift 应用与网页看板安全红线审计', () => {
  const swiftCode = fs.readFileSync(path.join(__dirname, 'macos', 'AntigravityMeterMenuBar.swift'), 'utf8');
  const htmlCode = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const webServerCode = fs.readFileSync(path.join(__dirname, 'web-dashboard.js'), 'utf8');

  // Swift 菜单栏应用：严禁任何网络请求、凭据/Keychain、或写文件操作
  assert.equal(/URLSession|NWConnection|CFNetwork|SecItemCopyMatching|SecKeychain|cloudcode-pa|googleapis\.com|oauth/i.test(swiftCode), false);
  assert.equal(/https?:\/\/[a-zA-Z0-9.-]+/.test(swiftCode), false);

  // dashboard.html：严禁外部 CDN、外部链接请求、eval
  assert.equal(/https?:\/\/[a-zA-Z0-9.-]+/.test(htmlCode), false);
  assert.equal(/\bfetch\s*\(\s*['"`](?!\/)/.test(htmlCode), false);

  // web-dashboard.js：仅监听 127.0.0.1，严禁任何外发请求
  assert.equal(/https\.request|http\.request|\bfetch\s*\(|cloudcode-pa|googleapis\.com|oauth/i.test(webServerCode), false);
  assert.ok(webServerCode.includes("'127.0.0.1'"));
});

test('零改盘本地网页看板 API (/api/data & /) 响应正常', async () => {
  clearCache();
  const { createDashboardServer } = require('./web-dashboard');
  const http = require('http');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lite-web-'));
  let server;
  try {
    const cid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const logDir = path.join(tmpHome, '.gemini', 'antigravity', 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      JSON.stringify({
        created_at: new Date().toISOString(),
        step_index: 1,
        responseId: 'web-resp-1',
        model: 'Gemini 4 Hydrogen',
        input_tokens: 5000,
        cache_read_tokens: 20000,
        output_tokens: 1500
      }) + '\n',
      'utf8'
    );

    server = createDashboardServer({ homeDir: tmpHome });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const get = (reqPath) => new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: reqPath, agent: false }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });

    const htmlRes = await get('/');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.body.includes('Antigravity Lite Meter'));

    const apiRes = await get('/api/data');
    assert.equal(apiRes.status, 200);
    const data = JSON.parse(apiRes.body);
    assert.equal(data.ok, true);
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].contextTokens, 25000);
    assert.equal(data.periods.today.totalTokens, 26500);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

