#!/usr/bin/env bash
# Take the raw store captures (StoreCaptures.kt) on the emulator and pull them to apps/android/store-captures.
# Usage: bash scripts/store-captures.sh <adb serial>   (run from apps/android)
set -euo pipefail
serial="$1"
adb="adb -s $serial"
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
$adb install -r -g app/build/outputs/apk/debug/app-debug.apk
$adb install -r -g app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
$adb shell am instrument -w -e class io.justus.app.StoreCaptures \
  no.cankode.justus.test/androidx.test.runner.AndroidJUnitRunner | tee /tmp/store-captures.log
grep -q "^OK" /tmp/store-captures.log
rm -rf store-captures
$adb pull /sdcard/Android/data/no.cankode.justus/files/store-captures store-captures
