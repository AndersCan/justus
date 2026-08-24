# justus — Fake-drive test harness (design)

> Status: proposal (v1). Grounded in `apps/backend/src/photo-store.ts` (its
> `Drive` usage and the six drive-dependent bugs #42, #43, #46, #47, #49, #52),
> the already-tested backend primitives (`pump.ts`, `gallery-order.ts`,
> `mime.ts`), and the existing `apps/backend/src/*.test.ts` vitest suites.
> Markings: **[has]** exists · **[add]** new · **⚠ open** needs decision.

## 1. Why this is needed

The six remaining sweep bugs are **state-machine logic** inside `photo-store.ts`,
not I/O quirks. Each is deterministically reproducible from a sequence of
`createPhotoStore` calls + `join`/`createFolder`/`add`/`setActive`/`respond`
invocations:

- **#42** — second+ creator folder downgrades to `reader` after restart.
- **#43** — content dedupe defeated when a member drive is unreachable at add time.
- **#46** — `setActive` leaves stale `drive.on("update")` watchers; `onChanged` fires for inactive folders; `watchers` Set leaks.
- **#47** — `join()` mints a duplicate `FolderRecord` for an already-joined `shareKey`.
- **#49** — member add of duplicate-content bytes adopts another member's entry (unremovable).
- **#52** — approved join never upgrades the requester's `reader`→`member` role in-session.

Today none of these can be unit-tested in vitest, for two reasons:

1. **No dependency-injection seam.** `createPhotoStore` constructs
   `new Corestore(...)`, `new Hyperswarm(...)`, and `new Hyperdrive(corestore, key?)`
   internally (photo-store.ts:271, 272, 389, 874, 1211). There is no way to
   substitute an in-memory drive.
2. **Bare globals absent in Node.** `photo-store.ts` imports `bare-fs`,
   `bare-path`, `bare-crypto` at module top; loading it under Node vitest throws
   `Bare is not defined`.

A fake-drive harness + a small DI seam makes all six deterministic,
fast, and mutation-testable — directly serving the project's testability
objective. This document is the **pre-work / design**; implementation lands in a
follow-up PR (see §4 for the ordering constraint).

## 2. Current `Drive` surface (extracted from source)

`photo-store.ts` treats a drive as an opaque `any` but uses a small, stable
subset of the Hyperdrive API. The fake must implement exactly this surface:

| Member                         | Kind                                       | Used at (examples)                                       |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| `.key`                         | `Buffer` (prop)                            | `ownDrive.key` (×9), `folderDrive.key` (×7)              |
| `.discoveryKey`                | `Buffer` (prop)                            | `drive.discoveryKey`, `ownDrive.discoveryKey` (×3)       |
| `.ready()`                     | `() => Promise<void>`                      | `drive.ready()` (×3), `ownDrive.ready()`                 |
| `.get(path)`                   | `(string) => Promise<Buffer \| null>`      | `getText` at :331                                        |
| `.put(path, data, opts?)`      | `(string, Buffer, opts?) => Promise<void>` | `folderDrive.put` (×5), `ownDrive.put` (×3), `drive.put` |
| `.list(path)`                  | `(string) => Promise<Entry[]>`             | `drive.list(DRIVE_PATH_PHOTOS)` (:464, :573, :637)       |
| `.del(path)`                   | `(string) => Promise<void>`                | `selfDrive.del`                                          |
| `.on("update", h)`             | EventEmitter                               | `watchDrive` :370                                        |
| `.removeListener("update", h)` | EventEmitter                               | (teardown, currently unused)                             |
| `.createReadStream(path)`      | `(string) => Readable`                     | spool download path                                      |
| `.close()`                     | `() => Promise<void>`                      | `drive.close`                                            |

Supporting constructs that also need fakes:

- **`Corestore`** — `new Corestore(dir)`, `.ready()`, `.replicate(conn)`,
  `.close()`; passed into `new Hyperdrive(corestore, key?)`.
- **`Hyperswarm`** — `new Hyperswarm({ bootstrap? })`, `.join(topic, opts)`,
  `.on("connection", conn => ...)`, `.connections`, `.destroy()`.
- **`LoopbackServer`** (from `@ekrooh/bare/runtime`) — `.mount(route, path)`,
  `.unmount(route)`, `.origin()`.

## 3. Target design

### 3.1 In-memory `FakeDrive` — **[add]** `apps/backend/test/fake-drive.ts`

A class implementing the §2 surface over a `Map<string, Buffer>`. Key details:

- `.key` / `.discoveryKey`: derive deterministic `Buffer`s from a constructor
  seed (e.g. `sha256(seed)` truncated) so two fakes with the same seed share an
  identity — required for #42/#43/#47 scenarios where the device's own key must
  equal a folder's `shareKey`.
- `.list(path)` returns entries whose key starts with `path` (drive-style
  recursive listing).
- `.on("update", h)` / `.removeListener(...)`: a minimal emitter. A
  `fakeDrive.emitUpdate()` test helper fires handlers so #46 watcher tests can
  simulate replication writes.
- `createReadStream` / `close`: trivial no-ops returning a closed/empty stream
  and a resolved promise respectively (no real bytes needed for the six bugs).

### 3.2 `FakeSwarm` + `FakeLoopbackServer` — **[add]** same module

- `FakeSwarm`: `join()`/`on("connection")`/`connections`/`destroy()` no-ops;
  `connections.size === 0` (no peers) by default, with a constructor flag to
  simulate reachability for #43.
- `FakeLoopbackServer`: `mount`/`unmount` record routes in a `Map`; `origin()`
  returns `http://localhost:0` (the URLs produced are only asserted for shape,
  not fetched, in these tests).

### 3.3 Dependency-injection seam — **[add]** in `createPhotoStore`

Extend `PhotoStoreDeps` (photo-store.ts:109) with optional factory overrides,
defaulting to the real constructors so production behavior is unchanged:

```ts
makeDrive?: (corestore: unknown, key?: Buffer) => Drive;
makeCorestore?: (dir: string) => unknown;
makeSwarm?: (opts?: { bootstrap?: string[] }) => unknown;
makeServer?: () => LoopbackServer;
```

Internally, `createPhotoStore` swaps `new Corestore(...)` →
`deps.makeCorestore?.(dir) ?? new Corestore(...)`, etc. Tests pass fakes; the
app passes nothing. **No production code path changes behavior.**

### 3.4 Bare-global shim for vitest — **[add]** `apps/backend/vitest.setup.ts`

`photo-store.ts` imports `bare-fs` / `bare-path` / `bare-crypto` at the top.
Under Node these resolve to packages that read a `Bare` global at load time.
The setup file (referenced by `vitest.config.ts` `setupFiles`) does one of:

- **preferred:** `vi.mock("bare-fs", ...)` / `vi.mock("bare-path", ...)` /
  `vi.mock("bare-crypto", ...)` providing the handful of functions
  `photo-store.ts` actually calls (`fs.rmSync`, `path.join`, `crypto.randomBytes`,
  `crypto.createHash`, `Buffer.from`), so the module loads in Node; **or**
- a `globalThis.Bare` stub if the packages only guard on the global's presence.

Only the functions actually used need real implementations; the rest can throw
"not implemented in fake harness" to catch accidental real-I/O.

### 3.5 Test scenarios — **[add]** `apps/backend/test/photo-store.fake.test.ts`

One suite per bug, each building a `PhotoStore` from fakes and asserting the
**fixed** behavior (written alongside the fix in the follow-up implementation
PR, so the test initially documents the expected contract):

| Bug | Harness scenario                                                                                                                                  | Assertion (post-fix)                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| #42 | Build device, `createFolder("Holidays")` (own key ≠ identity key), `add` ok, then **re-`createPhotoStore` from the same `storageDir`** with fakes | `folders()` reports the 2nd folder as `creator`; `add` on it still succeeds                 |
| #43 | Folder with reachable member drive holding sha `S`; set `FakeSwarm` to mark that member **unreachable**; `addBytes` same `S`                      | not written twice; dedupe consults a local content index, not the live scan                 |
| #46 | `createFolder(A)`, `createFolder(B)`, `setActive(B.id)`, `fakeDrive(A).emitUpdate()`                                                              | `onChanged` is **not** called with `folderId: A`; `watchers` drained on `setActive`/`close` |
| #47 | `join(sameKey)` twice                                                                                                                             | `folders().length` unchanged; second call idempotent (returns existing status)              |
| #49 | Member A adds sha `S`; member B `addBytes(S)`; B `remove(returned.id)`                                                                            | B's own drive gets a copy (or remove resolves); returned entry is B-owned/removable         |
| #52 | Member B `join` (pending), creator `respond` approves, simulate `photos.changed` for B's folder                                                   | B's `role` flips `reader`→`member`, `pending: false`, `add` now succeeds in-session         |

## 4. Ordering constraint — **⚠ important**

This harness edits `photo-store.ts` (the DI seam in `createPhotoStore`) and adds
`vitest.setup.ts`. The **nine pending PRs (#58–#66)** also edit
`photo-store.ts` / `gallery-order.ts` / `apps/web/package.json` / the pnpm
files. To avoid rebase churn, **implement §3 after those nine PRs merge**,
branching from the post-merge `main` tip (rebase the gallery cluster first per
the merge-order note, then this work on top). This spec is the standalone
pre-work and merges independently (new file only).

## 5. Open questions

- **Content index for #43/#49:** should dedupe move to a lightweight
  `sha256 → driveKey:id` index maintained on add/remove (recommended, O(1),
  reachability-independent), or simply restrict to the caller's own drive? The
  index approach also fixes the O(N) re-scan cost noted in #43.
- **Role re-derivation trigger for #52:** re-read the registry on
  `photos.changed` for joined folders (cheap, already have `readRegistryIn`),
  vs. re-running `setup()` for that folder. Prefer the targeted re-read.
- **`FakeDrive` byte fidelity:** the six bugs need no real bytes, but future
  tests (upload/spool) will. Defer stream fidelity to a later harness revision.
