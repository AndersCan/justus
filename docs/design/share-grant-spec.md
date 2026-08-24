# justus UI/UX spec — Share/grant surface + honest states

> Status: proposal (v1). Follow-up of `docs/design/ui-ux-spec.md` §4.3
> (PR #33). Grounded in issue **#30** (grant ledger + receipts — the product
> model), requests view (`requests.ts`, 96 ln) and machines
> (folders/requests/sync), plus the trust color language (ui-ux-spec §3.4).
> **[has]** exists · **[add]** new · **⚠ open** needs decision.

## 1. The model, in one paragraph (from #30)

Every device keeps a **local, durable, never-replicated** per-peer grant
ledger: `serveTo: granted|revoked|declined|undecided`, `serveFrom`,
`invitedBy`, `receipt`, `online`, `lastSeenAt`. An invitation is a **signed
receipt that doubles as the auto-share grant**. A peer who obtained an album
link without a receipt triggers the **unknown-holder prompt** — batched,
once daily, default "Not now", declined = terminal. The UI must make sharing
states honest: **no copy may imply erasure** of copies already replicated.

## 2. Surfaces

### 2.1 Share sheet (per folder) — **[add]**

Entry: gallery selection bar "Share…" or folder card action.

- **Invite** → existing pairing flow (peer-connection-spec §3.1); on success
  the receipt chip appears: _"⟨name⟩ was invited — they automatically get
  your photos for this album"_ (receipt = auto-share per #30).
- **Grant/revoke per member:** member row with state badge:
  | ledger state           | badge copy           | color         |
  | ---------------------- | -------------------- | ------------- |
  | granted                | _sharing ✓_          | moss          |
  | undecided (known peer) | _not sharing · ask?_ | taupe         |
  | revoked                | _sharing stopped_    | brick-outline |
  | declined               | _said no_            | taupe         |
- Revoke/Re-share are one tap apart, always reversible, and both sides see
  the change ("grants/revokes are reversible and observable" — #30 AC).
- **No erasure implication rule (load-bearing):** revoked copy text is
  _"they keep the photos they already have; they won't get new ones"_ — never
  "removed from their device".

### 2.2 Unknown-holder prompt — **[add]**

Trigger: a device has our album content but no valid receipt (#30).

- **Batched + once-daily**: at most one card per day, shown in gallery header
  area as `lesson-card` style, never modal, never a badge count.
- Copy: _"Someone with your ⟨album⟩ link joined. Share your photos with them?"_
  Buttons: **Not now** (default, bold) · **Share** · small _"never for this
  person"_ link (= declined, terminal, no re-prompt).
- Declined peers appear in the share sheet as _said no_ (§2.1) so the choice
  stays visible and reversible-by-action (a new invite re-runs the flow).

### 2.3 Newcomer view — **[has→refine]**

The joiner's empty gallery is an **honest statement**, not a begging grid:
_"You're in ⟨album⟩. Maya's photos will appear here as her devices come
online — you'll get everything she's chosen to share."_ Pending-count chip
while first sync runs (honey ⏳ → moss ✓).

### 2.4 Grant ledger visibility — **[add]**

Settings/Folders → per-folder **"Who has what"** panel (or folded into audit
screen, peer-connection-spec §2.3): each member × serveTo state × last change.
This is where revocation consequences are explained once, in place.

## 3. Events ↔ UI reactions (from #30)

| Event                   | UI                                                            |
| ----------------------- | ------------------------------------------------------------- |
| PEER_JOINED             | roster updates; if no receipt → §2.2 prompt queued            |
| SHARE_GRANTED / REVOKED | toast + share-sheet badge flip; provenance chips update       |
| SHARE_RECEIVED          | newcomer/gallery counts tick; lightbox provenance adds holder |
| INVITE_RECEIVED         | requests view card [has]                                      |
| STORAGE_COST            | storage section line (settings-spec §1.5)                     |

## 4. States matrix

| Region       | Loading         | Empty                                   | Offline                     | Error                      |
| ------------ | --------------- | --------------------------------------- | --------------------------- | -------------------------- |
| Share sheet  | skeleton rows   | _"Just you — invite someone to share."_ | fully usable (local ledger) | inline retry               |
| Prompt card  | —               | none when queue empty                   | renders offline             | dismiss keeps today's skip |
| Who-has-what | instant (local) | covered by empty copy above             | unchanged                   | n/a                        |

Rule: the ledger is local — **every share-state surface must work offline**
and say so when actions will sync later ("applies next time you're both
online" ⚠ open: confirm serve-gate queues grants offline).

## 5. Open questions

1. Receipt crypto/expiry details (what the QR/code carries) — Ekrooh pairing
   story; does not block layout/copy.
2. Does revoke propagate as an event to the revoked peer's UI (they see
   _sharing stopped_?) or silently stop new items? **⚠ recommend: explicit
   event, honest copy.**
3. Per-photo grants vs per-album only — #30 reads album-scoped; confirm.
4. Offline queuing of grant changes (§4) — needs serve-gate (#29) behavior.
