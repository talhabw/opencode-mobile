#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RUNTIME_KEY="$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-12)"
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/opencode-mobile-dev-$UID-$RUNTIME_KEY"
PORT="${OPENCODE_MOBILE_FIXTURE_PORT:-4100}"
HOST="${OPENCODE_MOBILE_FIXTURE_HOST:-0.0.0.0}"
PID_FILE="$RUNTIME_DIR/fixture-$PORT.pid"
LOG_FILE="$RUNTIME_DIR/fixture-$PORT.log"
BASE_URL="http://127.0.0.1:$PORT"

usage() {
  printf 'Usage: dev-server.sh {start|stop|reset|status}\n'
}

ready() {
  curl -fsS --user opencode:devpassword "$BASE_URL/fixture/status" >/dev/null 2>&1
}

pid_alive() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o args= | grep -q 'opencode-v2-server.ts' || return 1
}

wait_ready() {
  local attempt
  for attempt in {1..100}; do
    ready && return 0
    if [[ -f "$PID_FILE" ]] && ! pid_alive; then
      tail -n 40 "$LOG_FILE" >&2 || true
      printf 'error: fixture server exited before becoming ready\n' >&2
      exit 1
    fi
    sleep 0.1
  done
  tail -n 40 "$LOG_FILE" >&2 || true
  printf 'error: fixture server did not become ready at %s\n' "$BASE_URL" >&2
  exit 1
}

start() {
  mkdir -p "$RUNTIME_DIR"
  if ready; then
    if pid_alive; then
      printf 'fixture server already ready at %s\n' "$BASE_URL"
      return
    fi
    printf 'error: port %s is served by an unmanaged process; refusing to attach to it\n' "$PORT" >&2
    exit 1
  fi
  if pid_alive; then
    printf 'fixture server is starting (pid %s)\n' "$(cat "$PID_FILE")"
    wait_ready
    return
  fi
  rm -f "$PID_FILE"
  (
    cd "$ROOT_DIR"
    OPENCODE_FIXTURE_HOST="$HOST" bun tests/fixtures/opencode-v2-server.ts --port "$PORT"
  ) >"$LOG_FILE" 2>&1 &
  printf '%s\n' "$!" >"$PID_FILE"
  wait_ready
  printf 'fixture server ready at %s (opencode/devpassword)\n' "$BASE_URL"
}

stop() {
  if pid_alive; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid"
    for _ in {1..50}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    printf 'fixture server stopped\n'
  else
    printf 'fixture server not running\n'
  fi
  rm -f "$PID_FILE"
}

reset() {
  start
  curl -fsS --user opencode:devpassword -X POST "$BASE_URL/fixture/reset" >/dev/null
  printf 'fixture state reset\n'
}

status() {
  if ready; then
    printf 'fixture server ready at %s\n' "$BASE_URL"
    curl -fsS --user opencode:devpassword "$BASE_URL/fixture/status"
    printf '\n'
  elif pid_alive; then
    printf 'fixture server starting (pid %s, log %s)\n' "$(cat "$PID_FILE")" "$LOG_FILE"
  else
    printf 'fixture server not running\n'
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
