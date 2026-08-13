# Research: is hyperdrive the right v1 on-device store on Android?

Research ticket. Decision-oriented findings for the Justus photo-sharing app on
Android: storage is hyperdrive + corestore + hyperswarm running in a Bare worklet
(`bare-kit`) via native addons. Companion to
`../less-bare-android/research/p2p-folder-stack.md` — this file fills in the
Android/mobile-specific gaps (footprint, on-disk model, backgrounding, runtime
support).

Versions verified against (npm registry + tarballs, 2026-08-13): rocksdb-native
3.17.4, sodium-native 5.1.0, udx-native 1.21.0, hypercore-storage 3.2.1,
hyperdrive 13.3.3, corestore 7.12.0, bare-link 3.3.0, bare-runtime 1.31.0,
react-native-bare-kit 0.15.0. Pear docs page contents captured 2026-08-13.

## Answer summary

- **Yes — hyperdrive for v1 on Android.** It is the same stack Holepunch ships in
  production on Android: Keet (their chat app) runs the Bare-worklet +
  Hyperswarm + Corestore stack on Android 10+ (arm/arm64) via Play/APK, and Pear
  app bundles are themselves Hyperdrives.
- **Per-ABI addon weight is small.** The scary "168 MB" rocksdb-native tarball
  ships 13 host/ABI combos × 2 formats; only one ABI's `.bare` lands in your
  APK: arm64 addons total ≈ **9.4 MB** (rocksdb 8.4 MB + sodium 0.77 MB + udx
  0.28 MB). All three ship `.bare` prebuilds for `android-arm/arm64/ia32/x64`
  and link via `bare-link --preset android`.
- **Photos map cleanly onto the model.** A photo is a Hyperblob (64 KB blocks)
  in the drive's content core; sparse replication downloads only requested
  byte-ranges. On disk everything lives in one RocksDB DB per Corestore; photo
  blocks ≥4 KB go to RocksDB blob files (stored once), so the disk cost for a
  few hundred photos is ≈ photo bytes + small metadata overhead — the only
  duplication is your own spool-to-disk serving copy.
- **Backgrounding is the real constraint, and it's foreground-only.** Android
  Doze suspends network access entirely (UDP DHT sockets go dead) and a
  foreground service does _not_ exempt you from Doze. Hyperswarm presence must
  be foreground-only, driven by the bare-kit worklet suspend/resume lifecycle
  (`swarm.suspend()` / `store.suspend()` on `Bare.on('suspend')`).
- **Readers join without opening a port.** `swarm.join(drive.discoveryKey, { client: true, server: false })` is the documented reader pattern — no inbound
  socket needed; only the seeding writer needs `server: true`.
- **Runtime requirement satisfied.** `udx-native` needs `engines.bare >=1.17.4`
  (rocksdb/sodium `>=1.16.0`); current `bare-runtime` is 1.31.0. Addon linking
  ahead of time (not runtime loading) is mandatory on Android and is exactly what
  `bare-link --preset android` / `bare-pack --linked` do.
- **Main residual risk is RocksDB itself** (biggest `.bare`, RAM for block cache
  - memtables, no escape hatch — hypercore 11 is hard-coupled to it). Accept it
    for v1; a raw-file store would only trade these costs for losing p2p sync.

---

## 1. Footprint

### npm tarball sizes (registry `dist.unpackedSize`)

| package        | version | unpacked                | engines.bare | notes                                                |
| -------------- | ------- | ----------------------- | ------------ | ---------------------------------------------------- |
| rocksdb-native | 3.17.4  | 168,469,703 B (~168 MB) | >=1.16.0     | 13 host/ABI prebuilds × (.node + .bare) + C++ source |
| sodium-native  | 5.1.0   | 18,251,221 B (~18 MB)   | >=1.16.0     | same multi-ABI layout                                |
| udx-native     | 1.21.0  | 5,280,198 B (~5 MB)     | >=1.17.4     | same multi-ABI layout                                |

Sources: https://registry.npmjs.org (via `npm view … dist.unpackedSize`),
package engines:
https://www.npmjs.com/package/rocksdb-native,
https://www.npmjs.com/package/udx-native.

### Per-ABI `.bare` sizes (measured from tarballs)

| package               | android-arm | android-arm64 | android-x64 | android-ia32 |
| --------------------- | ----------- | ------------- | ----------- | ------------ |
| rocksdb-native 3.17.4 | 6.4 MB      | **8.4 MB**    | 8.6 MB      | 8.7 MB       |
| sodium-native 5.1.0   | 0.68 MB     | **0.77 MB**   | 0.85 MB     | 0.89 MB      |
| udx-native 1.21.0     | 0.20 MB     | **0.28 MB**   | 0.26 MB     | 0.25 MB      |

arm64 total ≈ **9.4 MB**. The tarballs contain `prebuilds/android-{arm,arm64,ia32,x64}/*.bare`
for all three (tar listing of
rocksdb-native-3.17.4.tgz, sodium-native-5.1.0.tgz, udx-native-1.21.0.tgz). The
`.node` copies are for Node hosts; bare-kit/Android only consumes `.bare`.
RocksDB is statically linked into the rocksdb-native `.bare` (no separate
`librocksdb.so` dependency). Gradle/AGP only packs the ABIs you declare, so the
168 MB tarball never materialises in the APK.

### Linking on Android

`bare-link` (3.3.0) is the "native addon linker for Bare"; it supports
`--preset <name>` (e.g. the repo's existing `bare-link --preset android`) and
`--host <host>`:
https://github.com/holepunchto/bare-link. Pear docs confirm mobile _requires_
linking native code ahead of time: `bare-pack --linked --host ios --out app.bundle.mjs app.js`
and, for React Native, linked addons land in
`node_modules/react-native-bare-kit/android/src/main/addons` — this is where
Bare looks at runtime (missing = `ADDON_NOT_FOUND`):
https://docs.pears.com/how-to/run-on-native/bundle-a-bare-app/,
https://docs.pears.com/how-to/troubleshooting/.

### Memory footprint

- hypercore 11 is **hard-coupled** to rocksdb-native — issue #739 "Issue running
  hypercore 11.x in browser": RocksDB is the storage engine, no lighter
  alternative in hypercore 11: https://github.com/holepunchto/hypercore/issues/739.
- `hypercore-storage` opens one RocksDB DB per Corestore at `<storage>/db` and
  enables **blob files for values ≥ 4 KB** (`enableBlobFiles: true,
minBlobSize: 4096, blobFileSize: 256 MB, GC on`), plus an 8 KB block-table
  size, bloom/ribbon filter, and a block cache
  (`createColumnFamily` in https://github.com/holepunchto/hypercore-storage/blob/main/index.js,
  verified against 3.2.1 source). No custom block-cache capacity is passed, so
  RocksDB defaults apply (`column-family.js` / `binding.cc` in rocksdb-native
  3.17.4); `maxWriteBufferNumber = 2` memtables.
- Hypercore keeps a tree-node cache (`xache` `maxSize: 8192`) per
  `hypercore-storage` instance (README, https://github.com/holepunchto/hypercore-storage).
- Bare-kit worklets run with a configurable heap `memoryLimit` (24 MiB in the
  official examples); the RocksDB block cache + memtables live outside that JS
  heap, in the addon's native memory
  (https://github.com/holepunchto/bare-kit).
- No open issues in rocksdb-native (issue creation is disabled on the repo, 0
  open): https://github.com/holepunchto/rocksdb-native/issues.

## 2. Storage model for photos

- A Hyperdrive is exactly two cores: a Hyperbee metadata index core + a
  Hyperblobs content core — file contents are Hyperblobs
  (https://docs.pears.com/explanation/from-logs-to-files/,
  https://docs.pears.com/how-to/stream-and-share-media/create-a-full-peer-to-peer-filesystem-with-hyperdrive/).
- Hyperblobs chunks large blobs at `blockSize` 64 KB (default), so a 5 MB photo
  is ~80 blocks in the content core
  (https://github.com/holepunchto/hyperblobs).
- **Sparse replication:** peers fetch only the blocks they need — `drive.createReadStream(path, { start, end })`
  pulls just that byte range; `mirror-drive`/`drive.diff` for incremental
  metadata; `core.sweep()`/mark-and-sweep for GC of unmarked blocks; `core.clear(start, end)`
  reclaims blocks (https://docs.pears.com/reference/building-blocks/hypercore/).
  Pear's own photo-backup how-to notes "Originals are downloaded lazily — only
  the thumbnails are pulled eagerly"
  (https://docs.pears.com/how-to/stream-and-share-media/back-up-photos-in-a-peer-to-peer-app/).
- **On-disk:** a Corestore is one RocksDB DB (single column family `corestore`)
  at `<storage>/db`; all cores share it, keyed by core/data pointers. Content
  blocks are values; ≥4 KB values go to RocksDB **blob files**, so a photo's
  bytes are written once and are _not_ rewritten by LSM compaction (blob GC at
  age cutoff 0.25 reclaims deleted blobs). Merkle tree nodes, bitfields, and
  Hyperbee entries are small SST keys (8 KB blocks, bloom filters).
  (https://github.com/holepunchto/hypercore-storage/blob/main/index.js — `createColumnFamily`)
- **Cost for a few hundred photos:** disk ≈ sum of photo bytes + a few percent
  metadata (bloom filters, block indexes, WAL) + RocksDB's transient write
  amplification while appending/compacting. Example: 500 photos × 5 MB ≈
  2.5 GB in the corestore. **No raw-file duplication** — photo bytes live once,
  as RocksDB blob values; the only copy is your spool-to-disk loopback-cache
  (already flagged in the framework note). `core.info()` exposes the per-core
  storage breakdown (`storage: { oplog, tree, blocks, bitfield }`)
  (https://docs.pears.com/reference/building-blocks/hypercore/).

## 3. Backgrounding

- **Doze** (device idle, screen off, unplugged, stationary) _suspends network
  access_ for all apps — including ones holding foreground services; jobs/syncs/
  alarms are deferred to brief maintenance windows
  (https://developer.android.com/training/monitoring-device-state/doze-standby).
  UDP DHT announcements and peer sockets go dark during Doze.
- **App Standby buckets** limit background network; an app running a _foreground
  service_ is kept "active" (not throttled by standby), but Play policy restricts
  apps from asking for the battery-exemption whitelist, and even the
  "unrestricted" setting does not change deep-Doze behaviour
  (https://developer.android.com/topic/performance/power/power-details,
  https://developer.android.com/training/monitoring-device-state/doze-standby).
- **Conclusion:** hyperswarm presence (DHT discovery + seeding) is
  **foreground-only** on Android in practice. There is no Android mechanism that
  keeps raw UDP sockets alive through deep Doze without either FCM-style
  push-wake or a user battery exemption.
- **Bare models this natively:** the worklet lifecycle
  (`worklet.suspend()` / `resume()`, `Bare.on('suspend' | 'resume')`) and the
  documented pattern `await swarm.suspend()` + `await store.suspend()` on
  suspend, `resume()` on wake. Skipping it → the OS force-kills the app with no
  warning when the loop won't go idle
  (https://docs.pears.com/how-to/run-on-native/handle-app-suspension/,
  https://github.com/holepunchto/bare-kit).
- **Reader join, no inbound port:** `swarm.join(drive.discoveryKey, { client: true, server: false })`
  is the documented reader pattern in the official Hyperdrive how-to — client
  joins announce to and dial from the DHT but don't listen; only the seeding
  writer needs `server: true`
  (https://docs.pears.com/how-to/stream-and-share-media/create-a-full-peer-to-peer-filesystem-with-hyperdrive/).
- udx-native is raw UDP (with TCP via libudx); one known issue is IPv6-bind
  fallout in some container/network setups (libudx #130) — worth testing on
  device because `socket.bind()` prefers IPv6 `::` and falls back to IPv4
  (https://github.com/holepunchto/libudx/issues/130,
  https://www.npmjs.com/package/udx-native).

## 4. Bare runtime specifics

- **Addons are supported on Android by Bare:** all three ship official
  `android-{arm,arm64,ia32,x64}` `.bare` prebuilds (verified inside the npm
  tarballs above) and declare `engines.bare`; udx-native requires
  `>=1.17.4`, rocksdb-native and sodium-native `>=1.16.0`. Current `bare-runtime`
  is **1.31.0**, so the research note's `engines.bare >=1.17.4` floor is
  satisfied (https://www.npmjs.com/package/udx-native,
  https://www.npmjs.com/package/rocksdb-native, npm registry metadata).
- **bare-kit** is Holepunch's supported Android/iOS embedding (Java `Worklet`
  API with `start/suspend(suspend(linger))/resume/terminate`, worklets run as
  threads inside the host process)
  (https://github.com/holepunchto/bare-kit,
  https://docs.pears.com/reference/bare/bare-kit/).
- Official Android example repo: `holepunchto/bare-android` — embeds a Bare
  worklet and links addons into `app/src/main/addons`
  (https://github.com/holepunchto/bare-android).
- **Production precedent — Keet:** Holepunch's own P2P chat runs the same stack
  (Bare worklet, Hyperswarm/HyperDHT, Corestore) on Android 10+ `arm`/`arm64`
  (Play Store + APK on their site); Pear docs describe this as "Keet's identical
  behaviour on phones, laptops, and terminals — one core, several UIs"
  (https://support.keet.io/installation-and-setup/installation/,
  https://docs.pears.com/explanation/bare-on-native/,
  https://docs.pears.com/explanation/runtime-and-languages/). Caveat: Keet's
  file transfer predates Hyperdrive v10 and uses hypercore/hyperblobs; the
  _bundle_ shipping of Pear apps and the swarm/corestore plumbing are
  hyperdrive-capable. Keet still proves the runtime + network + storage addon
  set on Android in the wild.
- Community proof of hyperdrive specifically on Android: RangerMauve's
  **agregore-hyper-daemon-android** runs hyperdrive + hyperswarm inside a
  bare-kit worklet; its docs warn that _emulated_ devices crash
  (https://github.com/holepunchto/libjs/issues/4) — build/test on a real device.
  PearBrowser, a community mobile P2P browser, also lists sodium/udx/rocksdb
  among its linked addons (third-party, less authoritative).
  (https://github.com/RangerMauve/agregore-hyper-daemon-android)
- `react-native-bare-kit` 0.15.0 (npm) is the RN/Expo path with the same addon
  dirs (https://github.com/holepunchto/react-native-bare-kit,
  https://docs.pears.com/how-to/run-on-native/embed-bare-in-react-native/).
- No Android-specific open issues found in rocksdb-native (0 open; issue
  creation disabled) or udx-native (open issues are protocol-level, e.g. IPv6
  bind #130); hypercore-storage has only 2 open issues (not Android-specific).

## 5. Verdict

**Proceed with hyperdrive for v1 on Android.**

- It is the mobile-proven, vendor-first stack: Keet ships it on Android today,
  Pear distributes its apps as Hyperdrives, and the addons have official
  `android-*` `.bare` prebuilds with satisfied `engines.bare` floors.
- Footprint is acceptable: ~9.4 MB of addon per ABI (of which ~8.4 MB is
  unavoidable RocksDB), a few MB of JS, and RocksDB RAM in the block
  cache/memtables. The 168 MB tarball size is a red herring (multi-ABI).
- The photo workload is what Hyperdrive was built for: 64 KB blob blocks, sparse
  byte-range sync, one-key invites, reader-join with no open port.
- A "lighter store" wouldn't actually be lighter: any hypercore-11-based choice
  (raw hypercore, hyperblobs) pays the identical RocksDB cost, and a raw-file
  store (e.g. plain directory + a bespoke sync protocol) forfeits the
  incremental, verified p2p replication — the app's entire reason to exist.

### Practical mitigations for v1

1. **Foreground-only swarm.** Drive presence off the worklet lifecycle:
   `Bare.on('suspend', …)` → `swarm.suspend()` + `store.suspend()` (flush!), on
   `resume` → `store.resume()` + `swarm.resume()`. Never leave DHT sockets alive
   in background; the OS will kill the process. Consider a foreground service
   (user-visible, e.g. "sharing") only if you need seeding while the UI is not
   on screen — it stops App Standby throttling but does _not_ beat deep Doze.
   (https://docs.pears.com/how-to/run-on-native/handle-app-suspension/)
2. **Readers are client-only.** `swarm.join(discoveryKey, { client: true, server: false })`
   — no inbound port, Doze-hostile listening socket avoided; only the creator's
   seeding device opens a server socket.
3. **Spool-to-disk for the loopback WebView** (already in the framework note):
   `drive.createReadStream(path)` → `fs.createWriteStream` into writable storage,
   then mount the cache path. The download is a RocksDB copy; the spool is the
   only on-disk duplication. Prefetch thumbnails eagerly and originals lazily,
   mirroring Pear's photo-backup pattern, so the UI grid survives offline gaps.
4. **Watch RocksDB RAM/disk** on device during the pilot; if it hurts, tune the
   block cache via `hypercore-storage`/RocksDB options rather than switching
   stores (there's no lighter hypercore-11 storage).

## Gaps / open questions

- **No measured on-device numbers.** Sizes here are tarball/per-ABI statics;
  real APK delta, steady-state RocksDB RAM, and first-sync battery on a phone
  need an instrumented pilot (corestore + a few hundred photos on arm64).
- **Keet file-sync uses hypercore/hyperblobs, not hyperdrive** — worth checking
  `keet-mobile-releases` changelog/issues if you want a _same-shape_ production
  reference for hyperdrive-on-Android specifically.
- **udx-native dist-tag trap:** a community write-up notes npm `latest` lags the
  `next` line's API (README documents `changeRemote`/`relayTo`/`framed`);
  verify the exact version your lockfile resolves against 1.21.0 semantics.
- **hypercore-storage's 2 open issues** were not individually reviewed — worth a
  skim before freezing the version.
- **Emulator flakiness** (libjs #4) means Android testing should assume a real
  device; unclear how much of that is old bare-kit vs current.
