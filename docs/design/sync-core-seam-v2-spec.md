# justus sync-core seam — SynchronizerPort v2 (hyperdrive-file) design

> Status: Gap A merged (#150); Gap B ⚠ open (CI-gated). Addresses issue #19.
> Grounded in: `apps/backend/src/photo-store.ts` (DI seam + `Drive` handle),
> `apps/backend/test/fake-drive.ts` (in-memory substitute), the §3.5
> bug-stack (PRs #72–#100), and the e2e hub/p2p harness (PRs #145/#147/#148).
> Markings: **[has]** exists · **[gap]** exists but does not meet the
> criterion · **[add]** new · **⚠ open** needs decision.

## 0. Context — what already landed

Issue #19 was filed against the _pre‑DI_ sync architecture (a `SynchronizerPort`
returning `BlobRef`/`MediaRecord` over a manifest + Hyperblobs + blob‑server
core). That architecture has since been **retired**:

- `photo-store.ts` now depends on a `Drive` handle (the hyperdrive-file seam)
  injected through `PhotoStoreDeps` (`makeDrive`, `makeCorestore`, `makeSwarm`),
  so it loads under Node/vitest without the Bare runtime.
- The old `BlobRef` / `MediaRecord` / manifest / Hyperblobs / blob‑server types
  are gone from the source tree (grep finds no references).
- A folder is already modeled as a set of member hyperdrives: `FolderRuntime`
  holds `folderDrive`, `selfDrive`, and a `memberDrives: Map<key, Drive>`.

So #19 is **no longer a from‑scratch rework** — it is a _confirmation + gap‑closure_
exercise against the already‑present v2 seam. This document maps each acceptance
criterion to current reality and scopes the remaining work as small, bounded
changes (the harness first, then the real‑stack integration test).

## 1. Acceptance criteria — current state

| #19 criterion                                                                                           | State      | Evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per‑key open (open a specific drive by key)                                                             | **[has]**  | `openDriveWithTopic(keyHex)` opens `makeDrive(corestore, Buffer.from(keyHex,"hex"))` and joins its discoveryKey topic before `ready()`.                                                                                                                                                                                                                                                               |
| Sparse mirrors (open mirrors sparse)                                                                    | **[has]**  | `makeDrive` caches by canonical key per `corestore`; `refreshMembersFor` opens only enrolled member drives.                                                                                                                                                                                                                                                                                           |
| Batch‑metadata list (list a drive's photos with batch metadata, never per‑entry RTT)                    | **[has]**  | `drive.list(DRIVE_PATH_PHOTOS)` is consumed with `for await`; `FakeDrive.list()` now yields `{ key, value: { metadata } }` (`fake-drive.ts`), so `deriveGallery` reads `entry.value.metadata` (`gallery-order.ts:113`) for name/mime/sha256 — the fake faithfully models the real hyperdrive entry shape. Round-trip covered by `photo-store.poc.test.ts` + `photo-store.fake.test.ts` (merged #150). |
| Range read (serve file bytes)                                                                           | **[has]**  | `spoolToFile` calls `drive.createReadStream(drivePath)` and pumps to the loopback‑mounted spool file; loopback `mount(mount, spoolPath)` serves bytes.                                                                                                                                                                                                                                                |
| Put‑with‑metadata                                                                                       | **[has]**  | `seedSamplePhotos` and `addFromPath` call `drive.put(path, bytes, { metadata })`; `FakeDrive.put(path, data, { metadata })` stores `opts.metadata` and `list()` surfaces it as `value.metadata` (`fake-drive.ts`). `photo-store.poc.test.ts:61` asserts the readable `name` round-trips through the seam. Merged #150.                                                                                |
| Per‑topic peers (a peer carries its topic, so a folder knows which member drive a connection satisfies) | **[has]**  | `swarm.join(topic)` keyed by discoveryKey; `rt.social.peers` records `remotePublicKey` per creator folder; `loadMemberDrive` opens member drives by registry key.                                                                                                                                                                                                                                     |
| Manifest / Hyperblobs / blob‑server removed                                                             | **[has]**  | No source references; drives carry plain `/photos/<id>.<ext>` entries + JSON sidecars (`members.json`, `removed.json`, `folder.json`, `requests.json`).                                                                                                                                                                                                                                               |
| Fake port parity (incl. scripted drop / timeout / partial‑replication)                                  | **[has]**  | `FakeDrive` has `unreachable` + `readyDelayMs` (drop/timeout) and now round-trips `put`/`list` **metadata** (Gap A, #150). Remaining sub-gap: **no partial-replication scenario** (a drive that has some, but not all, blocks yet) — tracked under Gap B.                                                                                                                                             |
| Sync‑core unit suite green on the new seam                                                              | **[has]**  | `apps/backend/test/photo-store.*.test.ts` (98 backend cases) run against the fake; green on `main` (`e13532b`, post #150/#152).                                                                                                                                                                                                                                                                       |
| Real‑stack two‑peer integration test green on the new seam                                              | **⚠ open** | The e2e hub stack (`e2e/hub` + `e2e/p2p`, PRs #145/#147/#148) can boot a DHT + N worklets, but does **not yet assert that a photo `add`ed on peer A becomes visible on peer B through the real swarm**. This is the natural home for the re‑booted test.                                                                                                                                              |

## 2. The two real gaps

### Gap A — fake‑port metadata fidelity — **merged (#150)**

`FakeDrive.put(path, data)` now stores the third `{ metadata }` argument, and
`FakeDrive.list()` yields `{ key, value: { metadata } }` (the shape
`deriveGallery` consumes at `gallery-order.ts:113`). The unit suite now proves the
put-with-metadata / batch-metadata-list criteria; gallery names come from
`value.metadata` rather than the derived `base` fallback. Shipped as
`6bb2426` ("make FakeDrive carry put metadata through list", PR #150).

What landed (for the record):

1. `FakeDrive.put(path, data, opts?: { metadata?: ... })` — store `opts.metadata`
   alongside the bytes in `files`.
2. `FakeDrive.list(path)` — yield `{ key, value: { metadata } }`, matching the
   real hyperdrive entry shape (keep `name`/`key` for the existing tests that
   read them, but make `value.metadata` the source of truth).
3. Add unit cases in `photo-store.*.test.ts` asserting:
   - `addFromPath` writes metadata that `list()` round‑trips (name/mime/sha256);
   - a photo's gallery `name`/`mime` come from `value.metadata`, not the fallback.

Risk: low — `FakeDrive` is test‑only; the real `Drive` already provides the
shape. Watch for tests that assert the old `{key,name}` `list()` contract.

### Gap B — real‑stack two‑peer integration test

Re‑boot the integration test on the new seam using the existing e2e hub stack:

1. Extend `e2e/hub` orchestrator to spawn **two** justus backends (peer A =
   creator, peer B = member) sharing one local DHT.
2. Via `e2e/p2p` globalSetup, drive peer A to `add` a photo, then assert peer B's
   `list()` (or its served `/photos` URL) surfaces that photo — proving the
   hyperdrive‑by‑key + topic‑peer replication end‑to‑end.
3. Add a scripted **partial‑replication** scenario (Gap A's fake counterpart):
   a member drive that has announced but not finished replicating its blocks;
   assert `listPhotosIn` does not hang and shows what is present so far.

Risk: medium — needs the local DHT + two worklets to actually replicate, which
is environment‑sensitive (the prior wake noted Playwright browsers / p2p peers
are not runnable in this sandbox). **This slice must run in CI, not locally here.**

## 3. Recommended sequencing (small steps)

1. **This doc (proposal)** → human approved direction; Gap A shipped (#150).
2. **Gap A** — `FakeDrive` metadata fidelity + unit cases, **merged as #150**
   (`6bb2426`). Reviewable, green in the backend suite, no production code touched.
3. **Gap B** — real-stack two-peer integration test, building on the e2e hub
   stack, gated to run in CI (not locally here). See `justus-gap-b-next-step.md`.

#20 (core flow) is **independent** of these gaps — it can proceed now that Gap A has
landed (#150), because the unit harness faithfully models metadata.

## 4. Open questions (need human / product decision)

1. **Scope of #19 today.** Gap A (FakeDrive metadata parity) shipped (#150); the
   remaining item is Gap B (real-stack two-peer replication, CI-gated). Is the
   intent satisfied by Gap A + Gap B closure, or does the issue still imply a
   deeper reshaping the current `Drive` seam does not cover? Confirm before any
   larger implementation.
2. **Partial‑replication semantics.** What should `listPhotosIn` show for a
   partially‑replicated member drive — everything present so far, or wait for
   full sync? Affects both Gap A's fake scenario and Gap B.
3. **CI for Gap B.** The two‑peer test needs a runnable p2p environment (local
   DHT + worklets). Where does it run? (The sandbox here cannot boot Playwright
   browsers / real peers.)
