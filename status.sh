#!/bin/bash
# weixin-claude-bridge 状态检查脚本

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.bridge.pid"

echo "=== Bridge Status ==="

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Status: Running"
    echo "PID: $PID"
    ps -p "$PID" -o pid,ppid,cmd 2>/dev/null
  else
    echo "Status: Stopped (stale PID file)"
    rm -f "$PID_FILE"
  fi
else
  echo "Status: Stopped (no PID file)"
fi

echo ""
echo "=== Node processes ==="
pgrep -af "node dist/index.js" 2>/dev/null || echo "No bridge processes found"
