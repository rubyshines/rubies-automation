#!/usr/bin/env bash
# Restart the CS ops dashboard cleanly on one port, with no orphans left behind.
#
# `lsof -ti:PORT | xargs kill` only kills whatever currently holds the socket.
# A server that failed to bind, or one started from a worktree, keeps running
# invisibly — and several competing processes produce "failed to fetch" in the
# browser with nothing useful in any single log. Match on the command instead
# of the port, so every instance goes.
set -euo pipefail
PORT="${PORT:-3847}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/tmp/dash-${PORT}.log"

pkill -f "customer-service/dashboard/server.js" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  pgrep -f "customer-service/dashboard/server.js" >/dev/null 2>&1 || break
  sleep 1
done

cd "$ROOT"
PORT="$PORT" nohup node customer-service/dashboard/server.js > "$LOG" 2>&1 &
for _ in $(seq 1 20); do
  sleep 1
  if curl -sf -o /dev/null "http://localhost:${PORT}/health"; then
    n="$(pgrep -cf 'customer-service/dashboard/server.js' || echo 0)"
    echo "dashboard up on ${PORT} (${n} process) — $(curl -s "http://localhost:${PORT}/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"]["short"])')"
    [ "$n" -eq 1 ] || echo "WARNING: ${n} server processes running — expected 1"
    exit 0
  fi
done
echo "dashboard did NOT come up on ${PORT}; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
