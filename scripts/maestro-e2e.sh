#!/usr/bin/env bash
#
# maestro-e2e.sh — native/device UI test runner for the Justus Android host.
#
# Builds the debug APK, (cold-)boots an arm64 emulator if needed, installs the
# APK, and runs the Maestro flow suite in `.maestro/flows/`. On failure it
# captures JUSTUS_ANDROID logcat + worklet logs into `.maestro/out/`.
#
# Usage:
#   bash scripts/maestro-e2e.sh                # default AVD Medium_Phone_API_36.1
#   bash scripts/maestro-e2e.sh <serial>       # target a specific emulator-XXXX
#
# NOTE: this is NOT part of the fast `vp check` gate — it needs the Android SDK,
# an arm64 AVD image, and a debug APK build.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_AVD="Medium_Phone_API_36.1"
MAESTRO_DIR="$REPO_ROOT/.maestro"
FLOWS_DIR="$MAESTRO_DIR/flows"
OUT_DIR="$MAESTRO_DIR/out"
APK="apps/android/app/build/outputs/apk/debug/app-debug.apk"
BOOT_TIMEOUT=300          # seconds to wait for sys.boot_completed
POLL_INTERVAL=2           # seconds between boot polls
EMULATOR_LOG="/tmp/justus-emulator.log"

echo "══════════════════════════════════════════════════════════════"
echo "  Justus — Maestro native/device UI tests"
echo "══════════════════════════════════════════════════════════════"
echo "Repo root : $REPO_ROOT"
echo "AVD       : ${1:-$DEFAULT_AVD}"

# ----------------------------------------------------------------------------
# 1. Android SDK / ANDROID_HOME
#    The Gradle preBuild steps and `adb`/`emulator` all need the SDK, so make
#    sure ANDROID_HOME is exported and stays set for the rest of the script.
# ----------------------------------------------------------------------------
if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
    echo "ANDROID_HOME unset — detected and exported: $ANDROID_HOME"
  else
    echo "ERROR: ANDROID_HOME is unset and no default SDK found at ~/Library/Android/sdk." >&2
    echo "       Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your Android SDK location." >&2
    exit 1
  fi
else
  echo "Using ANDROID_HOME=$ANDROID_HOME"
fi
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR_BIN="$ANDROID_HOME/emulator/emulator"

for bin in "$ADB" "$EMULATOR_BIN"; do
  if [[ ! -x "$bin" ]]; then
    echo "ERROR: missing Android tool: $bin (install/repair your SDK)." >&2
    exit 1
  fi
done

# ----------------------------------------------------------------------------
# 2. Build the debug APK
#    Gradle's preBuild steps run the monorepo builds (pnpm/vp/bare-*). Those
#    need node/pnpm on PATH — apps/android/build.gradle already handles the PATH
#    itself, so we only need to invoke the wrapper from apps/android.
# ----------------------------------------------------------------------------
echo
echo "▶ Building debug APK..."
if ! ( cd "$REPO_ROOT/apps/android" && ./gradlew :app:assembleDebug ); then
  echo "ERROR: Gradle build of the debug APK failed (/apps/android :app:assembleDebug)." >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/$APK" ]]; then
  echo "ERROR: expected APK not found after build: $APK" >&2
  exit 1
fi
echo "✓ APK ready: $APK"

# ----------------------------------------------------------------------------
# 3. Resolve the target device serial
#    - `$1` (explicit serial) is authoritative; must appear in `adb devices`.
#    - Otherwise use the default AVD. Prefer a matching already-booted
#      emulator; cold-boot one if none is running. With >1 device attached and
#      no explicit serial we bail loudly (adb/maestro are ambiguous).
# ----------------------------------------------------------------------------
echo
echo "▶ Resolving target device..."

"$ADB" start-server >/dev/null 2>&1 || true

declare -a ATTACHED
while IFS=$'\t' read -r serial state; do
  [[ -z "$serial" ]] && continue
  [[ "$serial" == "List of devices attached" ]] && continue
  ATTACHED+=("$serial:$state")
done < <("$ADB" devices)

if (( ${#ATTACHED[@]} > 0 )); then
  echo "Attached devices:"
  for d in "${ATTACHED[@]}"; do echo "  - $d"; done
fi

SERIAL=""
AVD="${1:-$DEFAULT_AVD}"

if [[ -n "${1:-}" ]]; then
  # Explicit serial was requested — it must actually be attached.
  SERIAL="$1"
  if ! "$ADB" devices | awk -v s="$SERIAL" '$1 == s && $2 == "device" {found=1} END {exit !found}'; then
    echo "ERROR: explicitly requested device serial '$SERIAL' is not attached (adb devices)." >&2
    exit 1
  fi
  echo "Using explicitly requested serial: $SERIAL"
else
  booted_serials=()
  for d in "${ATTACHED[@]}"; do
    serial="${d%%:*}"
    state="${d##*:}"
    if [[ "$state" == "device" && "$serial" == emulator-* ]]; then
      booted_serials+=("$serial")
    fi
  done

  if (( ${#booted_serials[@]} == 0 )); then
    echo "No emulator booted — will cold-boot AVD '$AVD'."
  elif (( ${#booted_serials[@]} == 1 )); then
    SERIAL="${booted_serials[0]}"
    echo "Using already-booted emulator: $SERIAL"
  else
    echo "ERROR: multiple emulated devices are attached (${booted_serials[*]}) and no explicit" >&2
    echo "       serial was given. Re-run with a serial, e.g.  bash scripts/maestro-e2e.sh ${booted_serials[0]}" >&2
    exit 1
  fi
fi

# Cold-boot if we still need a device.
if [[ -z "$SERIAL" ]]; then
  echo "▶ Cold-booting AVD '$AVD' (logs → $EMULATOR_LOG)..."
  nohup "$EMULATOR_BIN" -avd "$AVD" -no-boot-anim -no-snapshot-save >"$EMULATOR_LOG" 2>&1 &
  EMULATOR_PID=$!

  # The serial is unpredictable until the emulator registers with the adb
  # server, so wait for the first emulator-XXXX to appear, then for it to boot.
  deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
  SERIAL=""
  while (( $(date +%s) < deadline )); do
    [[ -z "$SERIAL" ]] && SERIAL="$("$ADB" devices | awk '$2=="device" && $1 ~ /^emulator-[0-9]+$/ {print $1; exit}')"
    if [[ -n "$SERIAL" ]]; then
      booted="$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
      if [[ "$booted" == "1" ]]; then
        break
      fi
    fi
    sleep "$POLL_INTERVAL"
  done

  if [[ -z "$SERIAL" ]] || [[ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]]; then
    echo "ERROR: emulator did not finish booting within ${BOOT_TIMEOUT}s." >&2
    echo "       Emulator log tail ($EMULATOR_LOG):" >&2
    tail -n 50 "$EMULATOR_LOG" >&2 || true
    kill "$EMULATOR_PID" 2>/dev/null || true
    exit 1
  fi
  echo "✓ Emulator booted as $SERIAL (pid $EMULATOR_PID)"
fi

# ----------------------------------------------------------------------------
# 4. Install the APK
# ----------------------------------------------------------------------------
echo
echo "▶ Installing APK on $SERIAL..."
if ! "$ADB" -s "$SERIAL" install -r "$REPO_ROOT/$APK"; then
  echo "ERROR: APK install failed on $SERIAL." >&2
  exit 1
fi
echo "✓ APK installed."

# ----------------------------------------------------------------------------
# 5. Run the Maestro flow suite
#    `--device` must come BEFORE `test` (Maestro CLI convention).
# ----------------------------------------------------------------------------
echo
echo "▶ Running Maestro flows from $FLOWS_DIR ..."
mkdir -p "$OUT_DIR"
if ! maestro --device "$SERIAL" test "$FLOWS_DIR"; then
  echo
  echo "✗ Maestro suite FAILED — capturing diagnostics..."
  mkdir -p "$OUT_DIR"

  logcat_file="$OUT_DIR/logcat-JUSTUS_ANDROID.txt"
  "$ADB" -s "$SERIAL" logcat -d -s JUSTUS_ANDROID >"$logcat_file" 2>/dev/null || true

  # Worklet logs from the app's private storage (debuggable APK → run-as works).
  worklet_file="$OUT_DIR/worklet-logs.txt"
  {
    "$ADB" -s "$SERIAL" shell "run-as io.justus.app sh -c 'cat cache/bare/*.log 2>/dev/null || true'" 2>/dev/null \
      && "$ADB" -s "$SERIAL" shell "run-as io.justus.app sh -c 'ls -la cache/bare/ 2>/dev/null || true'" 2>/dev/null
  } >"$worklet_file" 2>/dev/null || true

  echo
  echo "Maestro diagnostics written to:"
  echo "  $logcat_file  (JUSTUS_ANDROID logcat)"
  echo "  $worklet_file (worklet logs, if any)"
  echo "Screenshots/artifacts (if configured) live under: $OUT_DIR"
  echo
  exit 1
fi

# ----------------------------------------------------------------------------
# 6. Success
# ----------------------------------------------------------------------------
echo
echo "✓ All Maestro flows passed on $SERIAL."
echo "Artifacts (if any) live under: $OUT_DIR"
exit 0
