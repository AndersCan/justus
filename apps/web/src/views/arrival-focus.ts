import { ref } from "lit-html/directives/ref.js";

let pending: string | null = null;

/** The next page that renders this album's heading puts focus on it. */
export function focusOnArrival(albumId: string) {
  pending = albumId;
}

/** Put on an element that holds the album page heading (`tabindex="-1"`). */
export function arrivalFocusWithin(albumId: string) {
  return ref((el) => {
    if (pending !== albumId || !(el instanceof HTMLElement)) return;
    queueMicrotask(() => {
      if (pending !== albumId || !el.isConnected) return;
      const heading = el.querySelector<HTMLElement>('[tabindex="-1"]');
      if (!heading) return;
      pending = null;
      heading.focus();
    });
  });
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
