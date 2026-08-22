# justus UI/UX spec — Library / Gallery screen

> Status: proposal (v1). Follow-up of `docs/design/ui-ux-spec.md` §4.1
> (PR #33). Grounded in the current implementation: `apps/web/src/views/gallery.ts`
> (351 ln) and `lightbox.ts` (162 ln), `machines/gallery-machine.ts`,
> `folders-machine.ts`, `sync-machine.ts`. Existing behavior is described as
> **[has]**; new work is **[add]**; open decisions are **⚠ open**.
> Colors/tokens refer to the theme system in `ui-ux-spec.md` §3.

## 1. Purpose

The gallery is home (`/`). It must answer three questions at a glance:
**what** is here, **who has it** (provenance), and **is it safe yet**
(sync/connection state) — without a server ever being implied.

## 2. Layout

- **Header:** folder switcher (see §5) + persistent no-server chip
  (`✕☁ direct · no server`) + connection dot (moss/honey/brick semantics,
  ui-ux-spec §3.4).
- **Status line [has]:** under header — connection dot + pulse, *"shared with
  N others"*, *"synced ⟨relative time⟩"* (from sync-machine state).
- **Content:** photos grouped by capture month **[has]**; month header shows
  count. Responsive grid 2/3/4 columns (matches current `grid-cols-2 sm:3 lg:4`).
- **Primary action [add]:** floating `warm-pill` **＋ Add photos** pinned
  bottom-right above the fold; keyboard reachable; on Android it opens the
  native capture intent via Ekrooh host.

## 3. Photo card

- **[has]** square crop, rounded-2xl, warm-card ring/shadow, name overlay on
  ink gradient, uploader identity via `memberColor()` dot + name.
- **[add] Provenance chip (v1 = count only):** tiny chip next to the uploader
  line: `on N devices`. Tap → opens provenance popover listing peers holding
  the photo (data source: sync/replication machine). Full per-photo grant
  surface is spec'd separately (#9 / issues #29/#30).
- **[add] Sync-pending badge:** honey ⏳ chip when the photo has local-only
  changes; flips to moss ✓ after first peer confirmation; brick ⚠ if the
  folder is alone and unsynced (ties to L3 lesson trigger).
- **[add] Selection mode:** long-press / checkbox toggle enters multi-select
  bar (count, Share…, Delete, Cancel). Delete always confirms via existing
  `confirm.ts` dialog with copy stating the scope: *"removes from every device
  in this folder"* **⚠ open** — actual deletion semantics across peers depend
  on conflict-resolution decisions (technical vision, issue #23 invariants).

## 4. Lightbox

- **[has]** full-screen viewer from card tap.
- **[add]** swipe/arrow navigation, ESC/back closes; caption strip shows
  name, uploader identity, captured-at, and the same provenance chip as the
  card (consistency rule: provenance visible wherever a photo is).
- **[add]** actions: share (opens share sheet → #9 spec), delete, info toggle.
- Zoom: pinch/double-tap, no pan-lib dependency (CSS transform only).

## 5. Multi-folder switching

Folders are top-level containers (multi-folder rewrite already shipped:
create/join/manage + join requests).

- **Switcher [add]:** header dropdown listing folders with member-count and
  own-status chips; current folder bold. Selecting switches `$router`
  query-less store (folder id lives in gallery/folders machines).
- **Empty folder state [has→refine]:** keep *"Looking for your folder…"* for
  loading; empty folder gets: illustration-free card — *"No photos yet. Add
  the first one, or wait until peers share into this folder."* + Add button.
- **Joining flow** links out to onboarding spec §2.3 (invite/request UX).

## 6. States matrix (per view region)

| Region | Loading | Empty | Offline/degraded | Error |
|---|---|---|---|---|
| Grid | skeleton cards (butter shimmer, reduced-motion static) | empty-folder card | grid stays usable; cards show pending badges | inline `error-banner.ts`, retry keeps scroll pos |
| Status line | — | *"just you in this folder"* | honey/brick dot copy per §3.4 | dot + short reason |
| Lightbox | progressive img load w/ blur-up | — | cached copies open; remote-only show ⏳ | banner + retry |

Rule: **offline never blocks browsing.** Everything already replicated is
fully interactive; only cross-peer actions degrade honestly.

## 7. Performance budget

From technical vision's perf goals and issue #27: grid interaction ≤ 100 ms;
first paint of visible tiles ≤ 1 s on mid-range Android via Ekrooh webview;
thumbnails (sparse mirrors/previews, issue #27) before originals — original
loads on lightbox open. Virtualize the grid once a folder exceeds ~300
photos **[add]** (measure first; don't pre-optimize).

## 8. Accessibility & i18n notes

- All interactive targets ≥ 44 px (existing min-h-11 pattern); focus-visible
  rings everywhere (already used on cards).
- Alt text: photo name + uploader (*"Beach sunset, added by Maya"*); month
  headers are real headings (h2) for screen-reader nav.
- Respect `prefers-reduced-motion`: disable dot pulses and diagram loops.
