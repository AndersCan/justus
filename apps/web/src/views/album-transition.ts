import type { AppPage } from "../machines/router-machine";

const NAME = "data-vt";

/** Where the Albums grid was scrolled when an album opened. */
let gridY = 0;

function cardOf(id: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-album-card]")].find(
    (el) => el.dataset.albumCard === id,
  );
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Runs `apply` (the page swap). Opening an album from the grid grows its card
 * into the page; going back shrinks the page into the card. Anything else, Reduce
 * motion, or a web view without view transitions swaps plainly. The grid scroll
 * is restored in every case.
 */
export function albumSwap(
  from: AppPage | undefined,
  to: AppPage | undefined,
  apply: () => void,
): void {
  const opening = from?.route === "photoAlbums" && to?.route === "photoAlbum";
  const closing = from?.route === "photoAlbum" && to?.route === "photoAlbums";
  if (!opening && !closing) return apply();
  if (opening) gridY = window.scrollY;
  const id = opening ? to.params.id : from.params.id;
  const land = () => {
    apply();
    window.scrollTo(0, opening ? 0 : gridY);
  };
  if (reducedMotion() || typeof document.startViewTransition !== "function") return land();

  const card = opening ? cardOf(id) : undefined;
  card?.setAttribute(NAME, "album");
  const transition = document.startViewTransition(() => {
    card?.removeAttribute(NAME);
    land();
    if (closing) cardOf(id)?.setAttribute(NAME, "album");
  });
  transition.ready.catch(() => {});
  transition.finished
    .catch(() => {})
    .finally(() => {
      for (const el of document.querySelectorAll(`[data-album-card][${NAME}]`)) {
        el.removeAttribute(NAME);
      }
    });
}

export function tileOf(key: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>("[data-photo-tile]")].find(
    (el) => el.dataset.photoTile === key,
  );
}

export type PhotoMove = "open" | "close";

/** The photo transition running now; a skipped one must not clear its names. */
let photoTransition: ViewTransition | undefined;

/**
 * Runs `apply` (opening or closing the viewer). Opening grows the tile of `key`
 * into the viewer's photo; closing shrinks it back into that tile. No tile, Reduce
 * motion or no view transitions: plain.
 */
export function photoSwap(key: string, move: PhotoMove, apply: () => void): void {
  const tile = tileOf(key);
  if (tile === undefined || reducedMotion() || typeof document.startViewTransition !== "function") {
    return apply();
  }
  const root = document.documentElement;
  root.setAttribute("data-vt-photo", "");
  if (move === "open") tile.setAttribute(NAME, "photo");
  const transition = document.startViewTransition(() => {
    tile.removeAttribute(NAME);
    apply();
    if (move === "close") tileOf(key)?.setAttribute(NAME, "photo");
  });
  photoTransition = transition;
  transition.ready.catch(() => {});
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (photoTransition !== transition) return;
      photoTransition = undefined;
      root.removeAttribute("data-vt-photo");
      for (const el of document.querySelectorAll(`[data-photo-tile][${NAME}]`)) {
        el.removeAttribute(NAME);
      }
    });
}
