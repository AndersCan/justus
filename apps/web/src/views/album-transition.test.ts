// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { albumSwap } from "./album-transition";
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
