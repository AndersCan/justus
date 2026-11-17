import { noChange } from "lit-html";
import { AsyncDirective, directive } from "lit-html/async-directive.js";
import type { ElementPart, Part } from "lit-html";
import type { Photo } from "@justus/core";
import { seen } from "../machines/seen-machine";

const LOOK_MS = 1000;
const FLUSH_MS = 1000;

type Tile = { photo: Photo; showing: boolean; timer?: ReturnType<typeof setTimeout> };

const tiles = new WeakMap<Element, Tile>();
let batch: { albumId: string; photoId: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let observer: IntersectionObserver | undefined;

/** Sends what was looked at so far. */
export function flushLooked(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (batch.length === 0) return;
  const photos = batch;
  batch = [];
  seen.photosLooked(photos);
}

function loaded(element: Element): boolean {
  const img = element.querySelector("img");
  return img !== null && img.complete && img.naturalWidth > 0;
}

function stop(tile: Tile) {
  clearTimeout(tile.timer);
  tile.timer = undefined;
}

function startTimer(tile: Tile) {
  stop(tile);
  tile.timer = setTimeout(() => {
    tile.timer = undefined;
    const { folderId, id } = tile.photo;
    if (folderId === undefined) return;
    batch.push({ albumId: folderId, photoId: id });
    if (flushTimer === undefined) flushTimer = setTimeout(flushLooked, FLUSH_MS);
  }, LOOK_MS);
}

function onEntries(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const element = entry.target;
    const tile = tiles.get(element);
    if (!tile) continue;
    tile.showing = entry.intersectionRatio >= 0.5 && element.isConnected;
    if (!tile.showing) {
      stop(tile);
      continue;
    }
    if (loaded(element)) startTimer(tile);
    else {
      element.querySelector("img")?.addEventListener(
        "load",
        () => {
          if (tile.showing && element.isConnected) startTimer(tile);
        },
        { once: true },
      );
    }
  }
}

function watchTile(element: Element) {
  observer ??= new IntersectionObserver(onEntries, { threshold: 0.5 });
  observer.observe(element);
}

function unwatchTile(element: Element) {
  observer?.unobserve(element);
  const tile = tiles.get(element);
  if (tile) {
    tile.showing = false;
    stop(tile);
  }
}

class LookedAt extends AsyncDirective {
  private element: Element | undefined;
  render(_photo: Photo) {
    return noChange;
  }
  override update(part: Part, [photo]: [Photo]) {
    this.element = (part as ElementPart).element;
    const tile = tiles.get(this.element);
    if (tile) tile.photo = photo;
    else if (photo.mine !== true) {
      tiles.set(this.element, { photo, showing: false });
      if (this.isConnected) watchTile(this.element);
    }
    return noChange;
  }
  protected override disconnected() {
    if (this.element) unwatchTile(this.element);
  }
  protected override reconnected() {
    if (this.element && tiles.has(this.element)) watchTile(this.element);
  }
}

/** On a tile: counts the photo as looked at after half of it has been on screen, loaded, for a second. */
export const lookedAt = directive(LookedAt);
