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
#   JUSTUS_WALK=1 bash scripts/maestro-e2e.sh [serial]   # release build, run the walk instead of the flows
#
# NOTE: this is NOT part of the fast `vp check` gate — it needs the Android SDK,
# an arm64 AVD image, and a debug APK build.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_AVD="Medium_Phone_API_36.1"
MAESTRO_DIR="$REPO_ROOT/.maestro"
FLOWS_DIR="$MAESTRO_DIR/flows"
OUT_DIR="$MAESTRO_DIR/out"
# JUSTUS_VARIANT=release runs the R8-minified release build (debug-signed, see app/build.gradle).
VARIANT="${JUSTUS_VARIANT:-debug}"
# JUSTUS_WALK=1 runs the release walk (playwright.walk.config.ts) instead of the flow suite. The walk
# is always the release build.
WALK="${JUSTUS_WALK:-}"
[[ "$WALK" == 1 ]] && VARIANT=release
if [[ "$VARIANT" == "release" ]]; then
  GRADLE_ARGS=(:app:assembleRelease -Pjustus.deviceCheck)
  APK="apps/android/app/build/outputs/apk/release/app-release.apk"
else
  GRADLE_ARGS=(:app:assembleDebug)
  APK="apps/android/app/build/outputs/apk/debug/app-debug.apk"
fi
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
echo "▶ Building $VARIANT APK..."
if ! ( cd "$REPO_ROOT/apps/android" && ./gradlew "${GRADLE_ARGS[@]}" ); then
  echo "ERROR: Gradle build of the $VARIANT APK failed (apps/android ./gradlew ${GRADLE_ARGS[*]})." >&2
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

ATTACHED=()
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
  for d in ${ATTACHED[@]+"${ATTACHED[@]}"}; do
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
# Uninstall first: every flow clears state anyway, and `install -r` needs room
# for two copies of the ~120 MB APK, which small AVD data partitions lack.
"$ADB" -s "$SERIAL" uninstall no.cankode.justus >/dev/null 2>&1 || true
if ! "$ADB" -s "$SERIAL" install "$REPO_ROOT/$APK"; then
  echo "ERROR: APK install failed on $SERIAL." >&2
  exit 1
fi
echo "✓ APK installed."
# Keep the screen awake so it never sleeps into a keyguard.
"$ADB" -s "$SERIAL" shell svc power stayon true || true

# The App lock flow needs a phone screen lock. Restore the device on exit so a local emulator
# is not left with a PIN. The walk sets none: a device without a lock shows no lock card.
if [[ "$WALK" != 1 ]]; then
  "$ADB" -s "$SERIAL" shell locksettings set-pin 1111 || true
  trap '"$ADB" -s "$SERIAL" shell locksettings clear --old 1111 >/dev/null 2>&1 || true' EXIT
fi

# ----------------------------------------------------------------------------
# 5. Run the Maestro flow suite
#    `--device` must come BEFORE `test` (Maestro CLI convention).
# ----------------------------------------------------------------------------
APP=no.cankode.justus
# The debug APK is debuggable, so run-as works. The release (R8) device build is
# not: read its storage as root (the google_apis image allows adb root).
if [[ "$VARIANT" == "release" ]]; then
  "$ADB" -s "$SERIAL" root >/dev/null 2>&1 || true
  "$ADB" -s "$SERIAL" wait-for-device
  run_as() { "$ADB" -s "$SERIAL" shell "cd /data/data/$APP && sh -c '$1'"; }
else
  run_as() { "$ADB" -s "$SERIAL" shell "run-as $APP sh -c '$1'"; }
fi

# The walk opens Ada's invite link in the emulator's Chrome. Chrome's test switch file skips its first
# run, and set-debug-app makes Chrome read it (needs adb root, set above for the release build).
prepare_chrome() {
  "$ADB" -s "$SERIAL" shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line' || return 1
  "$ADB" -s "$SERIAL" shell chmod 755 /data/local/tmp/chrome-command-line || return 1
  "$ADB" -s "$SERIAL" shell am set-debug-app --persistent com.android.chrome || return 1
  "$ADB" -s "$SERIAL" shell am force-stop com.android.chrome
}

run_walk() {
  ( cd "$REPO_ROOT" && JUSTUS_WALK_SERIAL="$SERIAL" JUSTUS_WALK_OUT="$OUT_DIR/walk" \
      pnpm exec playwright test --config playwright.walk.config.ts )
}

# The share-in flow shares two photos from the Files app: put them in Downloads, make the media
# store list them, and tell the flow which package is Files.
DOCUMENTS_UI="$("$ADB" -s "$SERIAL" shell pm list packages documentsui | tr -d '\r' | sed -n 's/^package://p' | grep -v '^com.android.providers' | head -n 1)"
: "${DOCUMENTS_UI:=com.google.android.documentsui}"
prepare_share_in() {
  "$ADB" -s "$SERIAL" push "$REPO_ROOT/e2e/fixtures/share-in/share-a.jpg" /sdcard/Download/justus-share-a.jpg >/dev/null || return 1
  "$ADB" -s "$SERIAL" push "$REPO_ROOT/e2e/fixtures/share-in/share-b.png" /sdcard/Download/justus-share-b.png >/dev/null || return 1
  "$ADB" -s "$SERIAL" shell content call --uri content://media/external/file --method scan_volume --arg external_primary >/dev/null || return 1
}

run_maestro() { maestro --device "$SERIAL" test -e "DOCUMENTS_UI=$DOCUMENTS_UI" --test-output-dir "$OUT_DIR" "$FLOWS_DIR"; }

# adb can drop a freshly booted emulator for a moment: Maestro then fails in seconds with
# "device offline" / DeviceServerDiedException on its first command (justus#654, first attempt of
# run 42799188001: launchApp failed after 1.3s, adbd logged "connection terminated"). The app was
# never reached. Only that failure is run again, once; any other failure fails the suite.
adb_dropped() {
  local log
  log="$(find "$OUT_DIR" -name maestro.log -newer "$1" 2>/dev/null | head -n 1)"
  [[ -n "$log" ]] && grep -q -E 'device offline|DeviceServerDiedException' "$log"
}

# Poll for the emulator with a deadline (a bare `adb wait-for-device` would hang until the job
# timeout and skip the diagnostics upload).
wait_for_adb() {
  local deadline=$((SECONDS + ${ADB_RETURN_TIMEOUT:-60}))
  while [[ "$("$ADB" -s "$SERIAL" get-state 2>/dev/null)" != "device" ]]; do
    if ((SECONDS >= deadline)); then
      echo "✗ the emulator did not come back after the adb drop."
      return 1
    fi
    sleep 2
  done
}

run_maestro_suite() {
  local started rc
  started="$(mktemp)"
  run_maestro && { rm -f "$started"; return 0; }
  adb_dropped "$started"; rc=$?
  rm -f "$started"
  ((rc == 0)) || return 1
  echo "⚠ adb dropped the emulator during the run — waiting for it, then running once more."
  wait_for_adb || return 1
  run_maestro
}

mkdir -p "$OUT_DIR"
if [[ "$WALK" != 1 ]]; then
  prepare_share_in || { echo "✗ could not put the share-in photos on the device"; exit 1; }
fi
if [[ "$WALK" == 1 ]]; then
  echo
  echo "▶ Preparing Chrome, then running the release walk ..."
  mkdir -p "$OUT_DIR/walk"
  if prepare_chrome && run_walk; then
    echo "✓ Release walk passed on $SERIAL."
    exit 0
  fi
  echo
  echo "✗ Release walk FAILED: see $OUT_DIR/walk/walk-summary.md — capturing diagnostics..."
else
  echo
  echo "▶ Running Maestro flows from $FLOWS_DIR ..."
fi
if [[ "$WALK" == 1 ]] || ! run_maestro_suite; then
  if [[ "$WALK" != 1 ]]; then
    echo
    echo "✗ Maestro suite FAILED — capturing diagnostics..."
  fi
  mkdir -p "$OUT_DIR"

  logcat_file="$OUT_DIR/logcat-JUSTUS_ANDROID.txt"
  "$ADB" -s "$SERIAL" logcat -d -s JUSTUS_ANDROID chromium ActivityTaskManager >"$logcat_file" 2>/dev/null || true

  # Worklet logs from the app's private storage (debuggable APK → run-as works).
  worklet_file="$OUT_DIR/worklet-logs.txt"
  {
    run_as 'cat cache/bare-cache/*.jsonl 2>/dev/null || true'
    run_as 'ls -la files/bare/ 2>/dev/null || true'
  }>"$worklet_file" 2>/dev/null || true

  echo
  echo "Maestro diagnostics written to:"
  echo "  $logcat_file  (JUSTUS_ANDROID logcat)"
  echo "  $worklet_file (worklet logs, if any)"
  echo "Screenshots/artifacts (if configured) live under: $OUT_DIR"
  echo
  exit 1
fi

# ----------------------------------------------------------------------------
# 5a. The share-in flow shared two photos: both must wait in the shared-photos inbox
# ----------------------------------------------------------------------------
echo
echo "▶ Share-in check: two photos wait in the inbox..."
share_started=$SECONDS
batch_files=""
for _ in $(seq 1 15); do
  batch_files="$(run_as 'ls cache/bare-cache/shared-in/*/ 2>/dev/null || true' | tr -d '\r')"
  if grep -q '^batch.json$' <<<"$batch_files" && grep -q '\.jpeg$' <<<"$batch_files" && grep -q '\.png$' <<<"$batch_files"; then
    echo "share-in: ok $(( (SECONDS - share_started) * 1000 )) ms"
    break
  fi
  batch_files=""
  sleep 2
done
if [[ -z "$batch_files" ]]; then
  echo "✗ Share-in check FAILED: no batch with a jpeg, a png and batch.json in cache/bare-cache/shared-in"
  mkdir -p "$OUT_DIR"
  "$ADB" -s "$SERIAL" logcat -d -s JUSTUS_ANDROID chromium >"$OUT_DIR/logcat-JUSTUS_ANDROID.txt" 2>/dev/null || true
  run_as 'ls -laR cache/bare-cache/shared-in 2>&1 || true' >"$OUT_DIR/worklet-logs.txt" 2>/dev/null || true
  exit 1
fi

# ----------------------------------------------------------------------------
# 5b. Albums survive "Clear cache", and an old cache-folder install is moved
# ----------------------------------------------------------------------------
# The web layer's intro-seen flag is keyed by the loopback origin, whose port changes every launch,
# so the UI cannot tell "albums survived" apart. Ask the worklet: after a relaunch it logs
# "rediscover.attempt" for every album drive it reopened from the store.
albums_reopened() {
  "$ADB" -s "$SERIAL" shell am force-stop "$APP"
  run_as 'rm -f cache/bare-cache/*.jsonl'
  "$ADB" -s "$SERIAL" shell monkey -p "$APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  for _ in $(seq 1 45); do
    if run_as 'cat cache/bare-cache/*.jsonl 2>/dev/null || true' | grep -q 'rediscover.attempt'; then return 0; fi
    sleep 2
  done
  return 1
}
survive_fail() {
  echo "✗ Survive check FAILED: $1"
  mkdir -p "$OUT_DIR"
  "$ADB" -s "$SERIAL" logcat -d -s JUSTUS_ANDROID chromium >"$OUT_DIR/logcat-JUSTUS_ANDROID.txt" 2>/dev/null || true
  {
    run_as 'cat cache/bare-cache/*.jsonl 2>/dev/null || true'
    run_as 'ls -la files/bare/ cache/ 2>/dev/null || true'
  } >"$OUT_DIR/worklet-logs.txt" 2>/dev/null || true
  exit 1
}

echo
echo "▶ Survive check: clear cache, reopen..."
"$ADB" -s "$SERIAL" shell am force-stop "$APP"
run_as 'rm -rf cache/*' || survive_fail "could not clear cache"
run_as 'test -d files/bare/corestore' || survive_fail "store is not in app storage (files/bare)"
albums_reopened || survive_fail "albums gone after clearing cache"

echo "▶ Survive check: old install (store in cache folder) is moved..."
"$ADB" -s "$SERIAL" shell am force-stop "$APP"
run_as 'rm -rf cache/bare && mv files/bare cache/bare' || survive_fail "could not recreate the old layout"
albums_reopened || survive_fail "albums gone after upgrade from cache folder"
run_as 'test -d files/bare/corestore && ! test -e cache/bare' || survive_fail "store was not moved to files/bare"
echo "✓ Albums survive cache clearing and the upgrade move."

# ----------------------------------------------------------------------------
# 6. Success
# ----------------------------------------------------------------------------
echo
echo "✓ All Maestro flows passed on $SERIAL."
echo "Artifacts (if any) live under: $OUT_DIR"
exit 0
