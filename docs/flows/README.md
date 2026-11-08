# Flow confirmation workflow

Large features and rule changes are designed as flows before any UI or implementation work is queued. The flows are mantaq machines, drawn by the `@mantaq/inspect` Vite plugin and published as pages that can be read and ticked off. The first answer to a design ask is a preview link to the drawn flow (see Previews), not a written design.

Pages: https://anderscan.github.io/justus/flows/ (the site root is the Justus home page)

## Previews

Every open pull request from a branch in this repo gets the whole site under
`https://anderscan.github.io/justus/pr/<n>/`, for example
`.../pr/12/invite-someone/?machine=<id>&run=<run name>`. When it is live, the pull
request has one comment, updated in place: `Site preview of <sha>: <url>`. `<sha>` is the first 7
characters of the commit the preview was built from, so it says which push you are looking at. If it names an
older commit, the new build is still running (or failed; the comment keeps the last good commit).

- Forks get no preview and no comment.
- A preview lasts 14 days after its build. After that the comment says so; push a commit to rebuild.
- A closed pull request drops out at the next deploy; its comment stays as history.
- Pages caches for up to 10 minutes: reload if the page shows the previous commit's design.
- Done check for an AI-written flow: the reply links one preview URL per journey, and the comment names your head commit.

## Steps

1. **Flows land first as machines.** A feature's flows go in
   `apps/web/src/machines/<feature>/`. Each machine is a factory on
   `VirtualClock` where possible, so the fuzzer can drive it. Each has tests and
   JSDoc on its states, events and transitions (the page shows them as
   prose). No UI wiring in these PRs.
2. **Link the page on the feature issue.** Once the machine PRs merge and the
   Pages site is rebuilt (or, before merge, from the pull request's preview links), post the page link on the feature issue as a
   checklist, one box per flow.
3. **Confirm.** The owner ticks the boxes or comments on a flow. Implementation
   tasks are queued only after every box is ticked.

## `pnpm site:build`

`pnpm site:build` runs `astro build` with the config in
`docs/site/astro.config.mjs` and the `@mantaq/inspect` Astro integration over
every machine file in `docs/flows/manifest.json`. The site lands in `site-dist/`
(`index.html` plus one folder per journey and one for Internals); this is what CI publishes to Pages.
Each manifest key is a page (`docs/site/src/content/docs/<key>.mdx`): five user journeys
(first-run, make-an-album, invite-someone, join-an-album, share-photos), each a walkthrough
table of what the person sees, what they do and the state, then one `<Machine src="..." />`
per machine file. Plumbing (router, prefs, logs, photo viewer, app lock) is on the `internals`
page. Every `machine.state` a page cites in backticks must exist; `scripts/flows.test.ts` checks it. Each `<Machine>`
shows its design findings above the diagram. Factory machines are driven live;
singleton machines stay static walks. The Runs list holds the tests recorded with
`recordRuns`, read from the `__runs__/` folder next to the machine file.

To add a machine, list its file under its feature in `manifest.json` and add a
`<Machine src>` for it on that feature's page. To add a feature, add a manifest
key, a page in `docs/site/src/content/docs/` and the sidebar and index pick it up.

The build fails on any design finding (including a handler or a state's effects with no `/** */` comment), an unfuzzed machine or a broken expectation, and
prints the events that lead there (`failOnFindings` in `docs/site/astro.config.mjs`).
`node scripts/check-flows-site.mjs site-dist` checks only the overview arrow.
`pnpm exec mantaq-check-site site-dist --base /justus --links docs/design/sharing-flows.md --site https://anderscan.github.io/justus/`
serves the site and checks it in a browser: every machine draws, every live machine
handles an event, every overview box opens a built page that shows its machine, and
every walk link on the pages and in `docs/design/sharing-flows.md` opens a run that
exists (it fails on a missing run). `scripts/flows.test.ts` checks that each walk
link carries `machine=` and `run=`, has no `step=` trace, and is named after its run. Needs Chromium; set
`CHROMIUM_PATH` if Playwright's is not installed.

## `pnpm flows:dev`

`pnpm flows:dev [feature|file ...]` serves the live viz page for the named
machines and redraws it on save. A target is a feature key from
`manifest.json` (`join-an-album`) or a repo-relative `.ts` machine file
(`apps/web/src/machines/sharing/invite-link-machine.ts`); the file need not be in
the manifest yet. No targets means every file in the manifest. An unknown
target prints the known features to stderr and exits 1.

Once listening it prints one line, `flows:dev: http://127.0.0.1:5180/__mantaq/`
(Vite picks the next port if 5180 is busy). Add `?machine=<id>` to open one
machine. It runs until killed.
