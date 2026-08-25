# justus sync-core seam — SynchronizerPort v2 (hyperdrive-file) design

> Status: proposal (v1). Addresses issue #19.
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

| #19 criterion                                                                                           | State      | Evidence                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per‑key open (open a specific drive by key)                                                             | **[has]**  | `openDriveWithTopic(keyHex)` opens `makeDrive(corestore, Buffer.from(keyHex,"hex"))` and joins its discoveryKey topic before `ready()`.                                                                                                                                                                                                                             |
| Sparse mirrors (open mirrors sparse)                                                                    | **[has]**  | `makeDrive` caches by canonical key per `corestore`; `refreshMembersFor` opens only enrolled member drives.                                                                                                                                                                                                                                                         |
| Batch‑metadata list (list a drive's photos with batch metadata, never per‑entry RTT)                    | **[gap]**  | `drive.list(DRIVE_PATH_PHOTOS)` is called, but the **fake** `list()` yields `{key,name}` with **no `.value.metadata`**; `deriveGallery` reads `entry.value.metadata` (`gallery-order.ts:111`), so under the fake, name/mime/sha256 fall back to derived defaults. The _real_ hyperdrive yields metadata; the harness cannot exercise the batch‑metadata path today. |
| Range read (serve file bytes)                                                                           | **[has]**  | `spoolToFile` calls `drive.createReadStream(drivePath)` and pumps to the loopback‑mounted spool file; loopback `mount(mount, spoolPath)` serves bytes.                                                                                                                                                                                                              |
| Put‑with‑metadata                                                                                       | **[gap]**  | `seedSamplePhotos` and `addFromPath` call `drive.put(path, bytes, { metadata })`, but the **fake** `put(path, data)` is **2‑arg and silently drops the metadata object**. No unit test covers metadata round‑trip.                                                                                                                                                  |
| Per‑topic peers (a peer carries its topic, so a folder knows which member drive a connection satisfies) | **[has]**  | `swarm.join(topic)` keyed by discoveryKey; `rt.social.peers` records `remotePublicKey` per creator folder; `loadMemberDrive` opens member drives by registry key.                                                                                                                                                                                                   |
| Manifest / Hyperblobs / blob‑server removed                                                             | **[has]**  | No source references; drives carry plain `/photos/<id>.<ext>` entries + JSON sidecars (`members.json`, `removed.json`, `folder.json`, `requests.json`).                                                                                                                                                                                                             |
| Fake port parity (incl. scripted drop / timeout / partial‑replication)                                  | **[gap]**  | `FakeDrive` has `unreachable` + `readyDelayMs` (covers drop/timeout) but **no partial‑replication scenario** (a drive that has some, but not all, blocks yet) and **no metadata** (see above).                                                                                                                                                                      |
| Sync‑core unit suite green on the new seam                                                              | **[has]**  | `apps/backend/test/photo-store.*.test.ts` (84 backend cases) run against the fake; green on `main` (`9992c2d`).                                                                                                                                                                                                                                                     |
| Real‑stack two‑peer integration test green on the new seam                                              | **⚠ open** | The e2e hub stack (`e2e/hub` + `e2e/p2p`, PRs #145/#147/#148) can boot a DHT + N worklets, but does **not yet assert that a photo `add`ed on peer A becomes visible on peer B through the real swarm**. This is the natural home for the re‑booted test.                                                                                                            |

## 2. The two real gaps

### Gap A — fake‑port metadata fidelity

`FakeDrive.put(path, data)` ignores the third `{ metadata }` argument, and
`FakeDrive.list()` returns `{key, name}` instead of
`{ key, value: { metadata: { name, mime, addedAt, sha256 } } }` (the shape
`deriveGallery` consumes). Consequence: the unit suite cannot prove the
put‑with‑metadata / batch‑metadata‑list criteria; gallery names collapse to the
derived `base` fallback under the fake.

Fix (small, contained):

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

1. **This doc (proposal)** → human approves direction.
2. **Gap A** as its own PR: `FakeDrive` metadata fidelity + 2–3 unit cases.
   Reviewable, green in the backend suite, no production code touched.
3. **Gap B** as a follow‑up PR building on the e2e hub stack, gated to run in CI
   (not locally here).

#20 (core flow) is **independent** of these gaps — it can proceed once Gap A is
in, because the unit harness will then faithfully model metadata.

## 4. Open questions (need human / product decision)

1. **Scope of #19 today.** Given the v2 seam already landed, is the intent now
   just _Gap A + Gap B closure_ (this doc), or is there a deeper reshaping the
   issue still implies that the current `Drive` seam does not cover? Confirm
   before spending a large implementation.
2. **Partial‑replication semantics.** What should `listPhotosIn` show for a
   partially‑replicated member drive — everything present so far, or wait for
   full sync? Affects both Gap A's fake scenario and Gap B.
3. **CI for Gap B.** The two‑peer test needs a runnable p2p environment (local
   DHT + worklets). Where does it run? (The sandbox here cannot boot Playwright
   browsers / real peers.)
