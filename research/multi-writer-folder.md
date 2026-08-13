# Multi-writer folder on hyperdrive — architecture resolution

Verified against: **hyperdrive v13.3.3** (current, `main`; source read directly), **hyperdrive v10.18.0** (mount-era README), **corestore v7.11/7.12**, **hyperswarm v4.17**, **autobase v7.28**, and the official Pear how-to references (`pear-file-sharing`, `pear-photo-backup`).

## Answer summary

- **The mount-based group pattern is a hyperdrive v10 feature and does not exist in current hyperdrive.** The v13 source (`index.js`) and the v13.3.3 API docs expose no `mount`/`getMount`/`unmount`; mounts were introduced in v10 (2020) and removed in the modern rewrite. The "folder drive mounts member drives" shape cannot be implemented on v13 as described.
- The official modern replacement for the group pattern is the `pear-file-sharing` reference: **each member owns one hyperdrive; an Autobase view stores the set of member drive keys; peers replicate every member drive directly and mirror them into a shared local folder.** This is the pattern to build on.
- **Gallery index for v1: derive on demand** by enumerating member drives (via the registry) and listing/filtering each drive. No shared index file, no creator dependency, no write conflicts. Per-file photo metadata rides in hyperdrive's `metadata` option on `put`.
- **Membership record:** the member list is the Autobase view (member drive key → `{ name, … }`); the share key/invite is the Autobase bootstrap key. Readers discover the member list by reading the view. Device name/provenance goes in the registry record or a per-member drive file.
- **Replication:** each member drive is replicated separately — peers join the swarm on _each_ drive's `discoveryKey` and open it by key. All drives of an app share one Corestore, so one `store.replicate(conn)` per connection serves them all, but keys are never exchanged by Corestore; they must come from the registry. Creator offline has no effect on a member's new photos.
- **Autobase verdict:** not needed for gallery content or a per-member/derived index. It is needed only for concurrent writes to shared folder metadata — here, the **membership registry** (members adding their own drive key without the creator online). Recommend Autobase for the registry only, mirroring the official reference; defer it only if v1 accepts creator-mediated enrollment.

---

## 1. Folder shape & mounts

### Current hyperdrive (v13) has no mounts

hyperdrive v13.3.3 (`holepunchto/hyperdrive`, depends on hyperbee ^2.11, hyperblobs ^2.9, hypercore ^11) has **no mount API**. The full `index.js` source contains no `mount`, `getMount`, `unmount`, or mount-traversal logic; its API is `put/get/entry/exists/del/compare/clear/symlink/batch/list/readdir/entries/mirror/watch/diff/download/checkout/replicate/update` plus blob accessors. https://github.com/holepunchto/hyperdrive/blob/main/index.js ; version: https://raw.githubusercontent.com/holepunchto/hyperdrive/main/package.json ; API surface: https://docs.pears.com/reference/building-blocks/hyperdrive/ (documented against `v13.3.3`).

Mounts were a **v10** feature ("The two largest things we'd like to introduce are mounts … and the Hyperdrive daemon"): https://blog.hypercore-protocol.org/posts/announcing-hyperdrive-10/ . The v10.18.0 README documents `drive.mount(name, key, [opts])` (with a `version` option for a pinned checkout), `drive.unmount(name)`, `drive.info(name)` (returns `{ feed, mountPath, mountInfo }`), `drive.createMountStream(opts)`, and `drive.getAllMounts(opts)`; `readdir` recurses into mounts via `{ recursive: true, noMounts: false }`; and "If you have many nested Hyperdrives mounted within a parent drive, `replicate` will sync all children as well." https://raw.githubusercontent.com/holepunchto/hyperdrive/v10.18.0/README.md

### Mount mechanics (v10, for completeness / if pinning to hyperdrive@10)

- A mount is a record in the **parent drive's metadata** written via `drive.mount(path, key, opts)`; only the parent drive's writer — the creator — can create mount entries. The v10 group pattern is: "a 'group owner' first creates a top-level group drive, then mounts 'user profiles' within the group" (`/my-group/user-a`, `/user-b`, …), aggregating content with a recursive `readdir` over the group. https://blog.hypercore-protocol.org/posts/announcing-hyperdrive-10/ . The same "groupware" idea ("each user mounts their own drive inside a single shared one, then applications render multi-user views over the group drive") is the protocol-site write-up: https://hypercore-protocol.github.io/new-website/protocol/
- Mounted drives' contents appear in the parent's `readdir`/`list` (recursive listing descends into mounts), and reads resolve across the mount, so `drive.get('/members/alice/photo.jpg')` traverses the mountpoint transparently. This is documented v10 behavior, not verified against v13 source (v13 has no such code path). https://raw.githubusercontent.com/holepunchto/hyperdrive/v10.18.0/README.md

### The modern equivalent (v13)

Because v13 has no mounts, the official reference `pear-file-sharing` implements groupware without them: **each peer owns one Hyperdrive; an Autobase view holds the set of drive keys; each peer mirrors every other peer's drive into a local `shared-drives` folder.** https://docs.pears.com/how-to/stream-and-share-media/share-files-in-a-peer-to-peer-app/

**For Justus:** the "folder = creator's drive with member drives mounted inside it" shape is not available on current hyperdrive. Adopt the reference shape: _folder = an Autobase (the folder record / member registry) + one single-writer hyperdrive per member._ The share key is the Autobase bootstrap key; there is no single "folder drive" that contains member content.

---

## 2. Gallery index

Options, under the chosen (no-mounts) architecture:

**(a) Creator-written index in a folder drive.** Only the creator can write their drive (v13 is single-writer), so when any member adds a photo the index is stale until the creator comes online, re-reads every member drive, and rewrites it. It is a single point of failure for the gallery and turns the creator into a mandatory online hub. Rejected.

**(b) Per-member index files in each member drive.** Each member writes only their own index (e.g. `/index.json`) in their own drive — strictly single-writer, so two members writing their own indexes can never conflict. Readers still must aggregate across drives, and each drive then has two sources of truth (index file + photo entries) that can drift. Better than (a) but an unnecessary write path in v1.

**(c) Derived on demand.** The gallery is produced by enumerating member drives from the registry, running `drive.list('/')` (or `readdir`) on each, and filtering photo entries. No index to maintain, no staleness, no conflict semantics, and no dependence on any particular member being online. hyperdrive's `list`/`readdir` are Hyperbee range scans (https://docs.pears.com/reference/building-blocks/hyperdrive/), cheap enough to run per view.

**Recommendation for v1: (c) derived on demand.** Carry photo provenance (captured-at, source member, mime, thumbnail blob id) in hyperdrive's per-entry `metadata` option — `drive.put(path, buf, { metadata })` / `createWriteStream(path, { metadata })` stores arbitrary JSON per file (https://docs.pears.com/reference/building-blocks/hyperdrive/ , `WriteOptions.metadata`). That gives every photo its metadata at the source with zero index write path; a (b)-style cache index can be layered on later if enumeration ever becomes a bottleneck.

---

## 3. Membership record

- **Registry in the modern pattern is the Autobase view** mapping each member's drive key to a name: the reference calls `addDrive(key, { name })`; "the Autobase view stores just the set of drive keys (`@pear-file-sharing/drives`)." https://docs.pears.com/how-to/stream-and-share-media/share-files-in-a-peer-to-peer-app/ . Autobase is the multi-writer primitive for exactly this: every member appends their own drive key, and the deterministic view materializes the member list (autobase `open`/`apply` build a Hyperbee view; https://docs.pears.com/reference/building-blocks/autobase/).
- **Reader discovers the member list by reading the view.** A new member gets the Autobase bootstrap key (the share key / invite); from it the base's system + writer cores replicate and `apply` materializes the view; the member list (drive keys + names) falls out of the view. This is the documented replacement for "readdir the creator's `/members/` folder" in a mount world.
- **Device-name / provenance:** store it in the registry record (`{ name }` as in the reference), and/or write a per-member drive metadata file (a regular `drive.put('/device.json', …)` or per-entry `metadata`) so provenance travels with the drive even if the registry is lost.
- **Fallback without Autobase:** a creator-written registry file in a creator-owned drive works only while the creator is online and is a single-writer bottleneck — acceptable only if enrollment is strictly creator-mediated (see §5).

---

## 4. Replication

- **The folder's `discoveryKey` is the swarm topic** for the share unit (`drive.discoveryKey` / `base.discoveryKey`); in the v13 architecture that topic belongs to the **Autobase** (bootstrap + system core), and every member drive additionally gets its own swarm topic. Hyperswarm connects peers by 32-byte topic: https://docs.pears.com/reference/building-blocks/hyperswarm/
- **Replicating a "folder drive" does not pull member drives in v13** (v10 mounts auto-synced children over the parent's replication stream; v13 has no such mechanism). Each member drive is replicated **separately**: the reference joins the swarm on each drive's `discoveryKey` and mirrors it (`swarm.join(drive.discoveryKey)` per known drive). https://docs.pears.com/how-to/stream-and-share-media/share-files-in-a-peer-to-peer-app/
- **Corestore co-replication:** one Corestore per app; `store.replicate(conn)` on every connection replicates **every loaded core over a single stream** — "Only `core1`'s discovery key is announced … `core2` and `core3` ride along because `store.replicate(conn)` replicates every loaded core over a single stream." Crucially, "**Corestore does not exchange keys (read capabilities) during replication**" — a peer must already know a drive's key to open it, and opening it (`store.get({ key })`) triggers the fetch over any existing connection. https://docs.pears.com/how-to/store-and-replicate/work-with-many-hypercores-using-corestore/ , https://docs.pears.com/reference/helpers/corestore/
- **Which keys a new member needs:** (1) the folder share key (Autobase bootstrap key) to reach the registry, then (2) each member drive key (a read capability) to open and replicate that drive — the drive keys arrive through the registry, not the network protocol.
- **Creator offline:** irrelevant to a member's new photos. New photos live in the member's own drive; any online member that has replicated that drive (or a blind peer holding it) serves them. The member's own node must announce its drive (see seeding). Availability of _new_ content is gated by _a holder of that drive_ being online — the creator is never required. https://docs.pears.com/how-to/stream-and-share-media/share-files-in-a-peer-to-peer-app/
- **Seeding roles:** Hyperswarm `join(topic)` defaults to `server: true, client: true` (announce + accept inbound) — https://docs.pears.com/reference/building-blocks/hyperswarm/ . The writer/reader examples show writers relying on the default and readers joining as `{ client: true, server: false }`. So: **every member should run `server: true` on their own drive's topic (and can re-announce the others'), readers may be client-only.** For always-on availability when no member is online, the documented mechanism is **blind peering** (register member drives/cores with an always-on blind peer via `BlindPeering.addCore`): https://docs.pears.com/how-to/blind-peering/keep-data-available-with-blind-peering/ , https://docs.pears.com/explanation/availability-and-blind-peering/

---

## 5. Autobase verdict

- **Not needed for the gallery.** With per-member single-writer drives and a derived gallery (or per-member index), concurrent writes to shared data never occur — the two-member-same-index conflict scenario only arises with a shared index, which we rejected. Autobase buys nothing here.
- **Needed only for concurrent writes to the one genuinely shared, concurrently-written piece of folder metadata: the membership registry** (each member appends their own drive key; enrollment without the creator online). The official multi-user reference uses Autobase for exactly this job. https://docs.pears.com/how-to/stream-and-share-media/share-files-in-a-peer-to-peer-app/ , https://docs.pears.com/reference/building-blocks/autobase/
- **Recommendation:** include Autobase for v1 **as the folder's membership/registry record only** — not for photo data, not for a gallery index. This is the documented reference architecture and the only piece of the stack that is genuinely multi-writer. If v1 is willing to make enrollment strictly creator-mediated (creator must be online to add a member; single-writer registry), Autobase can be dropped from the v1 cut — but then "every member can add photos" still works (their own drive), while "members can join" does not without the creator. Given the folder is defined as every-member-writable and the share key grants access, keeping Autobase as the registry is the lower-risk choice.

---

## Gaps / open questions

- **v10 mount traversal specifics** (exact readdir/get semantics across a mount, and whether parent replication reliably pulls child feeds for peers with sparse metadata) were taken from the v10 README and blog, not from a running v10 test. If pinning to hyperdrive@10 is ever reconsidered, verify with the v10 test suite before committing.
- **`hyperdrive@10` is unmaintained relative to the current stack** (v13 is on hyperbee/hyperblobs/hypercore@11 with manifest-derived content keys); the cost/benefit of resurrecting mounts for v1 was not assessed beyond noting the feature's absence.
- **HyperDispatch (the reference's Autobase wrapper) internals** were not inspected; the registry details (`@pear-file-sharing/drives` view shape, invite/`addDrive` flow) are cited from the docs walkthrough only.
- **Name collisions across member drives** in a derived gallery: the app must namespace photos by member (e.g. `memberKey/photoName`) in its own key space since each member drive is independent; hyperdrive itself gives no cross-drive guarantee.
- **Blob-level dedup across members** (hyperblobs `dedup` option on `createWriteStream`) and cross-device availability of photos mirrored onto other members' machines are open tuning questions, not architecture blockers.
