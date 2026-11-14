// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { albumSwap, photoSwap } from "./album-transition";
import type { AppPage } from "../machines/router-machine";

const grid: AppPage = { route: "photoAlbums", params: {} };
const page: AppPage = { route: "photoAlbum", params: { id: "a1" } };

function card() {
  const el = document.createElement("a");
  el.dataset.albumCard = "a1";
  document.body.append(el);
  return el;
}

type Doc = { startViewTransition?: unknown };

function stubTransition() {
  const named: (string | null)[] = [];
  const start = vi.fn((cb: () => void) => {
    named.push(document.querySelector("[data-album-card]")?.getAttribute("data-vt") ?? null);
    cb();
    const finished = Promise.resolve();
    return { ready: Promise.reject(new Error("skipped")), finished };
  });
  (document as Doc).startViewTransition = start;
  return { start, named };
}

function reduceMotion(on: boolean) {
  window.matchMedia = (() => ({ matches: on })) as never;
}

afterEach(() => {
  delete (document as Doc).startViewTransition;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("albumSwap", () => {
  test("without view transitions it applies once and restores the grid scroll", () => {
    reduceMotion(false);
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const apply = vi.fn();
    Object.defineProperty(window, "scrollY", { value: 640, configurable: true });
    albumSwap(grid, page, apply);
    albumSwap(page, grid, apply);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(scroll.mock.calls).toEqual([
      [0, 0],
      [0, 640],
    ]);
  });

  test("Reduce motion applies without a transition", () => {
    reduceMotion(true);
    const { start } = stubTransition();
    const apply = vi.fn();
    albumSwap(grid, page, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  test("opening names the tapped card for the transition, then clears it", async () => {
    reduceMotion(false);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const el = card();
    const { start, named } = stubTransition();
    const apply = vi.fn();
    albumSwap(grid, page, apply);
    expect(start).toHaveBeenCalledTimes(1);
    expect(named).toEqual(["album"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-vt")).toBe(false);
    await Promise.resolve();
  });

  test("going back names the card in the grid it lands on, then clears it", async () => {
    reduceMotion(false);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { start } = stubTransition();
    let el: HTMLElement | undefined;
    albumSwap(page, grid, () => {
      el = card();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(el?.getAttribute("data-vt")).toBe("album");
    await new Promise((r) => setTimeout(r));
    expect(el?.hasAttribute("data-vt")).toBe(false);
  });

  test("other moves swap plainly", () => {
    reduceMotion(false);
    const { start } = stubTransition();
    const apply = vi.fn();
    albumSwap(grid, grid, apply);
    albumSwap(undefined, page, apply);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  test("a missing card still swaps", () => {
    reduceMotion(false);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    stubTransition();
    const apply = vi.fn();
    albumSwap(grid, page, apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

test("opening names the tapped card, not another one", () => {
  reduceMotion(false);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const other = document.createElement("a");
  other.dataset.albumCard = "b2";
  document.body.append(other);
  const el = card();
  const seen: (string | null)[] = [];
  (document as Doc).startViewTransition = (cb: () => void) => {
    seen.push(other.getAttribute("data-vt"), el.getAttribute("data-vt"));
    cb();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  };
  albumSwap(grid, page, () => {});
  expect(seen).toEqual([null, "album"]);
});

test("the grid scroll is restored after the grid is back on screen", () => {
  reduceMotion(false);
  const order: string[] = [];
  vi.spyOn(window, "scrollTo").mockImplementation(() => void order.push("scroll"));
  albumSwap(page, grid, () => order.push("apply"));
  expect(order).toEqual(["apply", "scroll"]);
});

function tile() {
  const el = document.createElement("figure");
  el.dataset.photoTile = "/a";
  document.body.append(el);
  return el;
}

function stubPhotoTransition() {
  const seen: { tile: string | null; marked: boolean }[] = [];
  const start = vi.fn((cb: () => void) => {
    seen.push({
      tile: document.querySelector("[data-photo-tile]")?.getAttribute("data-vt") ?? null,
      marked: document.documentElement.hasAttribute("data-vt-photo"),
    });
    cb();
    return { ready: Promise.reject(new Error("skipped")), finished: Promise.resolve() };
  });
  (document as Doc).startViewTransition = start;
  return { start, seen };
}

describe("photoSwap", () => {
  test("no tile applies once without a transition", () => {
    reduceMotion(false);
    const { start } = stubPhotoTransition();
    const apply = vi.fn();
    photoSwap("/a", "open", apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-vt-photo")).toBe(false);
  });

  test("a tile of another photo is not used", () => {
    reduceMotion(false);
    const { start } = stubPhotoTransition();
    tile();
    const apply = vi.fn();
    photoSwap("/b", "open", apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  test("Reduce motion applies once and never names the tile", () => {
    reduceMotion(true);
    const { start } = stubPhotoTransition();
    const el = tile();
    const apply = vi.fn();
    photoSwap("/a", "open", apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(el.hasAttribute("data-vt")).toBe(false);
  });

  test("without view transitions it applies once, synchronously", () => {
    reduceMotion(false);
    const el = tile();
    const apply = vi.fn();
    photoSwap("/a", "close", apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-vt")).toBe(false);
  });

  test("opening names the tile and marks the page, then clears both", async () => {
    reduceMotion(false);
    const { seen } = stubPhotoTransition();
    const el = tile();
    const apply = vi.fn();
    photoSwap("/a", "open", apply);
    expect(seen).toEqual([{ tile: "photo", marked: true }]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(el.hasAttribute("data-vt")).toBe(false);
    await new Promise((r) => setTimeout(r));
    expect(document.documentElement.hasAttribute("data-vt-photo")).toBe(false);
  });

  test("closing names the tile after the viewer goes, then clears both", async () => {
    reduceMotion(false);
    const { seen } = stubPhotoTransition();
    const el = tile();
    photoSwap("/a", "close", () => {
      expect(el.hasAttribute("data-vt")).toBe(false);
    });
    expect(seen).toEqual([{ tile: null, marked: true }]);
    expect(el.getAttribute("data-vt")).toBe("photo");
    await new Promise((r) => setTimeout(r));
    expect(document.querySelectorAll("[data-photo-tile][data-vt]")).toHaveLength(0);
    expect(document.documentElement.hasAttribute("data-vt-photo")).toBe(false);
  });
});
