# justus UI/UX spec — first run, p2p onboarding, color & theme

> Status: proposal (v1) for review. Grounded in `vision.md` +
> `vision.md.technical.md` and the current web app (`apps/web`: routes
> gallery `/`, requests `/requests`, settings `/settings`; lit-html views;
> Mantaq machines for folders/gallery/requests/sync; semantic tokens in
> `uno.config.ts`). Screens not yet built are marked **[future]**; anything
> that depends on an unresolved product decision is marked **⚠ open**.

The design promise, from `vision.md`: **"no servers" must be legible in the UI
itself** — a non-technical user should be able to explain, from the interface
alone, that their photos never touch a server. Every choice below serves that.

---

## 1. Opening / first-run — the "no servers" moment

First-run is where trust is established or lost. Most apps open with a login
screen; justus must instead make the _absence_ of one the headline.

### Screen: Welcome (`/welcome`, shown once per install)

Layout (single column, mobile-first):

1. **App mark + name**, one-line promise:

   > _Your photos, passed directly between your devices and people. No server
   > ever holds them._

2. **The diagram** (the centerpiece). A minimal animated motif:

   ```
   ┌────────┐  photos move   ┌────────┐
   │ 📱 you │ ─────────────▶ │ 👥 peer│      ✕ no cloud between
   └────────┘   directly     └────────┘
   ```
   - Two device shapes with a moving dot on the connecting line.
   - A deliberately "crossed-out cloud" glyph sits off-path with the label
     _"no relay · no account · no upload"_.
   - Animation is subtle (2s loop); it must read as _information_, not
     decoration. Respect `prefers-reduced-motion`.

3. **Intro cards** (swipeable, skippable, one idea each; replaces the three-bullet list):
   1. **Share photos with the people you choose.** Family and friends. No account.
   2. **No server.** Photos travel directly between phones.
   3. **You pick what to share.** Photos enter through the picker or camera.
   4. **Albums and invites.** An Admin starts an album and sends its invite link. Anyone with the link can see the photos; the Admin approves who can add their own.
   5. **Photos live on your devices,** not in the cloud. Keep them on at least one device you trust.
   6. **Connect over WiFi when you can.** Photos move while two members have Justus open. Phones on mobile data can have trouble finding each other; if one of you is on WiFi it usually works.

4. **Profile step** (required, after the cards): display name plus an auto
   colour/initials avatar. Copy states the name is shared only with albums you
   join, never a server. Editable later in Settings.

5. **Choose:** primary **"Create an album"**, secondary **"Join with an invite link"**.

### Why this works as a privacy argument

- The claim is falsifiable _in the UI_: there is no login form anywhere, the
  diagram shows the entire data path, and the persistent no-server indicator
  (§3.4) stays visible afterwards.
- We do not say "end-to-end encrypted" as a substitute for architecture — the
  honest claim is structural (_no place for data to go_), which matches the
  technical vision's "verifiable: nowhere for data to tunnel to".

### Empty states after first-run

- Gallery empty state repeats the diagram in miniature: _"Photos appear here
  when you add them — they stay on this device until you invite someone to the album."_
- Requests empty state: _"No pending requests. When someone with the invite
  link asks to add photos, you approve it here."_

---

## 2. P2P onboarding + in-app training

Onboarding is not a wall of text up front — it is a **sequence of short
lessons delivered at the moment each quirk becomes real** ("just-in-time"
training). Each lesson: ≤3 sentences + one visual, dismissible, never modal
more than once.

### 2.1 First-run flow (task-oriented)

1. **Intro cards** (§1), skippable.
2. **Profile** (name required).
3. **Create an album or join with an invite.**
4. **Add first photo** → lands in the album with provenance chip _"only on this
   device"_.
5. **Invite someone** → invite surface (copy link, show QR, paste fallback).

Albums: a user creates and joins as many albums as they like, each with its own
people and invite. The Albums tab lists them all with New album and Join; the
Photos tab shows one album at a time, headed by its name, with a switcher when
there are several. Joining or creating lands in that album.

### 2.2 The five lessons (in-app training set)

| #                           | Trigger                                              | Lesson (copy sketch)                                                                                                                                                                                  | Visual                                  |
| --------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| L1 **No server**            | end of Welcome                                       | "There is no website behind justus. Your photos move device-to-device. If this app vanished tomorrow, your photos would not."                                                                         | crossed-out-cloud motif                 |
| L2 **Peers hold your data** | first successful share to a peer                     | "Maya's device now holds this photo too. Anyone with the folder can see everything in it — share accordingly."                                                                                        | folder card with peer avatars appearing |
| L3 **Offline-first**        | first offline capture / sync-pending state           | "You're offline — fine. Your photo is saved here and marked ⏳ _waiting_. It travels next time you're near a peer who has the folder."                                                                | sync-pending chip animating to ✓        |
| L4 **Eventual consistency** | first observed cross-peer edit/delete reconciliation | "Devices compare notes when they meet. Last change wins, and the activity log shows what happened."                                                                                                   | two timelines converging                |
| L5 **Who can see what**     | first new member approved                            | "Nils can now add photos to _Spain 2026_. Like everyone with the invite link, Nils sees every photo, past and future." **⚠ open:** per-photo grants would change this copy; tracked in issue #25/#30. | membership roster                       |

### 2.3 Joining an album

- Invite = link, QR (in person), or pasted key. All carry the same share key.
- Requester sees the album name, the Admin's name, and member count, and must
  confirm: _"You'll see every photo in this album, old and new, and a copy is
  kept on this phone. People in the album can see when you have Justus open."_
  The invite alone grants viewing; approval is only needed to add photos.
- After joining, the requester sees _"You can look, but not add photos yet."_
  naming the Admin who needs to approve.
- Admin approves in the album's People sheet (§2.6) with "Let them add".
- The Admin's device decides who can add photos. If it is lost, no one new can be
  approved; existing members keep their photos. State this plainly in Help.
  Admin transfer is tracked in a GitHub issue, not designed here.

### 2.4 Training surfaces

- Intro cards (§1) cover the basics once. Just-in-time lessons L2–L5 still fire
  at their trigger and are not repeated in the intro. Lessons render as a
  dismissible card anchored to the relevant region, remembered locally.
- A permanent **Help** section (own destination, not buried in Settings)
  replays the intro and lessons, and holds the Q&A (§2.5).
- **Audit affordance:** _"Where are my photos?"_ lists each album × which peers
  hold it × last contact, footer: servers involved **0**.

### 2.5 Help Q&A

Short answers: Why can't I see Maya's new photos? Why is it stuck on "waiting"?
Do I need WiFi? What if I lose my phone? What can the Admin see and do?

**WiFi / connection advice** (accurate to the cause): mobile carriers often
randomise network addresses (NAT), so two devices both on mobile data may fail
to find each other; one device on WiFi usually fixes it. Sync happens only
while two members both have Justus open and reachable.

**Failed-connection hint:** after about 30s of trying to reach a member without
success, the connection indicator shows a calm hint, not a modal: _"Can't reach
Maya. If you're both on mobile data, ask one of you to switch to WiFi."_ It is
time-based; the app does not try to detect the network type.

### 2.6 People sheet and presence

- The header shows a chip next to the connection indicator: **"● 3 of 5
  connected"**. Tapping it opens the album's **People** sheet.
- Wording is **connected**, never "online": it means "your device can reach
  them right now". Others show "last seen 2h ago" (`GrantRecord.lastSeenAt`).
  The sheet explains this in one line. Your own device always counts.
- Sheet contents: members (name, connected / last seen, "started by" marking
  the Admin), **Invite**, and for the Admin pending requests and Remove.
  Pending requests also badge the chip. This replaces the Requests tab.
- Presence is visible to all members and is disclosed in the join consent.
- **⚠ needs backend work:** `status.peers` is a swarm-wide connection count; a
  per-member map built on `GrantRecord.online` is needed.

## 3. Visual system (implemented)

Neutral, photo-first, light and dark via `prefers-color-scheme`. Content (the
photos) carries the color; chrome stays quiet.

- **Tokens** are CSS variables in `apps/web/index.html`, exposed as Uno
  colors in `uno.config.ts`: `canvas`, `surface`, `subtle`, `line`, `fg`,
  `muted`, `accent`, `accent-strong`, `danger`, `ok`, `warn`. Views use these
  names only, never literal colors.
- **Trust colors** (`trust-green/amber/red`) are reserved for connection state.
  Their only consumer is the connection indicator.
- **Components** are Uno shortcuts: `ui-card`, `ui-btn`, `ui-btn-primary`,
  `ui-btn-ghost`, `ui-input`, `ui-label`, `ui-chip`.
- **Shell:** left rail at `md+`, bottom tab bar below it, slim top bar on
  mobile carrying the connection indicator. Primary routes: Photos, Albums
  (the shared albums list), Sharing, Help; Settings opens from Sharing.
  Requests live in the People sheet.
- **Grid:** tight 2px gutters, month headers, captions and remove only on
  hover for pointer devices. Detail and remove live in the lightbox on touch.
- **Theme:** follows the system by default; a header/rail toggle cycles
  Auto → Light → Dark and persists to `localStorage` (`utils/theme.ts`, applied
  to `<html data-theme>` before first paint).
- Touch targets are at least 44px; motion respects `prefers-reduced-motion`.

## 4. Not yet built

Tracked as GitHub issues, not specs: grant ledger and receipts UX (#25, #30),
person identity (`person-identity-spec.md`, #31), the audit screen ("Where are
my photos?"), people/search.
