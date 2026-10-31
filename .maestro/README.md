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

- **`Photos`** is the gallery heading, a nav tab, AND the system picker's toolbar title. Assert
  the picker by its `Collections` tab: the privacy note is missing when the library is empty, as
  on a fresh CI emulator.
- An empty system picker says `No photos yet`. After closing the picker, assert `Collections` is
  gone before checking the album.
- Adding happens only inside an album: its button is `Add photos to <album name>`.
- An empty album says `No photos in this album yet.`
