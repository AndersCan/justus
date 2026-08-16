# Handoff — Justus (2026-08-16)

Consumer session building **Justus**, a photo-sharing app validating the `@ekrooh/bare` framework beta. Web + backend + **Android host all build and run**; device testing on the Android emulator is partially proven (see Status).

## Repo facts

- `AndersCan/justus`, branch `main`. Monorepo: `apps/web` (lit-html + nanostores + mantaq + UnoCSS), `apps/backend` (Bare worklet: corestore+hyperdrive+hyperswarm store + `justus.photos` plugin), `apps/android` (**compiles + runs on emulator**), `packages/core` (`@justus/core` shared events/types).
- Wayfinder map: **justus#1**. Issues filed from this work: **ekrooh #26–#41** (see below) and **mantaq #182** (actor can die into `__error` during construction with no error signal).
- Mantaq: apps use `@mantaq/core@0.2.0` (latest); `@mantaq/sugar` declared but unused.

## Rules

- Justus is a **consumer** of `@ekrooh/bare@^0.2.0` (JS) + `io.github.anderscan.ekrooh:bare-host:0.3.0` (Android AAR from Maven Central). Ask before touching `AndersCan/ekrooh`; file issues instead.
- All app state = mantaq actors; module-scope nanostore atoms are updated by each actor's change handler; UI reads via computed view-models.
- Gate: `vp check` green. E2e: `pnpm test:e2e` (real-stack Playwright, 5 tests) green.

## Architecture decisions (stable)

- Multi-writer v1 = **creator-mediated registry**: `members.json` in the creator's drive + per-member single-writer hyperdrives. Share key = creator drive key (grants read). Readers join by key; writers enroll via the creator.
- **Derived gallery** (no shared index); per-entry photo metadata; provenance from each drive's `/device.json`; creator tombstones via `/removed.json`.
- hyperdrive **v13 has no mounts** (the v10 group pattern is dead). Encryption = hyperdrive-level, **not** zero-knowledge.
- Invite: creator shows a share-key QR; a new writer returns its drive key + name; creator enrolls.

## Status

- Done: shared events, backend (single-device verified: list/add/status/inbox/spool), web gallery, e2e suite, **Android host compiles + boots on emulator** (worklet boots, gallery UI renders, pick→creator P2P flow works).
- **Blocked**: device **reading** the creator's folder (join) — **ekrooh#41**: on the Android bare-kit worklet, opening a peer's drive times out (`timeout opening remote drive`, 45s), while the reverse direction (device serving its own drive to a peer) works. Host control experiments show bare↔node replication works (incl. a macOS bare-runtime client reading the same drive), so this is on-device-specific.
- Two-device notes: **two emulators can't P2P** (slirp NAT is outbound-only). **Emulator → desktop worklet works one-way** (device→creator). For bidirectional true P2P use a physical device, or wait on #41.
- Note: ekrooh#27 resolved in **0.2.0** — seam APIs (`registerRoute`/`createLoopbackPush`/`plugins`) ship; Justus uses them (`POST /photos` upload + push). **#34 resolved**: `bare-host` now publishes to Maven Central (`io.github.anderscan.ekrooh:bare-host:0.3.0`, no creds).

## Android host (device-test ready)

- `apps/android` — Gradle **8.9** wrapper (AGP 8.5.2), SDK/NDK at `~/Library/Android/sdk`, `local.properties` gitignored. AAR from `mavenCentral()` (no creds).
- Build tasks (`preBuild` deps): `link` (bare-link → `src/main/addons`, entry `apps/backend`), `buildWebAssets` (web dist → assets), `packApp` (bare-pack worklet bundle). Commands resolve against repo root via `ext.justusRoot = file("../../..")`.
- **pnpm hoisted linker required** (`nodeLinker: hoisted` in `pnpm-workspace.yaml`) — bare-link/bare-pack can't traverse pnpm's isolated symlinks (ekrooh#37). `devEngines.packageManager = pnpm 11.22.0`. Don't switch the linker back to isolated.
- Build the APK: `cd apps/android && ./gradlew :app:assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk` (~108 MB).

## Dev

- `pnpm run dev` → web `http://localhost:5173` (Vite proxies `POST /photos` → `:8080`), worklet `ws://127.0.0.1:8080` (auth off, `.dev` storage, seeds 3 photos; gallery "Pick" POSTs to the worklet's real `POST /photos` route; `.dev/inbox` terminal drops also add live).
- Probe: `node apps/backend/scripts/dev-invoke.mjs photos.status` (run from `apps/backend`).
- Local DHT for multi-instance: `node apps/backend/scripts/local-dht.mjs 49737`, pass `bootstrap:127.0.0.1:49737` argv to worklets.
- Port guards in `dev.mjs`/`e2e-server.mjs` (shared `port-utils.mjs`) auto-kill each script's OWN stale worklet (scoped by bundle path — dev kills `.dev/`, e2e kills `dist/`); a foreign worklet on 8080 fails loudly instead of being murdered. Vite runs `--strictPort`.
- Emulator: AVDs `Medium_Phone_API_36.1` (arm64) and `justus-2` (arm64, larger `disk.dataPartition.size=12288M` — emulator `/data` fills up otherwise). `bare-test` is a 32-bit arm image QEMU can't run. `adb input text` is flaky/truncates — verify field contents before tapping Join; read UI via `adb shell uiautomator dump`.

## Ekrooh issues (open, from this work — in scope to unblock device testing)

- **#41** — on-device (Android bare-kit) worklet can't replicate a peer's drive; reverse direction works. **THE blocker for device→creator join/bidirectional sync.** Repro + control experiments documented in the issue.
- **#36** — bare-host POM ships no deps (`api` webkit/appcompat dropped); we add `androidx.webkit:webkit:1.15.0` explicitly.
- **#37** — bare-link/bare-pack need flat npm-style node_modules; bare-link silently links nothing without an entry.
- **#38** — example `workingDir "../../"` fragile for consumers.
- **#39** — on-device argv `[webassets, storage, cache]` undocumented; cache-fallback warning each boot.
- (Earlier: #26–#35 incl. #28 Noise handshake — superseded on Android by #41; #34 creds → resolved by Maven Central publish; #33/#32/#31/#30/#29/#26 docs/seams.)

## Next tasks once ekrooh ships the fix

1. Re-test device **join + bidirectional sync** against a desktop creator worklet (see Repro below).
2. Try a **physical device** as the peer that must accept inbound (LAN) to prove true two-way P2P; emulators stay one-directional (slirp).
3. **Bump JS `@ekrooh/bare` 0.2.0 → 0.3.0** across `apps/web`, `apps/backend`, `packages/core` (matches the 0.3.0 AAR). 0.3.0 changed pending-call semantics (SETTLED/DONE; a handler dying into `__error` rejects). Re-verify `vp check` + `pnpm test:e2e` after.
4. Verify sync UI end-to-end on-device: peers count, photo counts both sides, role read-only vs member, share-key invite between device and desktop.
5. `apps/android/README.md` still documents the old GitHub-Packages-creds flow — update to the Maven Central reality.

## Repro: device → desktop creator (live flow, partial)

- Desktop creator: `cd apps/backend && node scripts/dev.mjs` (port 8080). Status: `node scripts/dev-invoke.mjs photos.status`.
- Device B (emulator-5556): Folder tab → JOIN A FOLDER → paste creator key → Join. Verify device folder swap: `adb -s emulator-5556 shell run-as io.justus.app cat cache/bare/justus.json`. Watch worklet logs for replication errors.
- Works: device→creator (photo picked on device appears in creator folder; `members.json` gets the device's key). Fails (on #41): device reading the creator's drive (join).

## Gotchas (learned + fixed)

- **UnoCSS never generated styles** until `import "uno.css"` (main.ts) + `content.pipeline.include` covering `.ts` (the default pipeline scans vue/svelte/tsx/html, not lit-html `.ts`). The old "dark theme" was unstyled; the warm theme is the first real styling.
- Web UI = warm family-album theme (tokens in `uno.config.ts` + `warm-*` shortcuts): paper/linen/butter/clay/ink palette, serif headings. Gallery: month-grouped grid, presence strip ("In sync"/"Ready to share"/"Waiting for devices"), member color dots, lightbox (swipe/arrows/Esc/remove), remove-with-confirm sheet, role-aware empty state, toasts, 44px touch targets, safe-area + reduced-motion support. Folder page: invite key grouped 8×8 + copy/share feedback, join with Paste + progress + "swaps folder" caution, enroll toast, Advanced `<details>`.
- UI-only atoms live in views (e.g. `$webUploading` in gallery.ts, `$lightbox` in lightbox.ts, `$copied`/`$pasteError`/`$joinProgress` in settings.ts) — they must be consumed through `useStore`, not `.get()` in a template (no re-render).
- `useStore` is a lit-html **directive** — never dereference its result (crashes/silent branches); use `useStore($vm, (vm) => body(vm))` with computed view-models.
- Worklet boot must **not** await swarm/DHT before `runtime.start()` (delays the WS bind → "connection lost"/invoke timeouts); joins are fire-and-forget.
- Set explicit invoke timeouts for spool/network events (`photos.list` 30s, `photos.join` 60s; the 5s default is too tight).
- Seed/imported images must be real decodable files — the e2e asserts `naturalWidth > 0`.
- mantaq's `__error` maps to the app's `error` state via `stateNameOf`, but **`send()` is a no-op after `__error`** — the `$galleryFatal`/`$syncFatal` flag distinguishes a dead machine (UI offers Reload, not Retry). `fatalErrorOf` surfaces `snapshot.error` into the error atom.
- Effects must `return runInvoke(...)` (not `void`) so mantaq's `settled()` tracks the invoke instead of resolving early.
