#!/usr/bin/env bash
set -euo pipefail

# 管理 AntigravityMeter.app 的 macOS 登录自启 (LaunchAgent)
LABEL="local.antigravity.lite-meter"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

resolve_app_bin() {
  if [[ -x "/Applications/AntigravityMeter.app/Contents/MacOS/AntigravityMeter" ]]; then
    echo "/Applications/AntigravityMeter.app/Contents/MacOS/AntigravityMeter"
  elif [[ -x "$SCRIPT_DIR/build/AntigravityMeter.app/Contents/MacOS/AntigravityMeter" ]]; then
    echo "$SCRIPT_DIR/build/AntigravityMeter.app/Contents/MacOS/AntigravityMeter"
  else
    echo ""
  fi
}

CMD="${1:-status}"
case "$CMD" in
  on|enable)
    BIN="$(resolve_app_bin)"
    if [[ -z "$BIN" ]]; then
      echo "❌ 未找到已编译的 AntigravityMeter.app，请先运行: ./macos/build-menubar.sh --install"
      exit 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    echo "✅ 已开启开机自启并启动状态栏应用 ($BIN)"
    ;;
  off|disable)
    if [[ -f "$PLIST" ]]; then
      launchctl unload "$PLIST" >/dev/null 2>&1 || true
      rm -f "$PLIST"
      echo "✅ 已关闭开机自启"
    else
      echo "ℹ️ 当前未配置开机自启"
    fi
    ;;
  status)
    if [[ -f "$PLIST" ]]; then
      echo "✅ 已开启开机自启: $PLIST"
    else
      echo "ℹ️ 未开启开机自启"
    fi
    ;;
  *)
    echo "用法: ./macos/autostart.sh <on | off | status>"
    exit 1
    ;;
esac
