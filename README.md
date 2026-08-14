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
- **Dev-only adds**: drop a photo into `apps/backend/.dev/inbox/` and it is
  imported into the gallery within ~2s (browser dev has no native picker).
- `node apps/backend/scripts/dev-invoke.mjs photos.status` probes the worklet
  over the protocol.
- `node apps/backend/scripts/local-dht.mjs 49737` starts a local DHT bootstrap;
  pass `bootstrap:127.0.0.1:49737` to worklet instances for deterministic
  local P2P.

## Status

| Slice                                               | State                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shared events package (`@justus/core`)              | ✅                                                                                                                                      |
| Backend worklet (store, plugin, loopback, dev loop) | ✅ single-device verified (list/add/status/inbox/spool)                                                                                 |
| Web gallery app                                     | ✅ built + reviewed (runs against the dev backend)                                                                                      |
| Android host                                        | ✅ scaffolded to the reference pattern (needs AAR creds + SDK to compile)                                                               |
| P2P sync across devices                             | ⚠️ blocked by **ekrooh#28** — bare-runtime hyperswarm Noise handshakes fail on macOS; on-device (Keet/Agregore) is the production proof |

See the [wayfinder map](https://github.com/AndersCan/justus/issues/1) for the
decision history and remaining tickets.
