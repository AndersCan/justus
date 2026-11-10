#!/usr/bin/env bash
# Take the raw store captures (StoreCaptures.kt) on the emulator and pull them to apps/android/store-captures.
# Usage: bash scripts/store-captures.sh <adb serial>   (run from apps/android)
set -euo pipefail
serial="$1"
adb="adb -s $serial"
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
$adb install -r -g app/build/outputs/apk/debug/app-debug.apk
$adb install -r -g app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
# App lock is only usable on a phone with a screen lock: set a PIN for the run and clear it after.
$adb shell locksettings set-pin 1234
trap "$adb shell locksettings clear --old 1234 || true" EXIT
$adb shell am instrument -w -e class io.justus.app.StoreCaptures \
  no.cankode.justus.test/androidx.test.runner.AndroidJUnitRunner | tee /tmp/store-captures.log
grep -q "^OK" /tmp/store-captures.log || { $adb logcat -d -s StoreCaptures TestRunner AndroidRuntime; exit 1; }
rm -rf store-captures
$adb pull /sdcard/Android/data/no.cankode.justus/files/store-captures store-captures
