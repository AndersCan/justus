# Flow confirmation workflow

Large features are confirmed as flows before any UI or implementation work is
queued. The flows are mantaq machines, drawn by `mantaq-inspect` and published
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

`pnpm flows` runs `mantaq-inspect` over each feature listed in
`docs/flows/manifest.json` and writes `docs/flows/<feature>.json`.
`pnpm flows --html <dir>` writes one `<feature>.html` page per feature plus an
index into `<dir>` (default `flows-site`); this is what CI publishes to Pages. The HTML pages drive
factory machines live; singleton machines stay static walks.

To add a feature, list its machine files under a new key in `manifest.json`
and re-run `pnpm flows`.
