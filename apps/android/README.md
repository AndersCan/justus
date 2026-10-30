# Justus Android host

The Android shell for Justus: a WebView app that starts the Bare worklet backend
(`apps/backend`), serves the built web app from the worklet's loopback server,
and wires the native `vendor.media` pick/capture host plugins (so "Pick photo"
opens the system picker on device).

Consumes the published **`io.github.anderscan.ekrooh:bare-host`** AAR from Maven Central
(no credentials). Keep its version equal to `@ekrooh/bare` in the JS packages.

## Layout

- `settings.gradle` — resolves `bare-host` from Maven Central.
- `app/src/main/nativehelper/` — bundled `libnativehelper.so` shim. The published `bare-host` AAR's
  `libbare-kit.so` `DT_NEED`s `libnativehelper.so` (a private Android platform lib) but never ships nor
  calls into it, so `System.loadLibrary("bare-kit")` fails on install-run without this shim present in
  the app's jniLibs (**ekrooh#45**). Remove it only once a released AAR is verified without it.
- `app/build.gradle` — the app module; Gradle tasks run the monorepo builds:
  - `link` — `bare-link --preset android` links the p2p native addons into
    `src/main/addons`
  - `buildBareJs` — bundles `apps/backend` into `dist/main.core.gen.js`
  - `buildWebAssets` — builds `apps/web` and copies the output into the APK
    assets
  - `packApp` — `bare-pack --preset android` wraps the worklet bundle
- `app/src/main/...` — `MainActivity.kt` (worklet boot + handoff + media host
  plugins), manifest, resources. Mirrors the framework's `examples/android-app`.

## Prerequisites

Toolchain: JDK 17+, Android SDK platform 35 + build-tools, NDK 27.2.12479018,
Gradle 8.9 (wrapper), Node ≥ 22.18, pnpm 11. Native addons ship prebuilt in npm;
no C toolchain is needed.

- **Android SDK** — `local.properties` with `sdk.dir=...` (or `ANDROID_HOME`).
- **Node/pnpm/vp** on PATH (the Gradle exec tasks run the monorepo builds).

## Build

```bash
cd apps/android
./gradlew :app:assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`. On the emulator/
device, the gallery's "Pick photo" button opens the system picker; the worklet
stores the photo in the folder drive and serves it over the loopback server.

> **Device ABI caveat:** verified booting on the **arm64 emulator**. The physical
> Nexus 7 (`flo`) runs **LineageOS 18.1 (Android 11)** but on a **32-bit-only**
> userspace (`zygote32`) and cannot run `bare-host` — it SIGSEGVs in
> `bare_kit__on_thread_enter` even with the `libnativehelper` shim
> (ekrooh#46). Use an arm64 emulator/device for on-device testing.

For a signed Play Store bundle (`:app:bundleRelease`) and the fastlane release
flow, see [`docs/release-android.md`](../../docs/release-android.md).

## Maestro tests

Native/device UI tests for the host app, run with Maestro against an Android
emulator or device. From the repo root:

```bash
vp run test:native        # or: bash scripts/maestro-e2e.sh
```

The runner builds the debug APK, cold-boots the arm64 `Medium_Phone_API_36.1`
AVD if needed, installs the APK, and runs the `.maestro/flows/` suite
(`bash scripts/maestro-e2e.sh <serial>` targets a specific attached emulator).

**Prerequisites:** the
[Maestro CLI](../../docs/android-build-dependencies.md#maestro-cli-dev-only-for-the-native-ui-tests),
the Android SDK, and the arm64 AVD `Medium_Phone_API_36.1` (the only image that
runs `bare-host` — see the ABI caveat above).

**What it exercises:** host boot, worklet + handoff + WebView load, the
`vendor.media` picker (picking a photo into the folder), and back/exit navigation.
Flows assert against page-unique web strings rendered inside the WebView.

**Debug-only:** these tests rely on WebView debugging plus a relaxed worklet
handoff deadline, both enabled in debug builds — the release path isn't covered
here.
