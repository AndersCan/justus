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

3. **Three plain-language facts** (the whole privacy model, no scrolling):
   - **No account.** Nothing to sign up for; nothing to log into.
   - **Peers hold your data.** Photos live only on devices you choose.
   - **Works offline.** Devices sync when they see each other.

4. **One primary action:** primary button **"Create your first folder"**
   → onboarding (§2). Secondary link: _"Join someone's folder"_ (paste/scan
   invite).

### Why this works as a privacy argument

- The claim is falsifiable _in the UI_: there is no login form anywhere, the
  diagram shows the entire data path, and the persistent no-server indicator
  (§3.4) stays visible afterwards.
- We do not say "end-to-end encrypted" as a substitute for architecture — the
  honest claim is structural (_no place for data to go_), which matches the
  technical vision's "verifiable: nowhere for data to tunnel to".

### Empty states after first-run

- Gallery empty state repeats the diagram in miniature: _"Photos appear here
  when you add them — they stay on this device until you share the folder."_
- Requests empty state: _"No pending requests. When someone asks to join a
  folder, you approve it here — nothing happens without your yes."_

---

## 2. P2P onboarding + in-app training

Onboarding is not a wall of text up front — it is a **sequence of short
lessons delivered at the moment each quirk becomes real** ("just-in-time"
training). Each lesson: ≤3 sentences + one visual, dismissible, never modal
more than once.

### 2.1 First-run flow (task-oriented)

1. **Welcome** (§1) →
2. **Create/join folder** (existing machines: folders-machine).
   Copy names the concept honestly: a folder is _a shared album that lives on
   every member's device_.
3. **Add first photo** → lands in gallery with provenance chip _"only on this
   device"_.
4. **Invite a peer** → shows the invite surface and the lesson _"A folder is
   empty for others until they join."_
5. Done → gallery. Total: 4 steps, skippable except folder creation.

### 2.2 The five lessons (in-app training set)

| #                           | Trigger                                              | Lesson (copy sketch)                                                                                                                                                                       | Visual                                  |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| L1 **No server**            | end of Welcome                                       | "There is no website behind justus. Your photos move device-to-device. If this app vanished tomorrow, your photos would not."                                                              | crossed-out-cloud motif                 |
| L2 **Peers hold your data** | first successful share to a peer                     | "Maya's device now holds this photo too. Anyone with the folder can see everything in it — share accordingly."                                                                             | folder card with peer avatars appearing |
| L3 **Offline-first**        | first offline capture / sync-pending state           | "You're offline — fine. Your photo is saved here and marked ⏳ _waiting_. It travels next time you're near a peer who has the folder."                                                     | sync-pending chip animating to ✓        |
| L4 **Eventual consistency** | first observed cross-peer edit/delete reconciliation | "Devices compare notes when they meet. Last change wins, and the activity log shows what happened."                                                                                        | two timelines converging                |
| L5 **Who can see what**     | first new member approved                            | "Nils can now see every photo in _Spain 2026_ — past and future ones. Folder membership is all-or-nothing." **⚠ open:** per-photo grants would change this copy; tracked in issue #25/#30. | membership roster                       |

### 2.3 Joining a folder (peer-to-peer invite)

- Invite = code/QR produced by an existing member (**⚠ open:** transport of
  the invite itself — in-person QR vs. any-channel link; depends on Ekrooh's
  pairing story. Spec assumes both: QR primary, copyable code fallback.)
- Requester sees: folder name, owner identity chip, member count, and the
  line _"joining means your device will hold a full copy of this folder"_ —
  consent before storage, not after.
- Owner approves via existing `requests` view; the approval UI reiterates
  what the requester gains (L5).

### 2.4 Training surfaces

- Lessons render as a dismissible card anchored to the relevant screen region
  (not centered modals), remembered in local settings.
- A permanent **"How justus works"** section in Settings replays all five
  lessons on demand (also the home for the audit affordance below).
- **Audit affordance** (from technical vision): a single Settings screen —
  _"Where are my photos?"_ — listing each folder × which peers hold it × last
  verified contact. This is the proof screen: it enumerates every copy,
  and its footer states the total count of servers involved: **0**.

---

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
  mobile carrying the connection indicator. Primary routes: Photos, Albums,
  Sharing, Requests, Folder.
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
