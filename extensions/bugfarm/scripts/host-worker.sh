#!/usr/bin/env bash
# Run the Bugfarm worker as a host process (it drives Docker and Harbor directly).
#
#   scripts/host-worker.sh start     start in the background; logs to $BUGFARM_LOG
#   scripts/host-worker.sh stop      SIGTERM: a clean stop
#   scripts/host-worker.sh kill      SIGKILL: a crash, for the resume demo
#   scripts/host-worker.sh restart   stop, then start
#   scripts/host-worker.sh status | logs
#
# Settings come from $BUGFARM_ENV_FILE (default ~/.config/bugfarm/worker.env), one KEY=value per
# line; see the README for the keys. Run `pnpm --filter @stablehand-ext/bugfarm build` first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BUGFARM_ENV_FILE:-$HOME/.config/bugfarm/worker.env}"
STATE_DIR="${BUGFARM_STATE_DIR:-$(dirname "$ENV_FILE")}"
PID_FILE="$STATE_DIR/worker.pid"
LOG="${BUGFARM_LOG:-$STATE_DIR/worker.log}"
export PATH="$HOME/.local/bin:$PATH"

pid() { [ -f "$PID_FILE" ] && cat "$PID_FILE" || true; }
alive() { local p; p="$(pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

start() {
  if alive; then echo "worker already running (pid $(pid))"; return 0; fi
  [ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }
  [ -f "$HERE/dist/server/main.js" ] || { echo "not built: run pnpm --filter @stablehand-ext/bugfarm build" >&2; exit 1; }
  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    cd "$HERE"
    nohup node dist/server/main.js >>"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
  )
  sleep 1
  if alive; then echo "worker started (pid $(pid)); logs: $LOG"; else echo "worker exited at start; see $LOG" >&2; tail -20 "$LOG" >&2; exit 1; fi
}

stop() {
  local signal="$1"
  if ! alive; then echo "worker not running"; rm -f "$PID_FILE"; return 0; fi
  local p; p="$(pid)"
  kill "-$signal" "$p"
  for _ in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
  rm -f "$PID_FILE"
  echo "worker $p stopped with SIG$signal"
}

case "${1:-}" in
  start) start ;;
  stop) stop TERM ;;
  kill) stop KILL ;;
  restart) stop TERM; start ;;
  status) if alive; then echo "running (pid $(pid))"; else echo "stopped"; fi ;;
  logs) tail -n "${2:-50}" -f "$LOG" ;;
  *) echo "usage: $0 start|stop|kill|restart|status|logs" >&2; exit 2 ;;
esac
