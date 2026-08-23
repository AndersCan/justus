# justus - Vision

## What it is

justus is a **privacy-first photo-sharing app** and the reference app that
demonstrates **Ekrooh** and **Mantaq** working together in a real application.

The name _justus_ signals the core promise: **no servers are involved.** Photos
move directly between peers over Ekrooh's p2p transport. There is no backend to
trust, log, or leak - privacy is a property of the architecture, not a setting.

## Goal

Ship a working photo-sharing app where photos are captured, shared, and synced
**peer-to-peer, with no server in the loop**, with all of the app's complex
logic expressed in Mantaq and all of its cross-platform/runtime plumbing running
on Ekrooh.

## Privacy must be visible

Privacy is not only a technical fact (no server, direct p2p) - it must be
**visible to the user**. The app should make it obvious that data never leaves
the peer graph: show the p2p connection, what is shared with whom, and that
nothing is routed through a third party. Trust is earned by being legible.

## UI / UX direction

justus borrows the _shapes_ proven by mature photo apps (Immich above all) but
re-expresses every surface through the p2p model - there is no cloud to index,
rank, or remember. The reference for concrete screens is
`docs/design/ui-ux-spec.md`; this section sets the direction.

- **Timeline is the home view.** A reverse-chronological gallery grid with
  month/year headers and a density toggle - the natural default over a Folder's
  photos. This is the Gallery actor's primary rendering.
- **Folders are the share unit; albums are local organization.** A Folder is a
  peer-synced, creator-owned share (see `CONTEXT.md`) - not a user album. On top
  of a Folder, a user may curate local collections/albums for arrangement. Do not
  let the two concepts collapse in the UI: the Folder is where photos _live and
  sync_; albums are how one _person_ groups them.
- **People & faces, computed on-device.** Facial grouping runs inside the
  backend worklet (no cloud ML, no upload) and maps faces to people/members -
  a privacy-preserving take on Immich's People view that strengthens the "no
  server ever sees this" story rather than contradicting it.
- **Search is local + peer-sourced, never centralized.** Immich's fast
  metadata/object/natural-language search is rebuilt here as an on-device index
  over the Folder's replicated photos; queries lazy-fill from peers as they
  sync. The UX must make clear that search breadth grows with who you're
  connected to, not with a server.
- **Lightbox / detail is the trust surface.** Swipe/zoom/info like any photo
  app, plus a justus-specific **provenance chip** showing which peers hold the
  photo and its sync state - the place where "no server" becomes something the
  user can read on a per-photo basis.
- **Multi-select + batch actions** (share, organize, remove) follow the standard
  mobile photo pattern; the _share_ action routes through folders/grants, never
  an upload.
- **Connection state is always legible.** A persistent, calm "direct · no
  server" indicator and the trust color language (green/amber/red reserved for
  connection only) keep the architecture visible without nagging.

The bar: a non-technical user should be able to describe, from the interface
alone, that their photos move directly between devices and that no server holds
them.

## Relationship to the others

- **Depends on Ekrooh** for the cross-platform runtime, native hosts, and p2p
  transport - the layer that makes "no servers" possible.
- **Depends on Mantaq** for (almost) all of its logic - state, flows, and
  side effects are modeled as type-safe machines.
- justus is **the proof**. Ekrooh and Mantaq are foundations; justus shows they
  are real. If justus cannot be built on them, that is a signal the foundations
  are not yet healthy.

## Direction of travel / success

- A photo-sharing flow that runs end-to-end (capture → share → sync across
  peers) on Ekrooh's p2p runtime, with zero server dependency.
- Privacy is legible in the UI: the user can see peers, shares, and the absence
  of any central relay.
- (Almost) all meaningful logic lives in Mantaq machines, with high test
  coverage proving the behavior.
- justus becomes the reference consumer that drives Ekrooh (Bare/p2p integration
  points) and Mantaq (testability story) forward.
- Success = Ekrooh and Mantaq are proven to work together in a real app, with
  justus as the reference.
