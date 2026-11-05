# Flow confirmation workflow

Large features are confirmed as flows before any UI or implementation work is
queued. The flows are mantaq machines, drawn by the `@mantaq/inspect` Vite plugin and published
as pages that can be read and ticked off.

Pages: https://anderscan.github.io/justus/

## Steps

1. **Flows land first as machines.** A feature's flows go in
   `apps/web/src/machines/<feature>/`. Each machine is a factory on
   `VirtualClock` where possible, so the fuzzer can drive it. Each has tests and
   JSDoc on its states, events and transitions (the page shows them as
   prose). No UI wiring in these PRs.
2. **Link the page on the feature issue.** Once the machine PRs merge and the
   Pages site is rebuilt, post the page link on the feature issue as a
   checklist, one box per flow.
3. **Confirm.** The owner ticks the boxes or comments on a flow. Implementation
   tasks are queued only after every box is ticked.

## `pnpm flows`

`pnpm flows` runs one `vite build` per feature listed in
`docs/flows/manifest.json`, with the `@mantaq/inspect` Vite plugin over the
feature's machine files. Each feature lands in `<dir>/<feature>/` (`index.html`,
`viz.json` and a script), plus an index in `<dir>` (`--out <dir>`, default
`flows-site`); this is what CI publishes to Pages. The pages drive factory
machines live; singleton machines stay static walks. The Runs list on a page
holds the tests recorded with `recordRuns`, read from the `__runs__/` folder
next to the machine file.

To add a feature, list its machine files under a new key in `manifest.json`.

## `pnpm flows:dev`

`pnpm flows:dev [feature|file ...]` serves the live viz page for the named
machines and redraws it on save. A target is a feature key from
`manifest.json` (`invite-requests`) or a repo-relative `.ts` machine file
(`apps/backend/src/membership/invite-link-machine.ts`); the file need not be in
the manifest yet. No targets means every file in the manifest. An unknown
target prints the known features to stderr and exits 1.

Once listening it prints one line, `flows:dev: http://127.0.0.1:5180/__mantaq/`
(Vite picks the next port if 5180 is busy). Add `?machine=<id>` to open one
machine. It runs until killed.
