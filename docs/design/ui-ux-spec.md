# justus UI/UX spec — first run, p2p onboarding, color & theme

> Status: proposal (v1) for review. Grounded in `vision.md` +
> `vision.md.technical.md` and the current web app (`apps/web`: routes
> gallery `/`, requests `/requests`, settings `/settings`; lit-html views;
> Mantaq machines for folders/gallery/requests/sync; warm palette in
> `uno.config.ts`). Screens not yet built are marked **[future]**; anything
> that depends on an unresolved product decision is marked **⚠ open**.

The design promise, from `vision.md`: **"no servers" must be legible in the UI
itself** — a non-technical user should be able to explain, from the interface
alone, that their photos never touch a server. Every choice below serves that.

---

## 1. Opening / first-run — the "no servers" moment

First-run is where trust is established or lost. Most apps open with a login
screen; justus must instead make the *absence* of one the headline.

### Screen: Welcome (`/welcome`, shown once per install)

Layout (single column, mobile-first):

1. **App mark + name**, one-line promise:
   > *Your photos, passed directly between your devices and people. No server
   > ever holds them.*

2. **The diagram** (the centerpiece). A minimal animated motif:

   ```
   ┌────────┐  photos move   ┌────────┐
   │ 📱 you │ ─────────────▶ │ 👥 peer│      ✕ no cloud between
   └────────┘   directly     └────────┘
   ```
   - Two device shapes with a moving dot on the connecting line.
   - A deliberately "crossed-out cloud" glyph sits off-path with the label
     *"no relay · no account · no upload"*.
   - Animation is subtle (2s loop); it must read as *information*, not
     decoration. Respect `prefers-reduced-motion`.

3. **Three plain-language facts** (the whole privacy model, no scrolling):
   - **No account.** Nothing to sign up for; nothing to log into.
   - **Peers hold your data.** Photos live only on devices you choose.
   - **Works offline.** Devices sync when they see each other.

4. **One primary action:** `warm-pill` button **"Create your first folder"**
   → onboarding (§2). Secondary link: *"Join someone's folder"* (paste/scan
   invite).

### Why this works as a privacy argument

- The claim is falsifiable *in the UI*: there is no login form anywhere, the
  diagram shows the entire data path, and the persistent no-server indicator
  (§3.4) stays visible afterwards.
- We do not say "end-to-end encrypted" as a substitute for architecture — the
  honest claim is structural (*no place for data to go*), which matches the
  technical vision's "verifiable: nowhere for data to tunnel to".

### Empty states after first-run

- Gallery empty state repeats the diagram in miniature: *"Photos appear here
  when you add them — they stay on this device until you share the folder."*
- Requests empty state: *"No pending requests. When someone asks to join a
  folder, you approve it here — nothing happens without your yes."*

---

## 2. P2P onboarding + in-app training

Onboarding is not a wall of text up front — it is a **sequence of short
lessons delivered at the moment each quirk becomes real** ("just-in-time"
training). Each lesson: ≤3 sentences + one visual, dismissible, never modal
more than once.

### 2.1 First-run flow (task-oriented)

1. **Welcome** (§1) →
2. **Create/join folder** (existing machines: folders-machine).
   Copy names the concept honestly: a folder is *a shared album that lives on
   every member's device*.
3. **Add first photo** → lands in gallery with provenance chip *"only on this
   device"*.
4. **Invite a peer** → shows the invite surface and the lesson *"A folder is
   empty for others until they join."*
5. Done → gallery. Total: 4 steps, skippable except folder creation.

### 2.2 The five lessons (in-app training set)

| # | Trigger | Lesson (copy sketch) | Visual |
|---|---------|----------------------|--------|
| L1 **No server** | end of Welcome | "There is no website behind justus. Your photos move device-to-device. If this app vanished tomorrow, your photos would not." | crossed-out-cloud motif |
| L2 **Peers hold your data** | first successful share to a peer | "Maya's device now holds this photo too. Anyone with the folder can see everything in it — share accordingly." | folder card with peer avatars appearing |
| L3 **Offline-first** | first offline capture / sync-pending state | "You're offline — fine. Your photo is saved here and marked ⏳ *waiting*. It travels next time you're near a peer who has the folder." | sync-pending chip animating to ✓ |
| L4 **Eventual consistency** | first observed cross-peer edit/delete reconciliation | "Devices compare notes when they meet. Last change wins, and the activity log shows what happened." | two timelines converging |
| L5 **Who can see what** | first new member approved | "Nils can now see every photo in *Spain 2026* — past and future ones. Folder membership is all-or-nothing." **⚠ open:** per-photo grants would change this copy; tracked in issue #25/#30. | membership roster |

### 2.3 Joining a folder (peer-to-peer invite)

- Invite = code/QR produced by an existing member (**⚠ open:** transport of
  the invite itself — in-person QR vs. any-channel link; depends on Ekrooh's
  pairing story. Spec assumes both: QR primary, copyable code fallback.)
- Requester sees: folder name, owner identity chip, member count, and the
  line *"joining means your device will hold a full copy of this folder"* —
  consent before storage, not after.
- Owner approves via existing `requests` view; the approval UI reiterates
  what the requester gains (L5).

### 2.4 Training surfaces

- Lessons render as a dismissible card anchored to the relevant screen region
  (not centered modals), remembered in local settings.
- A permanent **"How justus works"** section in Settings replays all five
  lessons on demand (also the home for the audit affordance below).
- **Audit affordance** (from technical vision): a single Settings screen —
  *"Where are my photos?"* — listing each folder × which peers hold it × last
  verified contact. This is the proof screen: it enumerates every copy,
  and its footer states the total count of servers involved: **0**.

---

## 3. Color & theme system (lit-html + unocss)

### 3.1 Current state (observed)

- `uno.config.ts` defines a warm raw palette (`paper, linen, butter, ink,
  cocoa, taupe, clay, caramel, moss, plum, honey, brick…`) + `warm-*`
  shortcuts, consumed directly in templates (`bg-linen`, `text-cocoa`, …).
- No dark theme; no semantic layer; `memberColor()` derives stable per-device
  hues from drive keys.

### 3.2 Target: three-layer token system

```
Layer 1  primitives   current raw palette (unchanged values)
Layer 2  semantics    --c-page, --c-surface, --c-line, --c-text,
                      --c-text-muted, --c-action, --c-action-hover,
                      --c-ok, --c-warn, --c-danger, --c-focus …
Layer 3  components   existing warm-* shortcuts, rewritten on Layer 2
```

Mechanics (unocss-native, no runtime cost):

- Define Layer 2 as CSS custom properties on `:root` and `.dark`.
- `uno.config.ts` theme colors point at the vars: e.g.
  `page: "var(--c-page)"` so utilities like `bg-page`/`text-text` resolve per
  theme automatically.
- Dark mode via presetUno's class strategy (`dark:` available if needed), but
  the default path needs **no** `dark:` variants — components keep one set of
  semantic classes; only the variable values flip under `.dark`.
- Migration is mechanical and incremental: replace raw usages
  (`bg-linen → bg-surface`) shortcut by shortcut; raw palette remains valid
  during migration.

### 3.3 Light & dark values

Same hue family, adjusted for contrast (WCAG AA minimum; body text ≥ 4.5:1):

| Semantic | Light (current warmth) | Dark |
|---|---|---|
| page | paper `#FAF3E7` | deep umber `#201812` |
| surface | linen `#FFFDF6` | raised umber `#2C2118` |
| line / line-strong | `#E8D6BA` / `#E2CEB2` | `#4A392B` / `#5C4836` |
| text | ink `#3A2A1D` | paper-warm `#F3E9DA` |
| text-muted | taupe `#8A7159` | `#B39C82` |
| action (brand) | clay `#B05C2E` | clay-lightened `#D97A47` |
| ok | moss `#6E7F45` | `#93AC63` |
| warn | honey `#C98A2D` | `#E0A94C` |
| danger | brick `#B3452F` | `#E06A50` |

(Dark column is a starting point for visual review, not final.)

### 3.4 Trust/privacy color language

Color is a *trust channel*; rules keep it legible:

1. **Connection state owns green/amber/red** (moss/honey/brick):
   - ● moss = direct peers reachable (p2p healthy)
   - ● honey = connecting / some peers pending (sync-waiting uses this too)
   - ● brick = alone/offline with unsynced changes
   These exact three colors appear **nowhere else** in the app.
2. **The no-server indicator** (persistent, every screen header):
   `✕☁ direct · no server` chip in muted moss outline — calm, always-on.
   It turns honey/brick only to reflect connectivity, never to nag.
3. **Identity colors** (who is who): the four stable member hues
   (clay/moss/plum/caramel via `memberColor()`) become avatar rings and
   name chips. They encode *identity*, never approval/danger.
4. **Share provenance chips** (per photo, [future] share surface #30/#29):
   neutral `surface + text-muted` chips listing holding peers ("on: you,
   Maya"); brick reserved for "revoked but still held somewhere" **⚠ open**
   (depends on revocation semantics, issues #26/#30).
5. **Brand clay = actions only** (primary buttons, links). Not used for
   status — so "what can I do" and "what is happening" never share a color.

### 3.5 Component inventory touched

Existing views migrate onto tokens: `gallery.ts`, `requests.ts`,
`settings.ts`, `lightbox.ts`, `confirm.ts`, `toast.ts`, `error-banner.ts`;
shortcuts `warm-card/pill/ghost/input/label` become the component layer.
New components proposed by this spec: `<connection-chip>` (header),
`<provenance-chip>`, `<lesson-card>`, `<first-run-diagram>`, folder status
badges.

---

## 4. Follow-up specs (queued, one PR each)

1. **Library/gallery spec** — grid, lightbox, provenance chips, multi-folder
   switching, offline states.
2. **Peer/connection spec** — header connection-chip behavior, peers list,
   pairing/invite screens, audit screen ("Where are my photos?").
3. **Share/grant spec** — request/approve flows, grant ledger view, receipts,
   revocation UX (blocked on #30 decisions).
4. **Settings spec** — identity, folders, training replay, theme toggle,
   danger zone.
