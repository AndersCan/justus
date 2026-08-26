# Justus

One soul, many platforms. A peer-to-peer, encrypted photo-sharing app built on
[`@ekrooh/bare`](https://github.com/AndersCan/ekrooh) — the same app, state, and
photos on Android, iOS, web, and desktop. Justus is also the consumer app that
validates the ekrooh framework's beta (findings are filed as ekrooh issues).

- **Gallery** — photos live in a shared folder, each member writes to their own
  single-writer drive (multi-writer v1 via a creator-mediated registry).
- **Sync** — folders replicate peer-to-peer over Hyperswarm (hyperdrive +
  corestore per app).
- **State** — every state machine is a mantaq actor; actor contexts hold
  nanostore atoms the UI reads reactively (lit-html + UnoCSS).

## Architecture

```
apps/web       Gallery UI (lit-html + nanostores + mantaq + UnoCSS)
apps/backend   Bare worklet: photo store (corestore+hyperdrive+hyperswarm),
               the justus.photos plugin, loopback serving, dev inbox
apps/android   Android host (WebView + Bare worklet + media pick/capture)
packages/core  Shared justus.photos events + types (@justus/core)
```

The web layer talks to the worklet over a framed WebSocket (binary protocol);
photos are served out-of-band by the worklet's loopback HTTP server (cookie
auth on device). Media bytes never cross the wire protocol.

## Development

```bash
pnpm install
vp check              # format + lint + typecheck
pnpm run dev          # runs apps/web (Vite :5173) + apps/backend (bare :8080) concurrently
```

Backend dev details:

- The worklet runs under the `bare` CLI with persistent storage under
  `apps/backend/.dev/` (gitignored), auth off, port 8080, and seeds sample
  photos on first run.
- **Dev-only adds**: use the gallery's **Pick photo** button — it POSTs your
  chosen file to the worklet's own `POST /photos` upload route (Vite-proxied
  in dev), imported within ~2s — or drop a photo into
  `apps/backend/.dev/inbox/` directly. Browser dev has no native picker host.
- `node apps/backend/scripts/dev-invoke.mjs photos.status` probes the worklet
  over the protocol.
- `node apps/backend/scripts/local-dht.mjs 49737` starts a local DHT bootstrap;
  pass `bootstrap:127.0.0.1:49737` to worklet instances for deterministic
  local P2P.

### System dependencies

The in-browser e2e (`pnpm test:e2e`) boots the **real** Bare worklet, whose
`rocksdb-native` addon links `libatomic.so.1`. That library is **not** shipped
by most base images or dev containers, so the worklet fails at startup with an
opaque native-load error:

```text
Uncaught AddonError: CANNOT_LOAD: Cannot load addon
  '.../node_modules/rocksdb-native/prebuilds/linux-arm64/rocksdb-native.bare'
[cause]: Error: libatomic.so.1: cannot open shared object file
```

Install it before running e2e (or anything that loads the real worklet) on a
Debian/Ubuntu host or CI runner:

```bash
sudo apt-get update && sudo apt-get install -y libatomic1
```

The e2e server fails fast with this hint if the worklet can't boot for a missing
system library (`scripts/e2e-server.mjs`). Any CI image that runs `pnpm test:e2e`
must include `libatomic1` (or use a base image that already provides it).

### Verify the proof of concept (#20)

The headline POC acceptance criterion — _create a folder, add a photo, the
browser shows it_ — is wired end-to-end. The backend half is covered by an
automated round-trip test; the in-browser half is a manual check.

- **Backend round-trip (automated):** `apps/backend` runs
  `test/photo-store.poc.test.ts`, which drives
  `createFolder → setActive → addBytes → list()` through the in-memory fake-drive
  harness and asserts the photo reaches the gallery projection. `pnpm test` in
  `apps/backend` must be green (currently 83/83).
- **In-browser (manual):** `pnpm run dev`, open the web app, create a folder,
  then click **Add a photo** (web) or use the native picker host (Android). The
  chosen file is POSTed to `POST /photos` (Vite-proxied in dev) or imported from
  the device cache; the gallery refreshes live via the `photos.changed` push and
  the new photo appears within ~2s. The readable filename comes from the drive
  `metadata.name` (the in-memory fake-drive harness falls back to the drive
  basename).
- **Scope:** this verifies the single-device path. Cross-device replication is
  still gated on **ekrooh#28** (bare-runtime hyperswarm Noise handshake on macOS).

## Status

| Slice                                                              | State                                                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shared events package (`@justus/core`)                             | ✅                                                                                                                                      |
| Backend worklet (store, plugin, loopback, dev loop)                | ✅ single-device verified (list/add/status/inbox/spool)                                                                                 |
| Web gallery app                                                    | ✅ built + reviewed (runs against the dev backend)                                                                                      |
| POC acceptance (#20): create folder → add photo → gallery shows it | ✅ single-device (backend round-trip + web path verified; in-browser confirmation is a manual step)                                     |
| Android host                                                       | ✅ scaffolded to the reference pattern (needs AAR creds + SDK to compile)                                                               |
| P2P sync across devices                                            | ⚠️ blocked by **ekrooh#28** — bare-runtime hyperswarm Noise handshakes fail on macOS; on-device (Keet/Agregore) is the production proof |

See the [wayfinder map](https://github.com/AndersCan/justus/issues/1) for the
decision history and remaining tickets.
