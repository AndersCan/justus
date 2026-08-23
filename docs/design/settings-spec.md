# justus UI/UX spec — Settings screen

> Status: proposal (v1). Follow-up of `docs/design/ui-ux-spec.md` §4.4
> (PR #33). Grounded in `apps/web/src/views/settings.ts` (455 ln: name
> section, share-key copy, enroll/join sections, device section) and
> folders/sync machines. **[has]** exists · **[add]** new · **⚠ open**.

Principle: settings is where trust facts live in plain language — every
section answers a question a non-technical user actually has.

## 1. Section inventory

| # | Section | Status | Content |
|---|---|---|---|
| 1 | **You** | [has→refine] | Display name (rename [has]); device identity card (name + memberColor ring, from /peers spec §2.1); *"This device holds full copies of ⟨N⟩ folders"* |
| 2 | **Folders** | [has→refine] | Per folder: name, member count, role (creator/member), rename [has], **share key** reveal/copy [has] with capability warning copy ("anyone with this key can ask to join") — aligns with peer-connection-spec §3.1 expiry ⚠ open |
| 3 | **How justus works** | [add] | Replay the five onboarding lessons (ui-ux-spec §2.2); link to audit screen (*Where are my photos?*) |
| 4 | **Appearance** | [add] | Theme: System / Light / Dark (tokens from ui-ux-spec §3.3); persisted locally; motion-reduce override |
| 5 | **Storage** | [add] | Per-folder local size, cache/original split; "free up space" = drop originals kept only as previews **⚠ open** (depends on sparse mirrors/GC, issue #27/#32) |
| 6 | **Danger zone** | [has→extend] | Leave folder (copy states copies remain on other devices until they remove them ⚠ open #26); delete folder (creator only; confirm via `confirm.ts` with typed confirmation for creator-loss weight, issue #26) |

## 2. Copy rules

- Name data honestly: "share key", not "invite link" (it is a capability).
- No dark patterns in danger zone: destructive actions are separated, require
  explicit confirm, state consequences in one sentence.
- Every ⚠ semantics gap above is flagged to its owning issue rather than
  papered over in copy.

## 3. States

All sections render offline (local-only data) — settings must never require
connectivity **[rule]**. Sync-dependent rows (enroll/join progress [has]) use
sync-machine states with retry affordances already present.

## 4. A11y

Section headings are real `<h2>`s [pattern exists]; theme control is a radio
group; storage numbers have text alternatives; focus order follows visual
order per card.
