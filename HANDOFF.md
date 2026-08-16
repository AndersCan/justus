# Handoff — Justus (2026-08-14)

Consumer session building **Justus**, a photo-sharing app validating the `@ekrooh/bare` framework beta.

## Repo facts

- `AndersCan/justus`, branch `main`. Monorepo: `apps/web` (lit-html + nanostores + mantaq + UnoCSS), `apps/backend` (Bare worklet: corestore+hyperdrive+hyperswarm store + `justus.photos` plugin), `apps/android` (host scaffold, NOT compiled), `packages/core` (`@justus/core` shared events/types).
- Wayfinder map: **justus#1**. Issues filed from this work: **ekrooh #26–#35** (docs/seam gaps + bare-swarm blocker + runtime CLI-config gap) and **mantaq #182** (actor can die into `__error` during construction with no error signal).
- Mantaq: bumped `@mantaq/sugar` to 0.3.0 (`@mantaq/core` stays 0.2.0 — latest). Apps use only `@mantaq/core`; sugar is declared but unused.

## Rules

- Justus is a **consumer** of `@ekrooh/bare@0.2.0` (bumped from 0.1.0 — now uses the real `registerRoute` upload + `createLoopbackPush` seams). Ask before touching `AndersCan/ekrooh`; file issues instead.
- All app state = mantaq actors; module-scope nanostore atoms are updated by each actor's change handler; UI reads via computed view-models.
- Gate: `vp check` green. E2e: `pnpm test:e2e` (real-stack Playwright, 5 tests) green.

## Architecture decisions (stable)

- Multi-writer v1 = **creator-mediated registry**: `members.json` in the creator's drive + per-member single-writer hyperdrives. Share key = creator drive key (grants read). Readers join by key; writers enroll via the creator.
- **Derived gallery** (no shared index); per-entry photo metadata; provenance from each drive's `/device.json`; creator tombstones via `/removed.json`.
- hyperdrive **v13 has no mounts** (the v10 group pattern is dead). Encryption = hyperdrive-level, **not** zero-knowledge.
- Invite: creator shows a share-key QR; a new writer returns its drive key + name; creator enrolls.

## Status

- Done: shared events, backend (single-device verified: list/add/status/inbox/spool), web gallery, e2e suite.
- **Blocked**: cross-device P2P — **ekrooh#28** (bare hyperswarm Noise handshake fails on macOS). Android APK — toolchain installed locally (SDK/NDK 27.2.12479018/Gradle 8.9), but the APK build is blocked by two issues: `io.ekrooh:bare-host` GitHub Packages creds (**ekrooh#34** filed) and `bare-pack`'s `streamx` resolution failure under pnpm's non-hoisted layout. See `docs/android-build-dependencies.md`.
- Note: ekrooh#27 resolved in **0.2.0** — the seam APIs (`registerRoute`/`createLoopbackPush`/`plugins` option) ship; Justus upgraded and uses them (`POST /photos` upload route + push).
- Android build fixes made: `app/build.gradle` — `justusRoot` was a script-local invisible to the `configureExec` method → now `ext.justusRoot = file("../../..")` (off-by-one: repo root is 3 up from `app/`), and `buildWebAssets` now `mkdir -p`s the assets dir before `cp`.

## Dev

- `pnpm run dev` → web `http://localhost:5173` (Vite proxies `POST /photos` → `:8080`), worklet `ws://127.0.0.1:8080` (auth off, `.dev` storage, seeds 3 photos; gallery "Pick" POSTs to the worklet's real `POST /photos` route; `.dev/inbox` terminal drops also add live).
- Probe: `node apps/backend/scripts/dev-invoke.mjs photos.status` (run from `apps/backend`).
- Local DHT for multi-instance: `node apps/backend/scripts/local-dht.mjs 49737`, pass `bootstrap:127.0.0.1:49737` argv to worklets.
- Port guards in `dev.mjs`/`e2e-server.mjs` (shared `port-utils.mjs`) auto-kill each script's OWN stale worklet (scoped by bundle path — dev kills `.dev/`, e2e kills `dist/`); a foreign worklet on 8080 fails loudly instead of being murdered. Vite runs `--strictPort`.

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
