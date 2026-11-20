# Antigravity Lite Meter（极简纯本地只读版）

为 Antigravity 打造的一套**零外部依赖、零外网请求、零账号凭据接触**的上下文与 Token 统计工具，提供三种按需选择的运行形态：

1. **macOS 原生顶部状态栏应用（推荐，真正 0 改盘 / 0 封号风险）**：纯 Swift + 系统 `AppKit`/`WKWebView` 编译为原生 `AntigravityMeter.app`，常驻 macOS 顶部菜单栏，点开即看完整看板，支持开机自启。
2. **零改盘本地网页看板（跨平台，真正 0 改盘 / 0 封号风险）**：`node web-dashboard.js` 启动本机 `127.0.0.1` 页面，可在浏览器或 Antigravity 内置浏览器查看。
3. **Antigravity 2.x 桌面端顶栏内嵌胶囊（可选）**：极简只读注入 `app.asar`，完全剥离多账号/OAuth/解锁/改提示词/在线更新，可一键无损还原。

---

## 一、macOS 顶部状态栏模式（最推荐 · 零改盘零风险）

- **完全不修改 Antigravity 任何文件**（`app.asar` 与 `language_server` 0 字节改动）。
- **零网络、零 Node.js 运行时依赖**：仅使用 macOS 系统原生 `Cocoa` + `WebKit` + `Foundation`，只读扫描 `~/.gemini/antigravity/brain/.../transcript.jsonl`。
- **菜单栏常驻展示**：`⚡ 48.2K/256K (19%) · 今日 1.2M`（支持右键切换“精简状态栏显示”），左键点击弹出原生 `NSPopover` 交互看板（当前会话上下文进度、最近会话切换、今日/7天/30天/全部统计、52 周热力图、按模型用量与 API 参考费用）。

在 macOS 终端执行一次编译即可：

```bash
# 1. 编译原生状态栏应用、安装到 /Applications 并立即启动
./macos/build-menubar.sh --install --run

# 2. （可选）开启 macOS 开机登录自启
./macos/autostart.sh on

# 关闭开机自启
./macos/autostart.sh off
```

> 仅需 macOS 系统自带 Command Line Tools（如未安装 `swiftc`，运行 `xcode-select --install` 即可）。

---

## 二、零改盘本地网页看板（跨平台 · 零风险）

```bash
node web-dashboard.js
# 浏览器打开 http://127.0.0.1:18765（严格仅监听本机回环地址）
```

---

## 三、命令行快速查看 / 桌面端顶栏内嵌（可选）

```bash
# 运行安全红线审计与全部单测（无需 npm install）
npm test

# 免安装直接在终端查看本地 Token 统计
node cli.js status

# （可选）仅当你希望把胶囊直接嵌进 Antigravity 桌面端顶栏时执行：
# 先完全退出 Antigravity，再安装；随时可无损还原
node cli.js install
node cli.js restore
```

---

## 文件清单

- `macos/AntigravityMeterMenuBar.swift`：macOS 原生顶部状态栏应用源码（纯 Cocoa/WebKit，零网络、零凭据）
- `macos/build-menubar.sh`：一键本地编译打包 `AntigravityMeter.app`
- `macos/autostart.sh`：一键开关 macOS 登录自启（LaunchAgent）
- `dashboard.html`：macOS 状态栏弹窗与本地网页看板共用的零依赖界面
- `web-dashboard.js`：零改盘本机 `127.0.0.1` 网页看板服务
- `pricing.js` / `scanner.js`：模型归一化、公开 API 参考费率表与只读日志扫描引擎
- `asar-lite.js` / `lite-main.js` / `lite-renderer.js` / `cli.js`：可选的极简桌面端顶栏内嵌安装与还原工具
- `test.js`：全项目安全红线静态审计 + 扫描器 + 本地网页服务 + ASAR 安装还原自动化测试
