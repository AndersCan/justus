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
