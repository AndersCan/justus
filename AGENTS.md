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
  Currently **0.6.0**.
- **CI is the judge.** A local run is a hint, not proof. Push and read the result.
- **All app state is a mantaq actor.** Each actor's change handler writes
  module-scope nanostore atoms; views read computed view-models through
  `useStore`. Never `.get()` an atom inside a template (no re-render).
- **No server, ever.** Nothing in the architecture may route photos or metadata
  through a service we operate. Privacy must stay legible in the UI.

## Commands

| Command                                           | Meaning                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `vp install`                                      | Install (pnpm, **hoisted** linker; do not switch to isolated)      |
| `vp check`                                        | Format + lint + type-check                                         |
| `vp run -r test`                                  | Unit tests (all packages)                                          |
| `vp run -r build`                                 | Build web, backend, core                                           |
| `pnpm run dev`                                    | Vite (:5173) + Bare worklet (:8080, `apps/backend/.dev/`, no auth) |
| `pnpm run dev:peers`                              | Two worklets (:8080/:8081) + local DHT; tabs `?peer=0` / `?peer=1` |
| `pnpm test:e2e`                                   | Playwright against the real worklet (needs `libatomic1` on Linux)  |
| `pnpm test:e2e-hub` / `test:e2e-p2p`              | Multi-peer hub / p2p suites                                        |
| `pnpm test:native`                                | Maestro on an Android emulator (needs SDK + AVD; gates release)    |
| `cd apps/android && ./gradlew :app:assembleDebug` | Android APK (see `apps/android/README.md`)                         |
| `cd apps/android && ./gradlew :app:bundleRelease` | Signed Play bundle; release runbook in `docs/release-android.md`   |
| `node apps/desktop/scripts/build.mjs`             | Desktop app (needs zig 0.17; Linux: GTK3 + WebKitGTK 4.1 dev libs) |

## Repo map

| Path              | Contents                                                                         |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/web`        | Web layer: lit-html + nanostores + mantaq + UnoCSS. `views/`, `machines/`        |
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
- **`useStore` is a lit-html directive.** Never dereference its result; write
  `useStore($vm, (vm) => body(vm))`.
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
- **The `libnativehelper.so` shim under `apps/android/app/src/main/nativehelper/`**
  works around ekrooh#45. Remove it only once a released AAR is verified without it.
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

## Agent skills

Issues live in GitHub Issues at `AndersCan/justus` via `gh` (`docs/agents/issue-tracker.md`).
Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix` (`docs/agents/triage-labels.md`). Single-context domain docs
(`docs/agents/domain.md`). The roadmap map is issue #1.
