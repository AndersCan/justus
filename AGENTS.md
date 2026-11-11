<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Project Operating Manual

**Justus** is a peer-to-peer, encrypted photo-sharing app and the reference
consumer of `@ekrooh/bare`. Read `vision.md` first, then `CONTEXT.md` for the
vocabulary (Folder, Member, Reader, Creator, Registry, Share key, Backend, Web
layer, Host, Actor). Use those terms exactly.

## Rules

- **Justus is a consumer of ekrooh.** Do not edit `AndersCan/ekrooh`; file an
  issue there instead. Never work around an ekrooh bug silently: leave a comment
  naming the issue.
- **Keep ekrooh versions in lockstep.** `@ekrooh/bare` (JS, `apps/web` +
  `apps/backend`) and the `bare-host` AAR (`apps/android/app/build.gradle`) track
  the same release. Bump both together, run `vp check` + tests, then do app work.
  Currently **0.7.0**.
- **Every PR adds a bump file.** Run `pnpm bumpy add`. CI fails without one
  when the PR changes `apps/*` or `packages/*`; changes only under `scripts/`,
  `.github/`, `e2e/`, `.maestro/` or `docs/` need none, but add one with
  `--empty` if unsure. Each user-visible change gets one line starting
  `[user]:`, written for the person holding the phone (what they can now do or
  no longer hit, no jargon). Other lines are the developer changelog. The
  Android release note is built from `apps/android/CHANGELOG.md` only, so a
  user-visible change must bump `@justus/android`, whichever package the code
  is in:

  ```
  pnpm bumpy add --packages "@justus/android:patch" --message "[user]: Photos you add while offline now send as soon as you are back online."
  ```

- **CI is the judge.** A local run is a hint, not proof. Push and read the result.
- **All app state is a mantaq actor.** Views read it with `watch(actor, select)`
  from `@mantaq/lit`. For two actors, nest `watch`. Never nest two `watch`es on
  the same actor. Never call `actor.snapshot()` inside a template; event handlers
  and listeners may.
- **No server, ever.** Nothing in the architecture may route photos or metadata
  through a service we operate. Privacy must stay legible in the UI.
- **New feature flows: machines + `pnpm flows:dev` first**, then implementation. See
  `docs/flows/README.md`.
- **Mark every workaround or known limitation** with `WORKAROUND(ekrooh#N): why`
  or `LIMITATION(#N): why` (`#N` = this repo). `pnpm check:issue-refs` fails CI
  when the named issue is closed: remove the workaround or re-file the issue.

## Commands

| Command                                           | Meaning                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `vp install`                                      | Install (pnpm, **hoisted** linker; do not switch to isolated)                             |
| `vp check`                                        | Format + lint + type-check                                                                |
| `vp run -r test`                                  | Unit tests (all packages)                                                                 |
| `vp run -r build`                                 | Build web, backend, core                                                                  |
| `pnpm run dev`                                    | Vite (:5173) + Bare worklet (:8080, `apps/backend/.dev/`, no auth)                        |
| `pnpm run dev:peers`                              | Two worklets (:8080/:8081) + local DHT; tabs `?peer=0` / `?peer=1`                        |
| `pnpm site:build`                                 | Justus site (Astro, `docs/site`) into `site-dist/`; flows from `docs/flows/manifest.json` |
| `pnpm flows:dev [feature\|file]`                  | Live viz page for those machines (:5180); redraws on save                                 |
| `pnpm test:e2e`                                   | Playwright against the real worklet (needs `libatomic1` on Linux)                         |
| `pnpm test:e2e-hub` / `test:e2e-p2p`              | Multi-peer hub / p2p suites                                                               |
| `pnpm test:native`                                | Maestro on an Android emulator (needs SDK + AVD; gates release)                           |
| `cd apps/android && ./gradlew :app:assembleDebug` | Android APK (see `apps/android/README.md`)                                                |
| `cd apps/android && ./gradlew :app:bundleRelease` | Signed Play bundle; release runbook in `docs/release-android.md`                          |
| `node apps/desktop/scripts/build.mjs`             | Desktop app (needs zig 0.17; Linux: GTK3 + WebKitGTK 4.1 dev libs)                        |

## Repo map

| Path              | Contents                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/web`        | Web layer: lit-html + mantaq + UnoCSS. `views/`, `machines/`                     |
| `apps/backend`    | Bare worklet: corestore + hyperdrive + hyperswarm, `justus.photos` plugin        |
| `apps/android`    | Android host (WebView + worklet + media pick/capture)                            |
| `apps/ios`        | iOS host (xcodegen; depends on ekrooh `BareHost`)                                |
| `apps/desktop`    | macOS/Linux host (Zig + system webview + sidecar bare); `build.mjs`, `smoke.mjs` |
| `packages/core`   | `@justus/core`: shared events + types                                            |
| `e2e`, `.maestro` | Playwright (web/hub/p2p) and Maestro (device) specs                              |
| `docs/design`     | Live specs only. Decisions go in `docs/adr/` (create lazily)                     |

## Gotchas that cost time before

- **Never leave a worklet or `scripts/e2e-server.mjs` running in the background**
  of an agent session; it makes tools return empty results. Boot, probe, kill
  inside one script.
- **`Buffer.from(str, "base64")` throws in the bare runtime**, at module load,
  crashing the whole worklet. Use `base64ToBytes()` in `photo-store.ts`.
- **UnoCSS only scans what `uno.config.ts` includes.** lit-html lives in `.ts`;
  keep the pipeline `include` covering it and keep `import "uno.css"` in `main.ts`.
- **mantaq `send()` is a no-op after `__error`.** Distinguish a dead machine
  (offer Reload) from a failed one (offer Retry). Effects must `return runInvoke(...)`.
- **Worklet boot must not await swarm/DHT before `runtime.start()`.** Joins are
  fire-and-forget. Give spool/network invokes explicit timeouts.
- **A shape change ripples.** When a shared type or push payload changes, grep
  `apps/web/src` for its fields. A field the web branches on must be set in the
  backend record, surfaced in the summary, and sent in the push.
- **Refresh the request inbox on every `photos.changed` push** and on join/respond.
- **Seed/imported images must be real decodable files** (e2e asserts `naturalWidth > 0`).
- **`libnativehelper.so` ships in the bare-host AAR** (ekrooh#45 fixed, since 0.5.0); the
  app no longer carries its own shim.
- Emulators cannot P2P each other (NAT). Use a desktop worklet or a physical device.

## Do / don't

- **Do** co-locate unit tests as `*.test.ts`.
- **Don't** commit build output, `apps/backend/.dev`, `.dev-e2e`, `test-results`,
  `apps/ios/{addons,Resources}`, or the generated `justus.xcodeproj`.
- **Don't** touch the `<!--VITE PLUS START/END-->` block.
- **Don't** add handoff notes, session logs or plans to the repo. State belongs
  in code, tests, `CONTEXT.md`, ADRs, or a GitHub issue.
- **Don't** add attribution to commits or PRs: no `Co-Authored-By` trailer, no
  "Generated with Claude Code" line.

## Designing with the AI

- Any ask to design, plan or rethink a feature or a rule (who can do what included) is answered with a drawn design first: follow the mantaq skill (`.claude/skills/mantaq`, start with "First reply to a design ask" in `designing.md`). Never answer it with a prose design or only questions.
- When the ask changes something the app already does (a share link, joining, roles), your FINAL reply, after any helper or UX worker returns, starts with a `Today:` block: one line per story, each a full `https://anderscan.github.io/justus/<feature>/?machine=<id>&run=<title>` link to a recorded walk of today's machine. Your change's preview links come after it. Check that line one is `Today:` before you send. The `Today:` links point at walks that already exist on the live site, so send that reply at once: never wait for a preview build, and never end the reply on a "waiting for the preview" message. Preview links go in a follow-up message once the build is live.
- A question whether something is a bug (a race, a wrong outcome, "what happens if") is answered like a change ask: your reply opens with `Today:` walk links of the machine that runs it, found in the `__runs__` folders next to the machines. If no walk plays that case, record it as a walk test of the real machine and link it. If the case runs outside any machine, say which code runs it.
- A design ask is a request for a preview link: push a branch and open a draft pull request without asking, then reply with one preview link per walk.
- Open the live page with `pnpm flows:dev <feature|file>`.
- A new `*-machine.ts` goes into `docs/flows/manifest.json` (`scripts/flows.test.ts` enforces it) and as a `<Machine src>` on its page in `docs/site/src/content/docs/<feature>.mdx`.
- A machine with more than one state ships with walks of its page's stories (`*.walks.test.ts` next to it); `scripts/flows.test.ts` fails on one without.
- A new backend machine also gets a `pnpm test:bare` scenario.
- After merge the page is at `https://anderscan.github.io/justus/<feature>/?machine=<id>`.
- Before merge, a pull request's preview is at `https://anderscan.github.io/justus/pr/<n>/<feature>/?machine=<id>`; the `Site preview of <sha>` comment says when it is live.
- Refresh the skill with `npx skills update -p`.

## Agent skills

Issues live in GitHub Issues at `AndersCan/justus` via `gh` (`docs/agents/issue-tracker.md`).
Single-context domain docs (`docs/agents/domain.md`). The roadmap map is issue #1.

## Copy catalogue

Every word a person reads in `apps/web` lives in `apps/web/src/copy/en.json`
(`id → { text, status, where, who, screen }`). Views call `t("id", params)` (a
span carrying `data-copy-id`) or `copy("id", params)` (a string, for toasts,
aria-labels, titles). New text is added as `status: "draft"`; only the owner
sets `approved`. Dev builds underline draft text (`data-copy-draft`).
Placeholders: `{name}`, and `{n?one:other}` for plurals. `copy/catalogue.test.ts`
fails on a literal English sentence in views, machines or utils, an unknown id,
an unused id, or params that do not match the text.

The release workflow no longer runs `check-copy-release.mjs app|store` (issue #681 restores an app-copy gate before production). Run by hand: `node scripts/check-copy-release.mjs app|store`
fails naming every draft id (`app`: all entries but `store.*`; `store`: the
`store.*` listing entries plus screenshots without `approved: true` in
`apps/android/fastlane/store-screenshots.json`; a screenshot missing there counts as
unapproved, and approval is by name, so reset it to false when re-recording). `release-android` runs both and
`fastlane listing` runs `store`. Keep `store.*` text equal to the fastlane
metadata files (the catalogue test checks).

Before drafting or changing text, read `docs/voice.md`: what the owner has rejected and chosen so far.
