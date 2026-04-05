#!/bin/bash
# weixin-claude-bridge 停止脚本

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.bridge.pid"

echo "=== Stopping bridge ==="

# Kill by PID file if exists
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" && echo "Stopped process $OLD_PID"
  else
    echo "Process $OLD_PID not running"
  fi
  rm -f "$PID_FILE"
else
  echo "PID file not found"
fi

# Kill any remaining bridge processes
pkill -f "node dist/index.js" 2>/dev/null && echo "Stopped remaining bridge processes" || echo "No bridge processes found"

echo "=== Bridge stopped ==="
