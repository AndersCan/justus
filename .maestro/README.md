# Maestro flows for Justus

Mobile-UI (Maestro) flows for the Justus Android app. Justus is a WebView app
(applicationId `no.cankode.justus`, namespace `io.justus.app`): MainActivity loads the built web
layer from a Bare worklet's loopback server via a WebView, and the web layer renders lit-html UI.

Run locally with `pnpm test:native` (`scripts/maestro-e2e.sh`). The release workflow
(`.github/workflows/release-android.yml`) runs the same script on an x86_64 API 36 emulator before
the Play upload. Emulators cannot reach peers, so flows are single-device only.

## What the flow covers

**first-run.yaml** is one fresh-install pass: intro → name → create album → the new, empty album
(proves the worklet starts inside the APK and answers the WebView), then "Add photos to M" opens
the system photo picker (web → worklet → host invoke → native picker), and cancelling returns to
the album.
It is one flow on purpose: every check needs onboarding first, and onboarding is the slow part.

## Keeping it fast

Maestro types slowly on Android, so inputs are one character. Taps set
`waitToSettleTimeoutMs: 500`, because the next step already waits for its own screen.

## Reading the WebView

On API 36 the WebView's text is in the native accessibility tree, so flows use Maestro's default
hierarchy. Do not set `androidWebViewHierarchy: devtools`: with it, assertions on web text time
out even though the text is on screen.

## Page-unique strings

- **`Photos`** is the gallery heading, a nav tab, AND the system picker's toolbar title. The
  picker's other labels differ by picker version (`Collections` exists only in the Play-updated
  one, not on the `google_apis` CI image). Prove the picker by our page being covered
  (`notVisible` on our own text), then visible again after `back`.
- Adding happens only inside an album: its button is `Add photos to <album name>`.
- An empty album says `No photos in this album yet.`

## App lock strings

`scripts/maestro-e2e.sh` sets the emulator PIN to `1111` for the run and clears it on exit.

- `Require unlock to open Justus`: the Settings switch (page-unique). Tapping it opens the system credential prompt.
- `Justus is locked`, `Unlock`: the native lock screen. While it shows, the WebView is invisible, so no web text (`Settings`, the switch) is in the accessibility tree.
- Toasts: `App lock is on`, `App lock is off`.

## Survive check

Not a Maestro flow: `scripts/maestro-e2e.sh` runs it after the suite, twice, without clearing
state. First after wiping the app's cache dir (as Settings → Clear cache does), then after moving
`files/bare` back to `cache/bare` (an install from before albums moved to app storage). Both
times the relaunched worklet must reopen the album "M" from `first-run.yaml` out of the store.
The UI cannot show this: the intro-seen flag lives in web storage keyed by the loopback port,
which changes every launch.

## iOS

`node scripts/maestro-ios.mjs` walks `flows/first-run.yaml` on an iPhone Simulator
(`ios-device` workflow, `workflow_dispatch`); `--ipad` walks `ios/ipad-share.yaml` on an iPad
Simulator. Keep both platform branches of `first-run.yaml` in step when its text changes.

- iPad: Send invite link opens the share menu as a popover over a still-visible page, so
  `notVisible` on our page cannot work, and Maestro cannot read the popover's text (`Copy` is on
  screen but not in the hierarchy). The flow screenshots the menu, closes it with a tap outside and
  checks the page is back. The script fails the run if a `Justus*.ips` crash report appeared during it.
- `ios/` is outside `config.yaml`'s `flows/*.yaml` glob, so Android never runs the iPad flow.
