# justus UI/UX spec — Peer/connection screens

> Status: proposal (v1). Follow-up of `docs/design/ui-ux-spec.md` §4.2
> (PR #33). Grounded in: `apps/web/src/machines/sync-machine.ts` (states:
> idle/refreshing/ok/joining/enrolling/error; STATUS events), `transport.ts`
> (mock / dev WebSocket / on-device loopback via Ekrooh worklet),
> folders & requests machines, and Ekrooh's p2p stack
> (`core/p2p-verify.core.ts`: Hyperswarm topics, Hyperdrive-by-key;
> `docs/adr/0003-loopback-auth-surface.md`: no token in URLs or page JS).
> Markings: **[has]** exists · **[add]** new · **⚠ open** needs decision.

Trust here is architectural, not decorative: peers are named devices the user
explicitly approved, and every screen in this family shows *who* is connected,
*what they hold*, and *that nothing routes anywhere else*.

## 1. Header `<connection-chip>` (global)

One compact chip, persistent on every screen (ui-ux-spec §3.4 colors):

| Underlying state | Chip | Color |
|---|---|---|
| ≥1 peer reachable, all synced | `● direct · N peers` | moss |
| transport up, peers pending / syncing | `● syncing…` | honey |
| alone (0 peers), unsynced local changes | `○ offline · changes waiting` | brick |
| alone, everything already replicated everywhere | `○ offline · up to date` | taupe (calm) |
| joining/enrolling folder | `◌ joining folder…` | honey |

- Tap → navigates to `/peers` (§2). The chip is a *status*, never a button
  with side effects.
- **[add]** Derivation: map sync-machine state + replication status to the
  five rows above; expose as one nanostores atom so every view consumes the
  same truth (no per-view interpretation).
- **Honesty rule:** if the underlying link is degraded (e.g. remote drive open
  timing out, ekrooh#41), the chip must show honey *with reason on tap*
  ("Maya's device is reachable but slow to respond") — not silently appear
  healthy. Timeout threshold: 10 s to degrade, recovery flips back.

## 2. Peers screen (`/peers`) — **[new route]**

Purpose: make the peer graph visible and manageable; home of the audit view.

Sections:

1. **This device** — identity card: generated device name + avatar ring in
   its `memberColor()`; storage used by justus; "holds full copies of: ⟨folders⟩".
2. **Peers** — one card per approved device across folders: name, owner,
   identity color, folders shared, last seen (relative), reachability dot
   (same color language). Actions: rename (local nickname), remove-from-
   folder (→ confirm dialog reiterating L5 semantics: removal stops *future*
   photos; copies already replicated remain until that peer deletes them
   **⚠ open** — revocation/removal semantics are issue #26/#30 territory).
3. **Where are my photos? (audit)** — per folder: which devices hold a copy,
   last verified contact, count of items held remotely vs locally. Footer:
   *"Servers holding your photos: **0**"* with a link "see how this works"
   (replays ui-ux-spec lessons L1/L5). This screen is the product's proof
   surface; it must render entirely from local replication state — no network
   call may be required to display it.
4. **Add a peer** → pairing flow (§3).

## 3. Pairing / invites

Model (from current machines): an existing member produces an invite; the
requester asks to join; an approver confirms (requests machine). UI pieces:

### 3.1 Invite creator (owner/member, per folder) — **[add]**

- Screen: folder picker → **QR** (primary, for in-person) + **copyable join
  code** (fallback, any channel).
- Copy states the capability honestly: *"This code lets someone **ask** to
  join ⟨folder⟩. Nothing happens until you approve."*
- Security notes carried into UI: code auto-expires (**⚠ open** duration);
  regenerating invalidates the old one; per ADR 0003 the code is a bootstrap
  capability — it never appears in URLs, logs, or page-visible globals; the
  app displays it once per view (no referrer/history leakage path).
- **⚠ open (mechanism):** what exactly the QR encodes (topic/drive key +
  bootstrap nonce?) depends on Ekrooh's pairing story (technical vision lists
  server-free onboarding as unresolved). Spec assumes payload =
  `{folderId, bootstrapSecret}` opaque blob; screens don't change if the
  payload evolves.

### 3.2 Joiner side — **[has partial]** requests view

- Enter code / scan QR → preview screen: folder name, owner chip, member
  count, and consent line: *"joining downloads a full copy of this folder to
  this device"* → explicit **Request to join** button (maps to `joining`
  state; spinner copy: *"asking ⟨owner⟩…"*).
- Denied/expired states get honest, non-blaming copy: *"⟨owner⟩ hasn't
  approved yet. You can close this — you'll be added automatically if they
  do."*

### 3.3 Approver side — **[has]** requests view

- Card per request: requester device name/identity color, which folder, when.
- Approve/Deny both immediate; approval triggers L5 lesson (who-sees-what)
  once per user.

## 4. States matrix

| Region | Loading | Empty | Degraded/offline | Error |
|---|---|---|---|---|
| Peers list | skeleton rows | *"No peers yet — share a folder to add some."* | last-seen frozen, dots go taupe/brick honestly | banner + retry |
| Audit | computed locally — instant | per-folder zero rows fine | unchanged (local data) | n/a |
| Invite | QR/code generation spinner | — | QR still renders (offline pairing allowed) **⚠ open** | regen affordance |
| Requests | skeletons | *"No pending requests."* [has] | approvals queue and apply on reconnect **⚠ open** | inline error + retry |

## 5. Accessibility & i18n

- Peer identity must never rely on color alone: name + device-type glyph
  accompany every ring/dot; dots also carry text labels in the audit list.
- QR screens provide the code as selectable text (screen-reader/AT friendly),
  sized ≥ 24 pt equivalent, with "Copy" as a real button.
- All relative times have absolute tooltip/title values.

## 6. Open questions (need human/product decision)

1. Invite payload + expiry mechanism (Ekrooh pairing story) — blocks final QR
   implementation, not these screens' layout/copy.
2. Offline approval queueing (3.4 matrix) — allow or require online?
3. Removal/revocation semantics wording (future vs. existing copies) — #26/#30.
4. Device-name source: user-chosen vs derived (privacy of names in payloads).
