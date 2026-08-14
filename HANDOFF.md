# Handoff — Justus (2026-08-14)

Consumer session building **Justus**, a photo-sharing app validating the `@ekrooh/bare` framework beta.

## Repo facts

- `AndersCan/justus`, branch `main`. Monorepo: `apps/web` (lit-html + nanostores + mantaq + UnoCSS), `apps/backend` (Bare worklet: corestore+hyperdrive+hyperswarm store + `justus.photos` plugin), `apps/android` (host scaffold, NOT compiled), `packages/core` (`@justus/core` shared events/types).
- Wayfinder map: **justus#1**. Framework issues filed from this work: **ekrooh #26–#33** (docs/seam gaps + bare-swarm blocker). Research notes: `research/multi-writer-folder.md`, `research/hyperdrive-mobile.md`.

## Rules

- Justus is a **consumer** of `@ekrooh/bare@0.1.0`. Ask before touching `AndersCan/ekrooh`; file issues instead.
- All app state = mantaq actors; nanostore atoms live in actor contexts; UI reads via computed view-models.
- Gate: `vp check` green. E2e: `pnpm test:e2e` (real-stack Playwright, 3 tests) green.

## Architecture decisions (stable)

- Multi-writer v1 = **creator-mediated registry**: `members.json` in the creator's drive + per-member single-writer hyperdrives. Share key = creator drive key (grants read). Readers join by key; writers enroll via the creator.
- **Derived gallery** (no shared index); per-entry photo metadata; provenance from each drive's `/device.json`; creator tombstones via `/removed.json`.
- hyperdrive **v13 has no mounts** (the v10 group pattern is dead). Encryption = hyperdrive-level, **not** zero-knowledge.
- Invite: creator shows a share-key QR; a new writer returns its drive key + name; creator enrolls.

## Status

- Done: shared events, backend (single-device verified: list/add/status/inbox/spool), web gallery, e2e suite.
- **Blocked**: cross-device P2P — **ekrooh#28** (bare hyperswarm Noise handshake fails on macOS). Android APK — needs `io.ekrooh:bare-host` GitHub Packages creds + Android SDK.
- Note: ekrooh#27 — published npm package still lacks the seam APIs (`createLoopbackPush`/`registerRoute`/`plugins` option); workarounds in use.

## Dev

- `pnpm run dev` → web `http://localhost:5173`, worklet `ws://127.0.0.1:8080` (auth off, `.dev` storage, seeds 3 photos, `apps/backend/.dev/inbox` drops add live).
- Probe: `node apps/backend/scripts/dev-invoke.mjs photos.status` (run from `apps/backend`).
- Local DHT for multi-instance: `node apps/backend/scripts/local-dht.mjs 49737`, pass `bootstrap:127.0.0.1:49737` argv to worklets.
- Port guards in `dev.mjs`/`e2e-server.mjs` auto-kill stale worklets on 8080; Vite runs `--strictPort`.

## Gotchas (learned + fixed)

- `useStore` is a lit-html **directive** — never dereference its result (crashes/silent branches); use `useStore($vm, (vm) => body(vm))` with computed view-models.
- Worklet boot must **not** await swarm/DHT before `runtime.start()` (delays the WS bind → "connection lost"/invoke timeouts); joins are fire-and-forget.
- Set explicit invoke timeouts for spool/network events (`photos.list` 30s, `photos.join` 60s; the 5s default is too tight).
- Seed/imported images must be real decodable files — the e2e asserts `naturalWidth > 0`.
