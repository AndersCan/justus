# justus - Technical Vision

> Companion to `vision.md` (the concise repo briefing). Technical depth for
> implementers; read this when building, not when prioritizing.

## How "no servers" is achieved (mechanisms)

- **Transport:** app data never touches a central service; Ekrooh's p2p
  transport is the only path.
- **Storage:** photos/metadata live on-device and on granted peers, never on a
  server we operate.
- **Identity/trust:** no account server - peers trust each other through an
  explicit, user-controlled model, not a third party.
- **Verifiable:** with no server, the claim is checkable - the connection graph
  is observable and there is nowhere for data to tunnel to.

## Tech stack

- **HTML / templating:** `lit-html` - the library only, not the full Lit
  framework. Components are plain functions returning templates; no Lit
  element/base-class machinery.
- **CSS:** `unocss` - utility-first, on-demand CSS engine (no preset-heavy
  framework). Styling stays in markup via atomic classes.
- These pair with Ekrooh's rendering rules (`rendering.md`: lit-html +
  nanostores, RootPart lifecycle) for shared, portable UI across platforms.

## How privacy is made visible in the UI

The legibility mechanisms (the _principle_ lives in `vision.md`): a live
peer/connection view (no relay in between), share provenance per photo (which
peers hold it), a persistent no-server indicator, and an audit affordance
showing data never leaves the peer graph. Test: a non-technical user can explain
from the UI alone that their photos are not on a server.

## Logic in Mantaq

(Almost) all app logic - capture, share negotiation, sync/replication, trust -
is Mantaq machines, keeping concurrency-prone p2p behavior deterministic and
testable. Ekrooh's internal connection machine (Mantaq) is the boundary justus
reacts to.

## Open questions

Trust model (pairwise vs. groups, revocation); conflict resolution for
replicated edits/deletes; server-free onboarding (how two peers first find and
trust each other).
