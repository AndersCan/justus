# Maestro flows for Justus

Mobile-UI (Maestro) flows for the Justus Android app. Justus is a WebView app
(applicationId/namespace `io.justus.app`): MainActivity loads the built web layer from a
Bare worklet's loopback server via a WebView, and the web layer renders lit-html UI.

## What these flows cover

- **boot.yaml** — native host boot: worklet + handoff + WebView load, ending on the fresh-install
  empty gallery.
- **pick.yaml** — the host-plugin system photo picker opens (via `pickAndAdd()`), then cancel
  (`back`) returns to the gallery.
- **back.yaml** — navigate to `/settings` and back, then verify clean exit by asserting the web
  layer is gone and the gallery re-renders.

## `androidWebViewHierarchy: devtools`

Every top-level flow sets:

```yaml
androidWebViewHierarchy: devtools
```

**at the top of the file, before the `---` separator.**

This is required because Justus's UI lives inside a WebView. On Android API 33+ the WebView's
DOM is invisible to Maestro's native accessibility tree, so web content has to be read through
the WebView debugging protocol instead (`mobile-dev-inc/Maestro#1126`). Without this, all
web-content assertions would fail. Note the app must also have WebView debugging enabled (a
separate Kotlin change in `MainActivity.kt`).

## Page-unique strings

A few strings are ambiguous and must not be used alone to prove which page rendered:

- **`Gallery`** is BOTH the gallery page `<h1>` AND a persistent header nav link on every page —
  it does not prove the gallery rendered. Use the page-unique empty-state heading,
  `This folder is empty — for now.`, instead.
- **`Add a photo`** labels BOTH the header pill and the empty-state "add" button (both call
  `pickAndAdd()`). Tapping either is fine for triggering the picker, but after canceling the
  picker, assert the page-unique empty-state heading rather than `Add a photo`.

Page-unique anchors:

| Page                           | Unique string                     |
| ------------------------------ | --------------------------------- |
| Gallery (empty, fresh install) | `This folder is empty — for now.` |
| `/settings` (Folder overview)  | `Your folders`                    |
