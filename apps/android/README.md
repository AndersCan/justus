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

- **GitHub Packages credentials** — even for public packages, GitHub Packages
  Maven requires a token. Put in `~/.gradle/gradle.properties`:
  `GH_USER=<github username>` and `GH_TOKEN=<PAT with read:packages>`.
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

> Note: this host app was scaffolded to the framework's reference pattern but
> has not been compiled here — the AAR credentials and an Android SDK were not
> available in the authoring environment. Run `./gradlew :app:assembleDebug`
> on a machine with the prerequisites to produce the APK, and file any
> `io.ekrooh:bare-host` API gaps against AndersCan/ekrooh.
