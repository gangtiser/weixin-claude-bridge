#!/bin/bash
# weixin-claude-bridge 重启脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.bridge.pid"

echo "=== Stopping existing bridge processes ==="
# Kill by PID file if exists
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" && echo "Stopped process $OLD_PID"
  fi
  rm -f "$PID_FILE"
fi

# Kill any remaining bridge processes
pkill -f "node dist/index.js" 2>/dev/null || true
sleep 1

echo "=== Building ==="
cd "$SCRIPT_DIR"
npm run build

echo "=== Starting bridge ==="
# 使用 nohup 完全脱离终端，避免按 Enter 或关闭终端时服务终止
LOG_FILE="$SCRIPT_DIR/logs/bridge-$(date +%Y%m%d).log"
nohup npm start >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "Bridge started with PID $NEW_PID"
echo "Log file: $LOG_FILE"
echo ""
echo "Note: 服务已在后台启动，可以安全关闭此终端"
echo "查看日志: tail -f $LOG_FILE"
