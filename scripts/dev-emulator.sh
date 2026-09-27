#!/usr/bin/env bash
#
# dev-emulator.sh - deterministic lifecycle for the local Android emulator used
# during OpenCode Mobile development.
#
# Usage:
#   scripts/dev-emulator.sh start   # boot headless and wait for sys.boot_completed
#   scripts/dev-emulator.sh stop    # shut down only this emulator
#   scripts/dev-emulator.sh reset   # wipe data (-wipe-data) and boot fresh
#   scripts/dev-emulator.sh status  # report SDK, AVD, serial, and state
#
# Environment overrides:
#   OPENCODE_MOBILE_AVD              AVD name              (default: opencode-mobile-api36)
#   OPENCODE_MOBILE_EMULATOR_PORT    console port          (default: 5554)
#   OPENCODE_MOBILE_EMULATOR_SERIAL  adb serial            (default: emulator-<port>)
#   OPENCODE_MOBILE_BOOT_TIMEOUT     boot wait in seconds  (default: 300)
#   ANDROID_HOME / ANDROID_SDK_ROOT  SDK location          (fallback: ~/Android/Sdk)
#
# Runtime state (logs, pid) lives under the same checkout-specific directory
# as the fixture and Metro scripts:
# ${XDG_RUNTIME_DIR:-/tmp}/opencode-mobile-dev-$UID-<checkout hash>.
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEFAULT_AVD="opencode-mobile-api36"
readonly DEFAULT_PORT="5554"
readonly DEFAULT_TIMEOUT="300"
readonly RUNTIME_KEY="$(printf '%s' "$ROOT_DIR" | sha256sum | cut -c1-12)"
readonly RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/opencode-mobile-dev-$UID-$RUNTIME_KEY"

AVD="${OPENCODE_MOBILE_AVD:-$DEFAULT_AVD}"
PORT="${OPENCODE_MOBILE_EMULATOR_PORT:-$DEFAULT_PORT}"
SERIAL="${OPENCODE_MOBILE_EMULATOR_SERIAL:-emulator-$PORT}"
BOOT_TIMEOUT="${OPENCODE_MOBILE_BOOT_TIMEOUT:-$DEFAULT_TIMEOUT}"
AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
SDK=""
EMULATOR=""
ADB=""
PID_FILE="$RUNTIME_DIR/emulator-$PORT.pid"
LOG_FILE="$RUNTIME_DIR/emulator-$PORT.log"

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: dev-emulator.sh {start|stop|reset|status}

  start   Boot the emulator headless (no window, no audio, no boot animation,
          no snapshots, software GPU) and wait until sys.boot_completed=1.
  stop    Shut down only this emulator (serial emulator-5554 by default).
          Never touches physical devices or other emulators.
  reset   Stop, wipe the AVD data (-wipe-data), and boot fresh.
  status  Report SDK, AVD, serial, and running state.

Environment overrides:
  OPENCODE_MOBILE_AVD              AVD name              (default: opencode-mobile-api36)
  OPENCODE_MOBILE_EMULATOR_PORT    console port          (default: 5554)
  OPENCODE_MOBILE_EMULATOR_SERIAL  adb serial            (default: emulator-<port>)
  OPENCODE_MOBILE_BOOT_TIMEOUT     boot wait in seconds  (default: 300)
  ANDROID_HOME / ANDROID_SDK_ROOT  SDK location          (fallback: ~/Android/Sdk)

Runtime state: ${XDG_RUNTIME_DIR:-/tmp}/opencode-mobile-dev-$UID-<checkout hash>/
EOF
}

resolve_sdk() {
  if [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME" ]]; then
    SDK="$ANDROID_HOME"
  elif [[ -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT" ]]; then
    SDK="$ANDROID_SDK_ROOT"
  elif [[ -d "$HOME/Android/Sdk" ]]; then
    SDK="$HOME/Android/Sdk"
  else
    fail "Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT, or install the SDK at ~/Android/Sdk."
  fi

  EMULATOR="$SDK/emulator/emulator"
  ADB="$SDK/platform-tools/adb"

  if [[ ! -x "$EMULATOR" ]]; then
    fail "Emulator binary not found at $EMULATOR. Install the 'emulator' package (e.g. sdkmanager 'emulator' or Android Studio > SDK Manager > Emulator)."
  fi
  if [[ ! -x "$ADB" ]]; then
    fail "adb not found at $ADB. Install the 'platform-tools' package (e.g. sdkmanager 'platform-tools' or Android Studio > SDK Manager > Platform-Tools)."
  fi
}

check_kvm() {
  if [[ ! -e /dev/kvm ]]; then
    fail "KVM is not available (/dev/kvm missing). The emulator needs hardware acceleration: enable KVM (nested virtualization in a VM host) and make sure your user can access /dev/kvm."
  fi
  if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
    fail "/dev/kvm exists but is not accessible. Add your user to the 'kvm' group and log back in."
  fi
}

check_avd() {
  if [[ ! -d "$AVD_HOME/$AVD.avd" ]]; then
    cat >&2 <<EOF
error: AVD '$AVD' not found under $AVD_HOME. Create it with:

  sdkmanager 'system-images;android-36;google_apis;x86_64'
  avdmanager create avd -n '$AVD' -k 'system-images;android-36;google_apis;x86_64' -d pixel_6

or create it in Android Studio > Device Manager.
EOF
    exit 1
  fi

  local image_dir
  image_dir="$(awk -F= '$1 == "image.sysdir.1" { print $2 }' "$AVD_HOME/$AVD.avd/config.ini" 2>/dev/null || true)"
  image_dir="${image_dir%/}"
  if [[ -n "$image_dir" && ! -d "$SDK/$image_dir" ]]; then
    fail "System image for AVD '$AVD' is missing at $SDK/$image_dir. Install it with: sdkmanager 'system-images;android-36;google_apis;x86_64'"
  fi
}

device_online() {
  "$ADB" devices 2>/dev/null | awk -v s="$SERIAL" '$1 == s && $2 == "device" { found = 1 } END { exit found ? 0 : 1 }'
}

device_is_expected_avd() {
  [[ "$("$ADB" -s "$SERIAL" emu avd name 2>/dev/null | head -n 1 | tr -d '\r')" == "$AVD" ]]
}

pid_alive() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -q -- "-avd $AVD" || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -q -- "-port $PORT" || return 1
}

boot_completed() {
  "$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r'
}

launch_emulator() {
  local -a extra=("$@")
  mkdir -p "$RUNTIME_DIR"
  rm -f "$PID_FILE"
  info "launching emulator '$AVD' on port $PORT (serial $SERIAL, headless)"
  "$EMULATOR" \
    -avd "$AVD" \
    -port "$PORT" \
    -skin 1080x2400 \
    -no-window \
    -no-audio \
    -no-boot-anim \
    -no-metrics \
    -no-snapshot \
    -no-snapshot-save \
    -gpu swiftshader_indirect \
    -netdelay none \
    -netspeed full \
    "${extra[@]}" >"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  disown "$pid" 2>/dev/null || true
  info "emulator pid $pid, log at $LOG_FILE"
}

wait_for_boot() {
  local elapsed=0
  info "waiting for boot (timeout ${BOOT_TIMEOUT}s)..."
  while [[ "$(boot_completed)" != "1" ]]; do
    if [[ -f "$PID_FILE" ]] && ! pid_alive; then
      local pid
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      fail "tracked emulator process${pid:+ (pid $pid)} exited before boot completed. Check $LOG_FILE and run: scripts/dev-emulator.sh start"
    fi
    if (( elapsed >= BOOT_TIMEOUT )); then
      info "boot timed out after ${BOOT_TIMEOUT}s; last log lines:"
      tail -n 40 "$LOG_FILE" 2>/dev/null || true
      fail "emulator did not finish booting. Check the log above, then run: scripts/dev-emulator.sh stop && scripts/dev-emulator.sh start"
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  info "boot completed in about ${elapsed}s"
}

start() {
  resolve_sdk
  check_kvm
  check_avd
  if device_online; then
    device_is_expected_avd || fail "$SERIAL is occupied by a different emulator; refusing to reuse it. Stop that emulator or set OPENCODE_MOBILE_EMULATOR_PORT."
    info "emulator '$AVD' already running on $SERIAL"
    exit 0
  fi
  if pid_alive; then
    info "emulator process already tracked for '$AVD' on port $PORT; waiting instead of launching another"
    wait_for_boot
    info "emulator ready: adb -s $SERIAL shell"
    exit 0
  fi
  launch_emulator
  wait_for_boot
  info "emulator ready: adb -s $SERIAL shell"
}

stop() {
  resolve_sdk
  local stopped=0 pid
  if device_online; then
    device_is_expected_avd || fail "$SERIAL is occupied by a different emulator; refusing to stop it."
    info "stopping emulator on $SERIAL"
    "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
    stopped=1
  fi
  if pid_alive; then
    pid="$(cat "$PID_FILE")"
    info "stopping tracked emulator process (pid $pid)"
    kill "$pid" >/dev/null 2>&1 || true
    stopped=1
  fi
  if [[ $stopped -eq 1 ]]; then
    local i
    for i in {1..50}; do
      if ! device_online && ! pid_alive; then
        break
      fi
      sleep 0.2
    done
  else
    info "emulator not running on $SERIAL"
  fi
  rm -f "$PID_FILE"
}

reset() {
  resolve_sdk
  check_kvm
  check_avd
  stop
  launch_emulator -wipe-data
  wait_for_boot
  info "emulator ready (data wiped): adb -s $SERIAL shell"
}

status() {
  resolve_sdk
  info "SDK:      $SDK"
  info "AVD:      $AVD"
  info "Serial:   $SERIAL (port $PORT)"
  info "Runtime:  $RUNTIME_DIR"
  if device_online; then
    local boot model
    if ! device_is_expected_avd; then
      info "State:    occupied by a different emulator"
      return 1
    fi
    boot="$(boot_completed)"
    model="$("$ADB" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
    info "State:    running${model:+ ($model)}"
    info "Boot:     ${boot:-not completed}"
  elif pid_alive; then
    info "State:    starting (pid $(cat "$PID_FILE"))"
  else
    info "State:    not running"
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
