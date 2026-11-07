# 2. Ports and adapters for the p2p boundary; the fake must pass the real contract

Status: accepted (2026-11-01). Context: #200. Builds on ADR 0001 decision 7.

## Context

ADR 0001 decision 7 says library access moves behind ports once the real-swarm
suites are in CI. This ADR fixes what those ports are, where the code lives and
how fakes are kept honest.

The earlier Synchronizer port had a fake that never ran against a real
implementation, and its parity suite imported vitest, so it could not run in
Bare. It was deleted in #201 and is not coming back (`apps/backend/src/sync` stays gone).
`photo-store.ts` still mixes use-case logic with direct Corestore, Hyperdrive,
Hyperswarm and bare-fs calls, so a wrong belief about a library can hide in
any of it.

## Decision

1. **Four layers.**
   - Domain: pure types and functions (record parsers, ordering). No I/O.
   - Use cases: plain async functions that take ports and domain values
     (join, request, approve, gallery, presence).
   - Ports: types that describe what the app needs from a library.
   - Adapters: the only code that calls the libraries.

   The composition root, `apps/backend/src/main.core.ts`, builds the adapters and passes them in.

2. **One port per library.**
   - `DriveStore`: Corestore and Hyperdrive.
   - `PeerNetwork`: Hyperswarm and protomux.
   - `Files`: bare-fs and bare-path. `main.core.ts`, `dev-inbox.ts` and
     `upload-route.ts` import bare-path today and move behind the port.

   A port is shaped around one library's quirks so a failing contract names
   that library. `bare-pipe` and `bare-crypto` are not ported for now.

3. **Clock is deferred.** It is not a library-quirk boundary. Add it when a use
   case test needs controlled time.
4. **Layout.** Under `apps/backend/`, `src/ports/` and `src/adapters/` are the
   only layer folders.
   Domain code and use cases live in feature folders (for example
   `apps/backend/src/membership/`), not in `src/domain/` or `src/usecases/`. Contracts live
   in `apps/backend/test/contracts/` and fakes in `apps/backend/test/fakes/`.
5. **Import boundary.** Only `apps/backend/src/adapters/` and
   `apps/backend/src/main.core.ts` may import Corestore, Hyperdrive,
   Hyperswarm, protomux, bare-fs or bare-path. `main.core.ts` is the
   composition root and is the one file outside `src/adapters/` with that
   exemption. A check in CI enforces it once the adapters exist. Enforced by the `no-restricted-imports` override in the root `vite.config.ts` (justus #288; bare-fs and bare-path added in the PR for plan #T1). Type queries such as `typeof import("bare-fs")` are not checked; `src/ports/files.ts` uses one to name the slice of bare-fs it needs.
6. **The fake must pass the real contract.** Each port has one portable
   contract suite. It uses the `Check` helper from `apps/backend/test/p2p-scenarios.ts` (no
   vitest, no `node:*`) and runs against the real adapter in Node and in Bare,
   and against the in-memory fake. A fake that fails the contract is wrong; the
   fake is fixed, never the contract bent to fit it. This applies to every new fake under
   `apps/backend/test/fakes/`. `apps/backend/test/fake-drive.ts` predates the
   rule and is phased out as use cases move (T11 of #200). Failure-injection
   hooks such as `readyDelayMs` and unreachable peers stay, as ADR 0001
   decision 1 allows, and sit on top of a fake that passes the contract.
7. **Contracts start from real adapters.** The first PR for a port includes the
   real adapter and its contract; the fake follows. This is the lesson of the
   deleted Synchronizer.
8. **Use cases are plain async functions for now.** No classes, no framework.
   Errors use the repo's `[error, value]` tuple. Modelling the membership flow
   as a state machine is a separate follow-up.
9. **Move one use case at a time**, with the real-swarm suites from ADR 0001 as
   the safety net, until `photo-store.ts` is wiring only.

## Consequences

- Library behaviour is pinned in three small contracts instead of scattered
  across `photo-store` tests.
- Each port adds an adapter, a contract and a fake to maintain. We accept that
  to keep fakes from drifting.
- Contract runs add to the real-swarm budget from ADR 0001 (about 15s total).
- bare-pipe and bare-crypto stay direct imports until one of them causes a bug
  a contract would have caught.
