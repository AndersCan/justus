# Android build dependencies (for a Docker build image)

Single source of truth for every tool the Justus Android host build needs, so a
CI/Docker image can be assembled reproducibly. Verified against this machine
(Aug 2026): the Gradle configuration and all asset-prep tasks run; the final
APK assembly is blocked only by the two issues at the bottom.

## Build pipeline

```
gradle :app:assembleDebug
 ├─ :app:link          bare-link --preset android   → src/main/addons/ (jniLibs)
 ├─ :app:buildBareJs   pnpm --filter @justus/backend run build   → dist/main.core.gen.js
 ├─ :app:buildWebAssets pnpm --filter @justus/web run build + cp → src/main/assets/
 ├─ :app:packApp       bare-pack --preset android   → src/main/assets/main.core.bundle
 └─ AGP compile + package (io.ekrooh:bare-host AAR + Kotlin + res)
```

## Required tools

| Tool                      | Version                                                             | Used by                                      | Notes                                                                                             |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **JDK**                   | 17+ (21 tested)                                                     | AGP/Kotlin compile                           | `sourceCompatibility`/`targetCompatibility` = 17; AGP 8.5.2 needs ≥17                             |
| **Gradle**                | **8.9**                                                             | wrapper-less build                           | AGP 8.5.2 needs ≥8.7; repo has no wrapper — install 8.9                                           |
| **Android SDK**           | platforms **android-35**, build-tools ≥34.0.0, platform-tools (adb) | compileSdk/targetSdk 35, minSdk 29           | licenses must be accepted                                                                         |
| **Android NDK**           | **27.2.12479018** (r27c)                                            | AGP pin (`ndkVersion`)                       | required by AGP even though all jniLibs are **prebuilt** (see below)                              |
| **GitHub Packages creds** | PAT with `read:packages`                                            | `io.ekrooh:bare-host:0.1.0` AAR              | from `GH_USER`/`GH_TOKEN` env or `~/.gradle/gradle.properties`; see blocker #1                    |
| **Node.js**               | ≥22.18                                                              | `pnpm`, `vp`, esbuild, bare-link, bare-pack  | repo `engines.node`                                                                               |
| **pnpm**                  | 10.x (workspace)                                                    | install + the `--filter` builds Gradle execs | monorepo + `catalog:` deps; **not** npm                                                           |
| **vp** (vite-plus)        | via `vite-plus` devDep                                              | `apps/web` build (`tsc && vp build`)         | resolved from `node_modules/.bin` — no global install needed                                      |
| **bare-link**             | 3.3.0 (backend devDep)                                              | `:app:link`                                  | **copies prebuilt** `prebuilds/android-*` addons + SONAME-patches them — no cross-compiler needed |
| **bare-pack**             | 2.2.1 (backend devDep)                                              | `:app:packApp`                               | packs the worklet bundle for bare-kit                                                             |
| **esbuild**               | 0.28.x (backend devDep)                                             | worklet bundle                               |                                                                                                   |

Native addons (sodium, rocksdb, udx-*) ship **prebuilt** in npm
(`prebuilds/android-{arm,arm64,ia32,x64}`); `bare-link` only copies and
re-sonames them. A C/C++ cross-toolchain (clang/cmake) is **not** required.

## SDK/NDK install (host-arch-specific archives)

- NDK **r27c**:
  - Linux (Docker): `https://dl.google.com/android/repository/android-ndk-r27c-linux.zip` → unpack to `$ANDROID_HOME/ndk/27.2.12479018`
  - macOS: `.../android-ndk-r27c-darwin.zip`
- SDK components via `cmdline-tools` + `sdkmanager`, or layer the dirs directly
  (platforms;android-35, build-tools;35.0.0, platform-tools, ndk;27.2.12479018).

## Network endpoints the image needs

`dl.google.com` (SDK/NDK) · `services.gradle.org` (Gradle) · `plugins.gradle.org`,
`dl.google.com` Maven, `repo.maven.apache.org` (AGP/Kotlin/androidx) ·
`maven.pkg.github.com/AndersCan/ekrooh` (**auth**) · npm/pnpm registry (monorepo).

## Build steps in the container

```bash
# repo mounted at /src; deps installed with the workspace layout intact
corepack enable && corepack prepare pnpm@10 --activate
cd /src && pnpm install            # must run BEFORE gradle (exec tasks use node_modules)

export ANDROID_HOME=/opt/android-sdk
echo "sdk.dir=/opt/android-sdk" > apps/android/local.properties

cd apps/android
gradle :app:assembleDebug          # APK → app/build/outputs/apk/debug/app-debug.apk

# install on a device/emulator attached to the HOST
adb install app/build/outputs/apk/debug/app-debug.apk
```

## Docker-specific notes

- `apps/android/local.properties` is gitignored; create it in the image or set
  `ANDROID_HOME` (AGP accepts either).
- The image only needs to **produce the APK**; the emulator/device stays on the
  host (`adb` must exist on the host to install).
- Gradle exec tasks run `pnpm`/`vp`/`bare-*` from the monorepo root — the image
  needs Node + the installed `node_modules`, not just the Android toolchain.
- Keep `GH_USER`/`GH_TOKEN` as build-time secrets (env), never bake into the image.

## Maestro CLI (dev-only, for the native UI tests)

Maestro ([`maestro`](https://maestro.mobile.dev)) runs the native/device UI test
suite (`bash scripts/maestro-e2e.sh`, a.k.a. `vp run test:native`) against the
installed APK. It is **not** needed to build the APK — only to run the
`.maestro/flows/` device tests on an emulator/device.

- Install: `curl -fsSL "https://get.maestro.mobile.dev" | bash`
- Recommended version: **2.8.0** (tested).
- Modeled in the Docker image? No — builds stay APK-only; Maestro runs on the
  host with the emulator/device attached (alongside `adb`).

## Open blockers

1. **`io.ekrooh:bare-host` needs a PAT** — GitHub Packages Maven requires auth
   even for public artifacts. Tracked as **ekrooh#34** (ask: publish to Maven
   Central or document a mirror). Until resolved, every build needs
   `GH_USER` + `GH_TOKEN`.
2. **`bare-pack` fails on pnpm's non-hoisted layout** —
   `ModuleTraverseError: MODULE_NOT_FOUND: Cannot find module 'streamx'
imported from 'hyperswarm/index.js'` in `:app:packApp`. `streamx` lives in
   the pnpm `.pnpm` store, not hoisted to `apps/backend/node_modules`.
   Mitigations to try: install with `node-linker=hoisted` (`.npmrc` /
   `pnpm install --config.node-linker=hoisted`), or move the pack step to a
   path with a flat `node_modules`. If neither works, file against
   AndersCan/ekrooh (bare-pack is its tooling).
