#!/usr/bin/env bash
set -euo pipefail

# 在本机 macOS 上将 AntigravityMeterMenuBar.swift 编译为原生菜单栏应用 AntigravityMeter.app
# 零外部依赖，仅需 macOS 自带 Command Line Tools (swiftc)。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="AntigravityMeter"
BUILD_DIR="$SCRIPT_DIR/build"
APP_BUNDLE="$BUILD_DIR/${APP_NAME}.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ 本构建脚本仅可在 macOS 上运行。"
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "❌ 未检测到 swiftc。请先运行: xcode-select --install"
  exit 1
fi

echo "🔨 正在编译原生 macOS 状态栏应用 (${APP_NAME}.app)..."
rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RES_DIR"

swiftc -swift-version 5 -O \
  -framework Cocoa \
  -framework WebKit \
  "$SCRIPT_DIR/AntigravityMeterMenuBar.swift" \
  -o "$MACOS_DIR/$APP_NAME"

cp "$ROOT_DIR/dashboard.html" "$RES_DIR/dashboard.html"

cat > "$CONTENTS/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>AntigravityMeter</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity Lite Meter</string>
  <key>CFBundleIdentifier</key>
  <string>local.antigravity.lite-meter</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleExecutable</key>
  <string>AntigravityMeter</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

echo "✅ 编译完成: $APP_BUNDLE"

DO_INSTALL=false
DO_RUN=false
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=true ;;
    --run) DO_RUN=true ;;
  esac
done

TARGET_APP="$APP_BUNDLE"
if $DO_INSTALL; then
  echo "📦 正在安装到 /Applications/${APP_NAME}.app ..."
  rm -rf "/Applications/${APP_NAME}.app"
  cp -R "$APP_BUNDLE" "/Applications/${APP_NAME}.app"
  TARGET_APP="/Applications/${APP_NAME}.app"
  echo "✅ 已安装到: $TARGET_APP"
fi

if $DO_RUN; then
  echo "🚀 正在启动状态栏应用..."
  open "$TARGET_APP"
else
  echo "👉 启动方式: open \"$TARGET_APP\""
  echo "👉 安装到应用程序并启动: ./macos/build-menubar.sh --install --run"
  echo "👉 开启开机自启: ./macos/autostart.sh on"
fi
