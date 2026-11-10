import { ref } from "lit-html/directives/ref.js";

let pending: string | null = null;

/** The next page that renders this album's heading puts focus on it. */
export function focusOnArrival(albumId: string) {
  pending = albumId;
}

/** Put on an album page heading that has `tabindex="-1"`. */
export function arrivalFocus(albumId: string) {
  return ref((el) => {
    if (pending !== albumId || !(el instanceof HTMLElement)) return;
    // Lit calls this before the heading is in the page.
    queueMicrotask(() => {
      if (pending !== albumId || !el.isConnected) return;
      pending = null;
      el.focus();
    });
  });
}
