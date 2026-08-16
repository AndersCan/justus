# Lessons learned (2026-08-16 — multi-folder + ekrooh bump session)

Operational and architectural mistakes from the multi-folder rework + `@ekrooh/bare`
0.2.0 → 0.4.0 bump. Written so a later session avoids re-deriving these the hard way.

## Tooling / process

1. **Don't leave a Bare worklet / `e2e-server.mjs` running in the background.** Launching
   `node scripts/e2e-server.mjs` (or the booted worklet) as a background process tied to the
   session made shell and read tools intermittently return **empty results** (a broad,
   confusing tooling disruption) until everything was killed (`pkill -f e2e-server.mjs`,
   `killall -9 bare`). When diagnosing the worklet, boot it inside a **single self-contained
   script** that starts it, waits for a marker line, dumps the log + persisted state, then
   kills it — never as a `background:true` tool call you then probe from separate calls.

2. **Bump ekrooh before doing app work that targets its API.** This session bumped
   `@ekrooh/bare` mid-flight while a backend subagent was rewriting `photo-store.ts` against
   0.2.0. The bump raced the rewrite and cost reconciliation. Bump first, `vp check`, then write
   app code on top.

## Ekrooh / bare 0.4.0 regressions (this bump specifically)

3. **`Buffer.from(string, "base64")` now throws `Invalid input` in the bare runtime** on
   otherwise-valid base64 (Node's `Buffer` decodes the same strings fine — so a
   `node -e` sanity check does NOT catch it). It runs at **module top-level**, so it crashes
   the _entire worklet at load_ (`Module._evaluate` → `Uncaught Error: Invalid input`), before
   any `[justus]` log line. Fix: decode base64 with a small dependency-free helper
   (`base64ToBytes()` in `apps/backend/src/photo-store.ts`) returning a `Uint8Array`, not
   `Buffer.from(..., "base64")`.

4. **`resolveWorkletConfig()` now parses the CLI labeled tokens** (`webassets=`, `storage=`,
   `cache=`, `inbox=`, `port=`) used by the e2e/dev servers — so `device.storage` becomes set
   in dev/e2e, not just on-device. `config.ts`'s old `if (device.storage) -> dev:false` guard
   silently flipped dev/e2e into `dev:false`, disabling seeding (`seedOnEmpty=false`) → fresh
   gallery had 0 photos. Fix: `if (device.storage && device.deviceMode !== false)` — the CLI
   explicitly sets `deviceMode:false`, on-device host config doesn't.

## Multi-folder rework (backend)

5. **Register every new runtime in the `runtimes` map.** The `setup()` first-folder branch
   pushed the `FolderRecord` into `state.folders`, set `activeFolderId`, and persisted — but
   **never called `runtimes.set(folderId, rt)`** (every other path — reopen loop, `join()`,
   `createFolder()` — does). Result: `activeRuntime()` → null → `computeStatus()` fell to its
   `role=reader photos=0` fallback even though `justus.json` persisted a correct creator
   folder. Symptom looked like "seeding broken" but was a missing map registration.

6. **A push/status shape change ripples through web views.** `SyncStatus.role`/`.shareKey`
   moved to `SyncStatus.folder.role`/`.folder.shareKey`. The web machines/views that read
   `status.role` fail typecheck after such a change — remember to grep `\.role`/`\.shareKey`
   usages in `apps/web/src` when changing the status shape.

## Integration seams (web ↔ backend)

7. **`FolderSummary.pending` must be BOTH set in the backend record AND surfaced in
   `toSummary()`.** The shared type added `pending?`, and the web toasts "request sent vs
   you're in" off `status.folder.pending`, but the backend never set it — the flag silently
   never fired. When adding a field that the web branch behaviour off, verify the backend
   actually populates it end-to-end (record → summary → push).

8. **`remember` to refresh the request inbox on pushes + state turnover.** Requests arrive via
   `photos.changed`; the web must call `requests.refresh()` on push AND on join/respond state
   transitions, or the Requests tab goes stale.
