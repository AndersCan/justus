# Justus Android host

The Android shell for Justus: a WebView app that starts the Bare worklet backend
(`apps/backend`), serves the built web app from the worklet's loopback server,
and wires the native `vendor.media` pick/capture host plugins (so "Pick photo"
opens the system picker on device).

Consumes the published **`io.ekrooh:bare-host`** AAR from GitHub Packages
(Android host library: Bare Kit runtime + framework host classes).

## Layout

- `settings.gradle` — resolves `io.ekrooh:bare-host` from
  `https://maven.pkg.github.com/AndersCan/ekrooh`.
- `app/src/main/nativehelper/` — bundled `libnativehelper.so` shim. The published `bare-host` AAR's
  `libbare-kit.so` `DT_NEED`s `libnativehelper.so` (a private Android platform lib) but never ships nor
  calls into it, so `System.loadLibrary("bare-kit")` fails on install-run without this shim present in
  the app's jniLibs (**ekrooh#45**). Do not remove it while consuming `bare-host` 0.3.0.
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

Full tool-by-tool list (versions, archives, network endpoints, Docker notes):
**see [`docs/android-build-dependencies.md`](../../docs/android-build-dependencies.md)**.

- **GitHub Packages credentials** — even for public packages, GitHub Packages
  Maven requires a token. Put in `~/.gradle/gradle.properties`:
  `GH_USER=<github username>` and `GH_TOKEN=<PAT with read:packages>`
  (or export the same names). Tracked as ekrooh#34.
- **Android SDK** — `local.properties` with `sdk.dir=...` (or `ANDROID_HOME`).
- **Node/pnpm/vp** on PATH (the Gradle exec tasks run the monorepo builds).

## Build

The repo doesn't commit a Gradle wrapper. AGP 8.5.2 needs **Gradle 8.7+** — either use a system `gradle` (8.x) or generate a wrapper once:

```bash
cd apps/android
gradle wrapper --gradle-version 8.9
./gradlew :app:assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`. On the emulator/
device, the gallery's "Pick photo" button opens the system picker; the worklet
stores the photo in the folder drive and serves it over the loopback server.

> **Device ABI caveat:** verified booting on the **arm64 emulator**. The physical
> Nexus 7 (`flo`) runs **LineageOS 18.1 (Android 11)** but on a **32-bit-only**
> userspace (`zygote32`) and cannot run `bare-host` 0.3.0 — it SIGSEGVs in
> `bare_kit__on_thread_enter` even with the `libnativehelper` shim
> (ekrooh#46). Use an arm64 emulator/device for on-device testing.

> Note: this host app was scaffolded to the framework's reference pattern but
> has not been compiled here — the AAR credentials and an Android SDK were not
> available in the authoring environment. Run `./gradlew :app:assembleDebug`
> on a machine with the prerequisites to produce the APK, and file any
> `io.ekrooh:bare-host` API gaps against AndersCan/ekrooh.
