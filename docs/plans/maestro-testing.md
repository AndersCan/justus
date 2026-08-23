# Plan: Enable Maestro native/device testing for Justus

Status: Implemented (branch `feat/maestro-native-tests`). Plan's bring-up-verified values: picker node = "Photos", settings anchor = "Your folders".
Owner: TBD
Tracking: issue TBD — split into tickets once accepted

## Why

The Android host (`apps/android`) is currently device-tested **manually** (HANDOFF.md:
"compiles + boots on emulator", flows verified by hand via `adb + uiautomator dump`). There is
no repeatable native test gate. Playwright (`pnpm test:e2e`, `e2e/gallery.spec.ts`) only covers
the **web layer** in a desktop browser — it never exercises:

- the real `bare-host` AAR, the worklet bundle, or native addons on-device,
- `MainActivity`'s cold-start → worklet boot → `handoff.json` polling → token injection → WebView load,
- the `vendor.media` pick/capture **host plugins** wired to the real Android system picker,
- the WebView as a rendering surface (not a browser tab),
- OS integration: app launch, back button, process death / `onDestroy` worklet termination
  (back + exit covered by `back.yaml`; process-death check added to task 5).

Maestro (mobile-dev.dev, CLI, YAML flows) gives us a scriptable, repeatable host-level test
surface on the same arm64 emulator we already use (`Medium_Phone_API_36.1` / `justus-2`).

> **Context note** (CONTEXT.md vocabulary): "host" is the native shell, "web layer" is what
> renders in the WebView. Maestro sees both: the host's native chrome AND (with one config flag)
> the web layer inside the WebView. This plan uses "host tests" for the native surface and
> acknowledges that most app UI lives in the WebView.

## The core problem: the UI is a WebView

`MainActivity` renders the app inside a `WebView` (`R.id.webview`) loaded from the worklet's
loopback `http://127.0.0.1:<port>/index.html`. Maestro's native hierarchy reader (accessibility
tree) often **cannot see content inside a WebView on API 33+** (known Maestro issue #1126).
The documented workaround is the `androidWebViewHierarchy: devtools` flow/workspace option, which
drives WebView inspection through Chrome DevTools.

**Decision:** all flows that assert on gallery/settings UI MUST set
`androidWebViewHierarchy: devtools` at the top of the top-level flow file and enable WebView
debugging for the app (`WebView.setWebContentsDebuggingEnabled(true)`). Native-only flows
(worklet boot markers, picker) need it only where they touch web content.

### Enabling WebView debugging

Add to `MainActivity.onCreate` (or a debug gating), guarded so it's off in release:

```kotlin
if (BuildConfig.DEBUG) {
  WebView.setWebContentsDebuggingEnabled(true)
}
```

`BuildConfig.DEBUG` requires `buildFeatures { buildConfig = true }` (AGP 8+ disables it by
default). This is dev-only and does not ship in release builds.

### Relaxing the handoff deadline for debug builds (REQUIRED)

`MainActivity.waitForHandoffAndLoad()` hard-codes a **15_000 ms** poll deadline
(`MainActivity.kt:120`); when it expires the host only logs "Timed out waiting for worklet
handoff file" and **never loads the WebView** (`MainActivity.kt:140–144`). The poll clock starts
in `onCreate` right after `worklet.start()` returns — i.e. the 15s budget includes the AAR +
`main.core.bundle` boot, not just the handoff write. On a cold emulator that is tight and can
blow past 15s.

**This is the single biggest failure mode for Maestro**, because every flow depends on the
WebView loading. A Maestro-side `extendedWaitUntil` with a large timeout does **not** rescue it —
if the host gives up, the page is never navigated to. Fix in the host, gated to debug:

```kotlin
// a BuildConfig-gated handoff window — MUST be larger than the largest flow timeout so the
// host never gives up before Maestro's own wait. Use 90s debug (flows top out at 60s).
// Margin matters: the handoff window runs BEFORE the WebView renders, so it competes with the
// flow's wait for the empty-state. If handoff takes 55s, only ~5s remain of a 60s flow timeout.
private val handoffTimeoutMs = if (BuildConfig.DEBUG) 90_000L else 15_000L
```

and use that in place of the hard-coded `System.currentTimeMillis() + 15_000`. Add this as an
explicit task (see deliverables) and verify it on the cold arm64 AVD before writing flows. Keep
the debug handoff window comfortably **larger than** the largest flow timeout (e.g. 90s debug vs
60s flows); this removes a whole class of intermittent "timed out in the flow but the host never
loaded" confusion.

## What Maestro covers that Playwright can't (scope)

Host/bootstrap (native):

1. App launches from home (icon) and `MainActivity` renders without crashing.
2. Worklet boots on-device from `main.core.bundle` (no `UnsatisfiedLinkError`, no worklet SIGSEGV).
3. `handoff.json` appears and the WebView navigates to the loopback origin; the web layer
   renders the gallery (proves the handoff-poll + token-injection + WebView flow end-to-end).
4. Back button pops WebView history back to the gallery; a clean app exit on a second back.
   (Process-death / worklet termination is checked separately — see task 5.)

Host plugins (vendor.media, only on device): 5. "Pick photo" opens the **real** system photo picker; cancelling returns gracefully. 6. (Optional, needs a seeded photo) picking a real image adds it to the gallery and the folder.

This mirrors the Playwright web coverage (gallery loads, inbox add, upload, lightbox, settings)
but at the host level, so we do NOT re-write every Playwright assertion in Maestro. We write a
**thin host smoke layer** that proves the native shell + WebView + a couple of representative
flows, and keep the deep web assertions in Playwright. This avoids double-maintained UI tests.

## Out of scope / explicitly not covered

- iOS: no iOS host exists yet; this is Android-only for now.
- Re-implementing the full Playwright suite in Maestro (see scope note above).
- Physical devices as a default target (nice-to-have later / in CI via device farm).
- Two-emulator P2P sync (slirp NAT is outbound-only — HANDOFF.md).

## Approach

### 0. Prereqs / assumptions

- Android SDK at `~/Library/Android/sdk`. **Canonical AVD for Maestro: `Medium_Phone_API_36.1`**
  (arm64, API 36) — this is the image the cold-boot timing budget, runner, and CI are measured
  against. `justus-2` (arm64, larger `/data`) is an alternative for flows that fill storage; the
  runner accepts a serial to use either, but the default and all timing figures assume
  `Medium_Phone_API_36.1`.
- `vp` toolchain green (`vp check`), Playwright suite green — Maestro is **additive**.
- Maestro CLI installed on the dev machine:
  ```bash
  curl -fsSL "https://get.maestro.mobile.dev" | bash
  maestro --version
  ```
  (Add to `docs/android-build-dependencies.md`.)

### 1. Workspace + config

Create `.maestro/config.yaml`:

```yaml
flows:
  - "flows/*.yaml"
testOutputDir: .maestro/out
appId: io.justus.app
platform:
  android:
    disableAnimations: true # referenced again in "Determinism" — keep in this canonical file
```

Flows live in `.maestro/flows/`. The `appId` `io.justus.app` matches
`namespace = "io.justus.app"` / `applicationId` in `apps/android/app/build.gradle`.

### 2. Minimal native smoke flow

`.maestro/flows/boot.yaml` — proves host boots, worklet starts, WebView loads web layer and
renders the gallery. Assert against strings that actually render in the web layer (verified in
`apps/web/src/views/gallery.ts`): the `Gallery <h1>` (gallery.ts:282) and the empty-state
`This folder is empty — for now.` (gallery.ts:253). There is **no "Loading…" text in the
gallery** (it exists only in the join/requests view, requests.ts:76) and no "No photos yet"
string anywhere — do not assert those.

```yaml
appId: io.justus.app
androidWebViewHierarchy: devtools
---
- launchApp:
    clearState: true
# ClearState => fresh folder => empty gallery once ready. NOTE: the "Gallery" <h1> (gallery.ts:282)
# is also shown as a persistent header NAV LINK on every page (main.ts:71), so it alone is NOT
# proof the gallery rendered. The page-unique empty-state heading (gallery.ts:253) only mounts when
# photos.length===0 && state==='ready' — that single wait proves boot -> handoff -> WebView load ->
# gallery ready. (The "Gallery" h1 assert is folded into the empty-state wait.)
- extendedWaitUntil:
    visible: "This folder is empty — for now."
    timeout: 60000
```

> **Timeout reality check:** the AAR + `main.core.bundle` cold boot on an arm64 emulator is the
> large, variable part of the budget and it runs _inside_ the host's handoff window. The 60s flow
> timeouts here are only meaningful AFTER the host handoff deadline is relaxed for debug (see the
> handoff-deadline section above) and after that window is verified against cold-boot on the
> target AVD. If handoff exceeds the host's window, the WebView never loads and no Maestro timeout
> helps — fix the host first.

### 3. WebView visibility helper (the tricky bit)

Because the web layer has no stable native IDs, prefer text match against **page-unique** strings
that actually render (verified in `apps/web/src/views/`): `This folder is empty — for now.`
(gallery only), `Your folders` (settings overview only). Beware ambiguous strings: **`Gallery`** is both
the page `<h1>` AND a persistent header nav link on every page (main.ts:71); **`Add a photo`**
exists twice on an empty folder (empty-state button gallery.ts:264 AND header pill gallery.ts:311,
both visible together) — these cannot prove which page/control matched. Prefer page-unique text and
use the debug `data-testid` plan-B hook to pin ambiguous controls. If Maestro's DevTools hierarchy
proves flaky (it has known regressions re `aria`-labelled elements, PR #2350), fall back to one of:

- `tapOn` relative / `point:` coordinates (fragile — last resort),
- Exposing a debug-only test marker: like `window.__ekrooh`, it must be injected **by the host at
  document start** via `WebViewCompat.addDocumentStartJavaScript` (`MainActivity.kt` already does
  this for the token) — a debug-gated injection that sets, say, `window.__justusTest = true` /
  writes `data-testid` attributes. Note this is a **web-layer** change (in `apps/web`) for the
  elements themselves plus a host-side debug-gated injection to expose it, both gated by
  `BuildConfig.DEBUG`. Keep it as plan B until we've confirmed what the DevTools hierarchy exposes.
  **Cost:** any `apps/web` change does not reach the device WebView until the web layer is re-built
  AND re-bundled into the APK (`pnpm/vp build` → full `assembleDebug`, which re-runs
  `link`/`bare-pack`/`buildWebAssets`) → reinstall. If DevTools hierarchy falls back to testids,
  budget a slow rebuild-reinstall loop in bring-up — don't discover it mid-task.

Keep this decision open until the first flow actually runs and we can see what Maestro's
hierarchy exposes.

### 4. Native host-plugin flow

`.maestro/flows/pick.yaml` — proves the real system picker opens (native surface), then returns
to the web layer. The trigger is the web-layer button **`Add a photo`** (gallery.ts:264), which on
device (`window.BareShell === true`) routes to `media.pick("image")` → `PickVisualMedia` — the
real system picker. So this flow MUST set `androidWebViewHierarchy: devtools` (it asserts on web
text "Add a photo"), and the "left the web layer" signal must be a **native** assertion, not a
WebView `assertNotVisible` (when the picker is a separate full-screen activity the WebView
hierarchy is frozen, so `assertNotVisible` is trivially true for the wrong reason).

```yaml
appId: io.justus.app
androidWebViewHierarchy: devtools
---
- launchApp:
    clearState: true
# On an empty folder "Add a photo" is BOTH the header pill (gallery.ts:311) and the empty-state
# button (gallery.ts:264) — both visible. Both call pickAndAdd(), so tapping either is fine; use
# index/testid only if the picker is triggered by the wrong one (it isn't — same handler).
- extendedWaitUntil:
    visible: "Add a photo"
    timeout: 60000
- tapOn: "Add a photo"
# The real photo picker is a SYSTEM surface. Assert its NATIVE accessibility node (Maestro's
# regular hierarchy reads it; no devtools needed for the picker itself). VERIFIED at bring-up on
# the API 36 arm64 emulator: the picker toolbar title is "Photos" (a security note "Justus will
# only have access to the photos you select" and photo thumbnails sit below it).
- extendedWaitUntil:
    visible: "Photos"
    timeout: 15000
- back # cancels the picker -> media.pick fails gracefully (see below)
# Return to the web layer: use the page-unique empty-state heading (not "Add a photo", which is
# ambiguous with the header pill), and allow settle time via extendedWaitUntil.
- extendedWaitUntil:
    visible: "This folder is empty — for now."
    timeout: 15000
```

> `vendor.media`'s pick lands through `ActivityResultContracts.PickVisualMedia` → real picker.
> Backing out cancels the pick, which resolves `media.pick` with "Media pick cancelled"
> (gallery.ts pickAndAdd / MainActivity pickLauncher) and returns to the gallery. Pre-verify the
> actual picker node during bring-up; if it lacks stable a11y text, fall back to asserting a
> native content-desc/id instead of a title.

Optional seeded-pick flow (asserts add-to-gallery): seed a real decodable JPEG into **MediaStore**
(see "Determinism" below — the picker reads MediaStore, not the app cache), then select it in the
picker and assert gallery count grows.

### 4.5 Back button + process-death coverage

Scope item 4 promises "Back button pops WebView history, then exits". Encode it with REAL
navigation — a bare `back` on a freshly-loaded empty gallery has no web history (it triggers
`MainActivity`'s handler at `!webView.canGoBack()`, which exits the app). Navigate into the web
layer first, then go back. `back` is a documented Maestro command.

`.maestro/flows/back.yaml`:

> **Preconditions this flow relies on (verify in bring-up):**
>
> - A `clearState` fresh install auto-creates the device's first **creator** folder with
>   `role: "creator"` and sets it active (photo-store.ts), so the device shows the owner empty
>   state — link text **"Set up another device"** — not the reader variant "Join a folder"
>   (gallery.ts:267-268), and `/settings` renders the **"Your folders"** overview (settings.ts:166).
>   (settings.ts:397's older "Active folder" panel is a different branch, not rendered on a fresh
>   install.) If that auto-create ever changes, re-verify this flow.
> - `back` popping history (rather than exiting) depends on the gallery→/settings SPA
>   `pushState` navigation being recorded in the WebView back/forward list so `canGoBack()` is
>   true. If it is not recorded, `MainActivity.kt:104-110` hits `!canGoBack()` and **exits the
>   app** (failing the return awaits loudly). This is a known, checkable coupling, not a bug.

```yaml
appId: io.justus.app
androidWebViewHierarchy: devtools
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible: "Set up another device" # empty-state link that navigates to /settings
    timeout: 60000
- tapOn: "Set up another device"
- extendedWaitUntil:
    visible: "Your folders" # Settings overview header (settings.ts:166) — page-unique
    timeout: 60000
- back # pops WebView history back to the gallery
# NB "Gallery" CANNOT be the return check: it is also a persistent header nav link on every page
# (main.ts:71), so it passes vacuously. Prove we left /settings AND re-rendered the gallery.
- extendedWaitUntil:
    notVisible: "Your folders"
    timeout: 15000
- extendedWaitUntil:
    visible: "This folder is empty — for now."
    timeout: 15000
```

For `onDestroy` worklet termination (task 5): after the gallery round-trip, `back` once more so
`MainActivity` exits (its back handler at `!canGoBack()`, MainActivity.kt:104-110), then assert the
worklet process is gone, e.g. `adb shell pidof io.justus.app` is empty or `run-as io.justus.app ps`
shows nothing — this converts Why's "process death / onDestroy termination" promise into a
testable assertion rather than an unchecked claim.

### 5. Local runner

Add `scripts/maestro-e2e.sh` (or `.mjs`) that, in order:

1. `cd apps/android && ./gradlew :app:assembleDebug` (APK → `app-debug.apk`).
2. **Pin the canonical AVD `Medium_Phone_API_36.1`** (the named baseline for timing/CI). If an
   emulator with that AVD is already running, reuse it; otherwise kill any stale emulator holding
   that AVD and cold-boot it (`$ANDROID_HOME/emulator/emulator -avd <name> &`), then wait for full
   boot (`adb wait-for-device` then poll `sys.boot_completed`). Note cold-boot JIT/warming adds
   significant time — plan flow timeouts against the _cold_ figure, and give the boot step its own
   generous bound. If a device serial is passed, use it; otherwise fail loudly if multiple devices
   are attached (bare `adb` / `maestro` are ambiguous with >1 device).
3. `adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk`.
4. `maestro --device <serial> test .maestro/flows` — note `--device` goes **before** `test`.
5. On any failure, dump the diagnostics that explain WHY a flow failed — `adb logcat -d -s
JUSTUS_ANDROID` (MainActivity logs on tag `JUSTUS_ANDROID`, incl. the handoff timeout) plus
   worklet logs — into `.maestro/out/` and print them. Print the result and point at
   `.maestro/out` (screenshots/logs).

Wire into `package.json`:

```json
"test:native": "bash scripts/maestro-e2e.sh"
```

so `vp run test:native` is the repeatable gate, parallel to `test:e2e`. It must NOT be part of
the fast `vp check`/`test` gate (needs SDK + emulator + a built APK).

### 6. Determinism / state isolation

- Every flow starts `clearState: true` so the worklet cold-boots into a fresh folder (mirrors the
  fresh-worklet assumption of the Playwright suite). With `clearState` the folder starts empty, so
  gallery counts are already deterministic — no need for unique seed data to de-race counts.
- Media seeding for the pick path: the system photo picker (`PickVisualMedia`) reads
  **MediaStore** (`/sdcard/Pictures`, …), NOT the app's private cache — a file in
  `cache/bare` never appears in the picker. Seed a real decodable JPEG into shared media and
  trigger a media scan:
  ```bash
  adb -s <serial> push seed.jpg /sdcard/Pictures/justus-seed.jpg
  adb -s <serial> shell cmd media scan /sdcard/Pictures/justus-seed.jpg
  ```
  Because the seed lives in device media storage, a later `pm clear`/`clearState` (which only
  clears app-private data) does **not** wipe it — so there is no "seed after clear" ordering
  requirement for the picker path. (`run-as io.justus.app …` is only for the worklet's _own_
  storage, e.g. the join/folder sync repro in HANDOFF.md — not for picker-visible media.)
- Disable animations in `config.yaml` (`platform.android.disableAnimations`) and via emulator
  flags for stable tap timing.

### 7. CI (optional, follow-up)

> **ABI constraint:** the bare-host AAR + `apps/backend` native addons are **arm64**. A CI
> self-hosted emulator must therefore be arm64 (or physical arm64 device) — an **x86_64** emulator
> cannot load these `.so` libs, so a default KVM x86_64 runner is a dead end for boot flows. Weigh
> this against the fact that `ReactiveCircus/android-emulator-runner` uses x86 images by default.

Paths, in order of preference:

- **Maestro Cloud** (`mobile-dev-inc/action-maestro-cloud`): upload built APK, run against a real
  arm64 device farm; needs `MAESTRO_API_KEY` + project id. Best for physical-device coverage and
  unblocking bidirectional P2P testing later. This is the recommended CI path.
- **Self-hosted arm64 emulator** (`ReactiveCircus/android-emulator-runner` with an arm64 system
  image, or an arm64 self-hosted runner): possible but harder to provision reliably in the cloud;
  and AVDs/`~/.android` are dev-local, so CI must provision its own arm64 image rather than reuse
  the mac ones.

> Caveat: emulator CI can't exercise true inbound-P2P (HANDOFF.md: slirp NAT is outbound-only);
> a device farm / physical device is required for bidirectional sync flows. Scope CI to the
> smoke + pick flows, not P2P.

## Deliverables / tasks (ticket breakdown)

1. **Setup**: install Maestro, add `.maestro/config.yaml`, `docs/android-build-dependencies.md`
   note. (research/task)
2. **Host test switches**: `BuildConfig.DEBUG`-gated (a) `setWebContentsDebuggingEnabled` +
   `buildConfig` buildFeature, and (b) **relaxed handoff deadline** (15s → ~90s in debug, larger
   than the 60s flow timeouts). Both required before flows can pass on a cold emulator. (task)
3. **Boot flow**: `.maestro/flows/boot.yaml` + get DevTools hierarchy working; decide on the
   test-hook fallback. (task + prototyping)
4. **Host-plugin flow**: `.maestro/flows/pick.yaml` — **hard deliverable**: pre-verify and pin the
   native picker node on the target API (the flow hard-codes a placeholder); optional seeded add.
   (task + prototyping)
5. **Back/death flow**: `.maestro/flows/back.yaml` (back-pops-history + **clean exit on a second
   back**). Add an explicit process-death check: after the gallery round-trip, `back` again, then
   assert the worklet process is gone (`adb shell pidof io.justus.app` empty / `run-as … ps`) — this
   is what encodes the "onDestroy worklet termination" coverage; without it, move that item out of
   scope. (task)
6. **Runner + package.json**: `scripts/maestro-e2e.sh`, `test:native`, update HANDOFF.md +
   `docs/agents` conventions. (task)
7. **CI** (optional/follow-up): Maestro Cloud (recommended) or arm64 self-hosted emulator
   workflow. (task)

## Risks / open questions

- **Host handoff deadline vs cold boot (HIGHEST)** — `MainActivity` hard-codes a 15s handoff poll
  window (`MainActivity.kt:120`) that starts in `onCreate` (i.e. it includes AAR + bundle boot),
  and on expiry the WebView is **never loaded** — no Maestro timeout can recover. Every flow
  depends on the WebView loading, so this single gap can sink the whole effort. Mitigation: the
  debug-gated relaxed deadline in task 2, verified on a cold arm64 AVD first.
- **WebView hierarchy reliability on API 36** (Maestro #1126 is still intermittently failing for
  some users on API 36 even with `devtools`). Mitigation: test the emulator AVD in bring-up
  before committing to this approach; keep the debug test-marker hook as plan B.
- **Worklet boot time on emulator** — the AAR + bundle cold boot is the large, variable part of
  the budget and it runs _inside_ the host's handoff window; the plan relies on the no-DHT-awaits
  boot path (HANDOFF.md) keeping that budget tight. Verify, don't assume.
- **Gradle exec tasks** (`link`, `packApp`, `buildWebAssets`) need node/pnpm/vp on PATH — reuse
  `getExtendedPath()` (already in `app/build.gradle`); the runner must run from repo root or the
  same cwd Gradle expects (`workingDir "../../.."`).
- **`local.properties` gitignored** — a fresh CI checkout needs `ANDROID_HOME`/`sdk.dir`; set in
  CI env (and note AVDs are dev-local, so CI provisions its own arm64 image — see CI ABI note).
- **Flaky `adb input`** (HANDOFF.md) does not apply — Maestro drives via its own hierarchy/tap,
  but we should verify text entry (join flow would need it) before relying on input in flows.
- **App ID vs label**: ensure flows target `io.justus.app` (applicationId), not the display
  label.
