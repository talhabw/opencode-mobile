#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
readonly ADB="$SDK/platform-tools/adb"
readonly SERIAL="${OPENCODE_MOBILE_EMULATOR_SERIAL:-emulator-${OPENCODE_MOBILE_EMULATOR_PORT:-5554}}"
readonly APK="$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
readonly FIXTURE_PORT="${OPENCODE_MOBILE_FIXTURE_PORT:-4100}"
readonly FIXTURE_HOST="${OPENCODE_MOBILE_FIXTURE_HOST:-0.0.0.0}"

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"

usage() {
  cat <<'EOF'
Usage: dev-env.sh {start|reset|reinstall|stop|status}

  start      Start fixture, emulator, and Metro; build/install/launch the app.
  reset      Reset fixture and wipe emulator data, then build/install/launch.
  reinstall  Rebuild/install/launch without wiping app or fixture state.
  stop       Stop only this Metro, fixture server, and emulator.
  status     Show component status.

Set OPENCODE_MOBILE_SKIP_BUILD=1 to reuse the existing debug APK.
EOF
}

require_adb() {
  [[ -x "$ADB" ]] || { printf 'error: adb not found at %s\n' "$ADB" >&2; exit 1; }
}

node_path() {
  if command -v node >/dev/null 2>&1; then
    dirname "$(command -v node)"
    return
  fi
  local node
  node="$(find "$HOME/.local/share/fnm/node-versions" -path '*/installation/bin/node' -type f -perm -111 2>/dev/null | sort -V | tail -1)"
  [[ -n "$node" ]] || { printf 'error: Node is required by the React Native Gradle plugin\n' >&2; exit 1; }
  dirname "$node"
}

build_install_launch() {
  require_adb
  "$ADB" -s "$SERIAL" reverse tcp:8081 tcp:8081
  # The fixture binds 0.0.0.0 by default, which the emulator reaches through
  # 10.0.2.2. A loopback-only fixture host needs its own adb reverse.
  case "$FIXTURE_HOST" in
    127.0.0.1|localhost|::1) "$ADB" -s "$SERIAL" reverse "tcp:$FIXTURE_PORT" "tcp:$FIXTURE_PORT" ;;
  esac
  if [[ "${OPENCODE_MOBILE_SKIP_BUILD:-0}" != "1" || ! -f "$APK" ]]; then
    local node_bin
    node_bin="$(node_path)"
    (cd "$ROOT_DIR/android" && PATH="$node_bin:$PATH" NODE_ENV=development ./gradlew assembleDebug -PreactNativeArchitectures=x86_64)
  fi
  "$ADB" -s "$SERIAL" install -r "$APK"
  "$ADB" -s "$SERIAL" shell am force-stop cc.agentlabs.opencode
  "$ADB" -s "$SERIAL" shell monkey -p cc.agentlabs.opencode -c android.intent.category.LAUNCHER 1 >/dev/null
  local fixture_url="http://10.0.2.2:$FIXTURE_PORT"
  case "$FIXTURE_HOST" in
    127.0.0.1|localhost|::1) fixture_url="http://127.0.0.1:$FIXTURE_PORT" ;;
  esac
  printf '\nEnvironment ready.\n'
  printf 'App:      cc.agentlabs.opencode on %s\n' "$SERIAL"
  printf 'Fixture:  %s (opencode/devpassword)\n' "$fixture_url"
  printf 'Automate: agent-device open cc.agentlabs.opencode --platform android --device opencode-mobile-api36 --foreground\n'
}

start_all() {
  "$ROOT_DIR/scripts/dev-server.sh" start
  "$ROOT_DIR/scripts/dev-emulator.sh" start
  "$ROOT_DIR/scripts/dev-metro.sh" start
  build_install_launch
}

reset_all() {
  "$ROOT_DIR/scripts/dev-server.sh" reset
  "$ROOT_DIR/scripts/dev-emulator.sh" reset
  "$ROOT_DIR/scripts/dev-metro.sh" start
  build_install_launch
}

stop_all() {
  "$ROOT_DIR/scripts/dev-metro.sh" stop
  "$ROOT_DIR/scripts/dev-server.sh" stop
  "$ROOT_DIR/scripts/dev-emulator.sh" stop
}

status_all() {
  "$ROOT_DIR/scripts/dev-server.sh" status || true
  "$ROOT_DIR/scripts/dev-emulator.sh" status || true
  "$ROOT_DIR/scripts/dev-metro.sh" status || true
  if [[ -x "$ADB" ]] && "$ADB" -s "$SERIAL" shell pm path cc.agentlabs.opencode >/dev/null 2>&1; then
    printf 'App installed on %s\n' "$SERIAL"
  else
    printf 'App not installed on %s\n' "$SERIAL"
  fi
}

case "${1:-}" in
  start) start_all ;;
  reset) reset_all ;;
  reinstall) "$ROOT_DIR/scripts/dev-server.sh" start; "$ROOT_DIR/scripts/dev-emulator.sh" start; "$ROOT_DIR/scripts/dev-metro.sh" start; build_install_launch ;;
  stop) stop_all ;;
  status) status_all ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
