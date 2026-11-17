#!/usr/bin/env bash
# With App lock on the app switcher must show no photo (SwitcherCover.kt); pull the shots and check them.
# Usage: bash scripts/switcher-cover.sh <adb serial>   (run from apps/android)
set -euo pipefail
serial="$1"
adb="adb -s $serial"
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest
$adb install -r -g app/build/outputs/apk/debug/app-debug.apk
$adb install -r -g app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
$adb shell am instrument -w -e class io.justus.app.SwitcherCover \
  no.cankode.justus.test/androidx.test.runner.AndroidJUnitRunner | tee /tmp/switcher-cover.log
grep -q "^OK" /tmp/switcher-cover.log || { $adb logcat -d -s SwitcherCover TestRunner AndroidRuntime; exit 1; }
$adb logcat -d -s JUSTUS_ANDROID | tail -30
rm -rf switcher-cover
$adb pull /sdcard/Android/data/no.cankode.justus/files/switcher-cover switcher-cover
node ../../scripts/photo-marker.mjs check switcher-cover/switcher-lock-on-from-home.png hidden || true
node ../../scripts/photo-marker.mjs check switcher-cover/switcher-lock-on.png hidden
node ../../scripts/photo-marker.mjs check switcher-cover/switcher-lock-off.png shows
