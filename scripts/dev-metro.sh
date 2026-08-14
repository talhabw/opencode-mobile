#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RUNTIME_KEY="$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-12)"
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/opencode-mobile-dev-$UID-$RUNTIME_KEY"
readonly PID_FILE="$RUNTIME_DIR/metro.pid"
readonly LOG_FILE="$RUNTIME_DIR/metro.log"

usage() {
  printf 'Usage: dev-metro.sh {start|stop|status}\n'
}

ready() {
  [[ "$(curl -fsS http://127.0.0.1:8081/status 2>/dev/null || true)" == "packager-status:running" ]]
}

pid_alive() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start() {
  mkdir -p "$RUNTIME_DIR"
  if ready; then
    if pid_alive; then
      printf 'Metro already ready at http://127.0.0.1:8081\n'
      return
    fi
    printf 'error: port 8081 is served by an unmanaged Metro process; refusing to attach to it\n' >&2
    exit 1
  fi
  if ! pid_alive; then
    rm -f "$PID_FILE"
    (cd "$ROOT_DIR" && bun run start -- --localhost) >"$LOG_FILE" 2>&1 &
    printf '%s\n' "$!" >"$PID_FILE"
  fi
  for _ in {1..600}; do
    if ready; then
      printf 'Metro ready at http://127.0.0.1:8081\n'
      return
    fi
    if ! pid_alive; then
      tail -n 40 "$LOG_FILE" >&2 || true
      printf 'error: Metro exited before becoming ready\n' >&2
      exit 1
    fi
    sleep 0.1
  done
  tail -n 40 "$LOG_FILE" >&2 || true
  printf 'error: Metro did not become ready; see %s\n' "$LOG_FILE" >&2
  exit 1
}

stop() {
  if pid_alive; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    if ready; then
      printf 'error: Metro still owns port 8081 after stopping pid %s\n' "$pid" >&2
      exit 1
    fi
    printf 'Metro stopped\n'
  else
    printf 'Metro not running\n'
  fi
  rm -f "$PID_FILE"
}

status() {
  if ready; then
    printf 'Metro ready at http://127.0.0.1:8081\n'
  elif pid_alive; then
    printf 'Metro starting (pid %s, log %s)\n' "$(cat "$PID_FILE")" "$LOG_FILE"
  else
    printf 'Metro not running\n'
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
