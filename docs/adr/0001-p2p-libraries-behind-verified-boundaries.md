# 1. Every assumption about the p2p libraries is verified against the real library

Status: accepted (2026-11-01). Context: #200.

## Context

A phone and a desktop could not share an album. Three bugs caused it, each a
wrong belief about Hyperdrive or Hyperswarm (an `"update"` event that does not
exist, a noise key taken for a drive key, a drive opened twice while the first
open held it exclusively). The in-memory test fakes of that time encoded the same beliefs, so the
tests passed. The first real-swarm suite then found three more on its first
run: a 10-minute rediscovery gap, a dropped `server: true` announce, and
presence caching a per-boot key forever.

We build mostly headless, with AI agents writing much of the code. The cheapest
place to catch a wrong assumption is a test that runs the real library in
seconds.

## Decision

1. **Real libraries by default.** Any behaviour that depends on Corestore,
   Hyperdrive, Hyperswarm, protomux or the DHT is tested on real instances over
   a `hyperdht/testnet` (`apps/backend/test/real-peers.ts`). Fakes are kept only
   for what the real stack cannot do on demand: unreachable peers, timeouts,
   crashes, and fast exhaustive unit cases. A fake must not be the only test of
   a library behaviour.
2. **Bug first, then fix.** Every p2p bug gets a failing real-library test
   before the fix. If the fake hid it, the fake is corrected in the same change.
3. **Pinned and re-verified versions.** The p2p libraries are pinned to exact
   versions, and `apps/backend/test/p2p-versions.test.ts` records the versions
   last verified, including the transitive hypercore. A bump fails that test
   until the real-swarm suites pass on the new version and the list is updated.
4. **Node and bare.** The real-swarm scenarios run under Node and inside the
   bare runtime in CI, since production runs bare.
5. **Observable boundary.** Connections, identity exchanges, topic joins, drive
   opens and drive changes log a structured line, and the worklet serves its
   live p2p state at `/__state`, so a field bug can be diagnosed from logs.
6. **No silent workarounds.** A comment that excuses behaviour with an issue
   uses the `WORKAROUND(repo#N)` / `LIMITATION(repo#N)` marker, and CI fails
   when the issue is closed.
7. **Then layers.** Once the above is in CI, library access moves behind ports
   (`DriveStore`, `PeerNetwork`, `Clock`, `Files`) one use case at a time, as
   #200 describes. The real-swarm suite is the safety net for that refactor.

## Consequences

- Tests that touch the network take seconds, not milliseconds. The full
  real-swarm suite must stay under about 15s; split or parallelise before it grows past that.
- A NAT or mobile-network bug still cannot be reproduced on a localhost
  testnet. Device runs (Maestro, physical phones) remain the only check there.
- Bumping a p2p library is deliberate work, not a lockfile refresh.
