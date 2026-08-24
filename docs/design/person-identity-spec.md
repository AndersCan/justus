# justus design spec — Person identity (one human, many devices)

> Status: proposal (v1). Grounded in issue **#31** (Person identity) and the
> vocabulary in `CONTEXT.md`; reads the current model from
> `packages/core/src/photos/types.ts` and `apps/backend/src/photo-store.ts`
> (the `device.json` / `readDeviceName` identity drive). Follow-up of the
> roadmap landscape note (`memory/reports/justus-roadmap-landscape-2026-08-24.md`,
> item #31 first). **[has]** exists today · **[add]** new · **⚠ open** needs decision.
>
> Dependency note: #31 is **blocked by** #17 (mantaq core 0.3.0 / sugar 0.4.0)
> and by the **grant ledger + share surface + signed receipts** (#30 / #25).
> This spec defines the identity _model_ and the type/UI seams it opens; the
> actual crypto/receipt work lands with those tickets. It is safe to review and
> to start shaping types/UI against now.

## 1. The gap, in one paragraph

Today, per `CONTEXT.md`, a **Member is a device**: "A device enrolled in a
folder with its own drive it can add photos to." Every phone, tablet, and
replacement phone is a separate keypair and therefore a separate _member_ in
the share surface, presence roster, and photo provenance. A human with two
devices shows up as two members; a new phone they pair appears as a _stranger_
rather than as them. Issue #31 collapses those device identities under one
**Person** so the UI, presence, and feed speak about _people_, and a person's
new device joins the same person rather than a stranger.

Concretely, the current types are all keyed by **device** (`driveKey`), never
by a stable person:

- `SyncMember = { key, name }` — a member drive (device).
- `PhotoMember = { key, name }` — the member drive a photo lives in.
- `JoinRequest = { requesterKey, requesterName, … }` — a device asking to join.
- `FolderSummary.members` — a count of `memberDrives + 1`, i.e. device count.

None of these know that two `driveKey`s might be the _same human_.

## 2. The model

> Vocabulary: keep `CONTEXT.md` meanings. **Person** is a _new_ term that sits
> **above** Member: a Person owns one or more Member (device) identities.

- **Person** — a stable human identity. Identified by a long-lived `personId`
  (a keypair/identity generated once, _not_ the per-device drive key). A Person
  has a display `name` and a set of `deviceKeys` (their devices' drive keys).
- **Device** — what `CONTEXT.md` today calls a _Member_: one enrolled drive
  (`driveKey`) belonging to exactly one Person. Acquires an optional
  `deviceName` (e.g. "Maya's iPhone") to distinguish a Person's devices in
  presence.
- **Member (folder-scoped)** — a Device enrolled in a folder. The folder
  _registry_ maps `personId → deviceKeys[]` instead of bare `deviceKey`s, so a
  Person enrolled with two devices is **one member row**, not two.

### 2.1 Where the person id lives — `[add]`, backward-compatible

`device.json` currently holds `{ name }` and is read live by
`readDeviceName` (`photo-store.ts:436`). Extend it minimally:

```jsonc
// /device.json (identity drive)
{
  "name": "Maya", // Person display name (unchanged today)
  "personId": "p_…", // [add] stable human identity (new)
  "deviceName": "Maya's iPhone", // [add] per-device label (optional)
}
```

- **Single-device users** (today's 100% case) get `personId` set on first
  launch; one Person, one Device. Zero behavioral change.
- **New device joins the same Person** via the existing proximity/invite
  pairing flow, which carries `personId` (typing-free, per #31). The invite's
  signed receipt (lands with #30/#25) is the natural carrier.
- **Names stay live from the device file** (AC): `readDeviceName` already reads
  `device.json` on demand — extend it to prefer `personId`-scoped name, never a
  frozen snapshot.

### 2.2 Type changes — `[add]` to `packages/core/src/photos/types.ts`

```ts
export type PersonId = string; // [add] stable human identity

export type Role = "creator" | "member" | "reader";

export type PhotoMember = {
  personId: PersonId; // [add] the human, not just the device
  key: string; // device drive key (unchanged)
  name: string; // Person display name (unchanged, live)
  deviceName?: string; // [add] optional per-device label
};

export type SyncMember = {
  personId: PersonId; // [add]
  key: string; // a representative device drive key (unchanged)
  name: string;
  deviceName?: string; // [add]
  devices: { key: string; deviceName?: string; online: boolean }[]; // [add] aggregation
};

export type JoinRequest = {
  personId: PersonId; // [add]
  requesterKey: string;
  requesterName: string;
  folderId: string;
  folderName: string;
  shareKey: string;
  requestedAt: number;
};
```

`FolderSummary` is unchanged in shape (it is _this device's_ view: `role`,
`driveKey`, `members` count). The count semantics shift from _device count_ to
_member (person) count_ once the registry is person-keyed — but the field
stays a number, so the web layer needs no structural change, only correct
aggregation in `toSummary` (`photo-store.ts:1016`).

## 3. Presence & status aggregation — `[add]`

A Person's online/lastSeen status **aggregates across their devices** (AC).
Today `SyncStatus.peers` is a raw device count and `members` is a device list.
New behavior:

- `SyncStatus.members` becomes a **person** list; each `SyncMember.devices`
  carries per-device `online` so the UI can show "Maya · 2 devices · online".
- `peers` should reflect person-count _or_ device-count deliberately — **⚠ open**:
  which does the connection indicator ("direct · N peers") mean? Recommend
  **person count** for the human-facing indicator, with device detail available
  on the member row.
- Last-seen rolls up to the Person: `lastSeenAt = max(device lastSeenAt)`.

## 4. Receipts & pending-delivery states — `[add]` (AC)

#31 requires that deliver receipts for _terminal_ notices (removed / denied)
are delivered, and that **pending-delivery** is a first-class state. This pairs
with the grant-ledger work (#30) but the identity layer must model it:

- A terminal notice targeting a Person is considered _delivered_ only once a
  receipt from at least one of their online devices is seen; otherwise it sits
  in a `pendingDelivery` state (visible in the share surface as "sending…").
- Themselves are never "pending" — local state is immediately authoritative.

## 5. UI seams (coordinate with #25 / #30 share surface)

The share/presence surface must render **one person per human**:

| Today (device-scoped)            | After (person-scoped)                           |
| -------------------------------- | ----------------------------------------------- |
| Member row per device            | One row per Person, with device chips           |
| "2 members" = 2 devices          | "2 people" = 2 humans (devices shown on expand) |
| New paired phone = stranger      | New paired phone = same Person                  |
| Provenance "Maya's iPhone added" | "Maya added" (device optional)                  |

The `share-grant-spec.md` copy ("sharing ✓", "said no", "they keep the photos
they already have") stays unchanged in spirit — it simply binds to `personId`
instead of `driveKey`, so revoke/grant is per _person_, correct across all
their devices.

## 6. Migration

- **Existing single-device users:** on next launch, `ensureOwnDriveIdentity`
  (`photo-store.ts:450`) writes `personId` if absent. One Person, one Device.
  No UI change, no data migration risk.
- **Existing multi-device users:** each device already has its own
  `personId` until they re-pair via the person-carrying invite; until then they
  appear as separate people (status quo), then collapse to one on re-pair. No
  forced migration; the model tolerates mixed states.
- **Registry format:** creator registry gains `personId` on each entry; readers
  of old registries treat a missing `personId` as "this device is its own
  person" (identity = device). Additive, never a breaking rewrite.

## 7. Acceptance-criteria map (from #31)

| AC                                                                           | Where satisfied         |
| ---------------------------------------------------------------------------- | ----------------------- |
| Person id binds multiple device keys; one person per human in share/presence | §2, §5                  |
| New device joins as same person; status aggregates across devices            | §2.1, §3                |
| Names live from device file, never frozen snapshot                           | §2.1 (`readDeviceName`) |
| Terminal-notice receipts delivered → pending-delivery first-class            | §4                      |
| t1 + hub green for three-device-one-person scenario                          | test plan §8            |

## 8. Test plan (outline, not code this PR)

- **t1 (unit):** `toSummary` returns person count (not device count) when a
  registry has one Person with two `deviceKeys`; `SyncMember.devices`
  aggregates online flags; missing `personId` falls back to device-as-person.
- **hub (multi-tab):** three devices, _one_ `personId` — verify the share
  surface shows one person with 3 device chips, presence aggregates online
  across devices, and a 4th device paired via the person-carrying invite joins
  the same person rather than a new one.

## 9. Open questions

1. **`personId` source** — generate a fresh Bare identity keypair at first
   launch (stored in `device.json`), or derive from an existing root key?
   **⚠ recommend:** fresh keypair in the identity drive; pairing copies it
   (typing-free) via the invite receipt. Confirm against Ekrooh identity story.
2. **`peers` semantics** (§3) — person count vs device count for the
   connection indicator. **⚠ recommend person count.**
3. **Device rename UI** — where does a user label "Maya's iPhone" vs "Maya's
   iPad"? Settings, or inferred from platform? **⚠ open.**
4. **Cross-folder Person** — is `personId` global (same human in every folder
   they share) or per-folder? **⚠ recommend global** (one human, consistent
   identity everywhere); the registry stores it per folder but the id is stable.
