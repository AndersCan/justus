// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { html, render } from "lit-html";

const looked = vi.fn();
const ended = vi.fn();
vi.mock("../machines/seen-machine", () => ({
  seen: { photosLooked: looked, visitEnded: ended },
}));

type Cb = (e: Partial<IntersectionObserverEntry>[]) => void;
let cb: Cb;
const observe = vi.fn();
const unobserve = vi.fn();
vi.stubGlobal(
  "IntersectionObserver",
  class {
    constructor(c: Cb) {
      cb = c;
    }
    observe = observe;
    unobserve = unobserve;
  },
);

const { lookedAt, flushLooked } = await import("./looked-at");

const p = (id: string, mine = false) => ({ id, folderId: "f1", mine }) as never;
function tile(photo = p("b"), loaded = true) {
  const host = document.createElement("div");
  document.body.append(host);
  render(html`<figure ${lookedAt(photo)}><img /></figure>`, host);
  const el = host.querySelector("figure") as HTMLElement;
  const img = el.querySelector("img") as HTMLImageElement;
  Object.defineProperty(img, "complete", { value: loaded });
  Object.defineProperty(img, "naturalWidth", { value: loaded ? 10 : 0 });
  return { el, img, host };
}
const see = (el: Element, ratio: number) =>
  cb([{ target: el, intersectionRatio: ratio } as IntersectionObserverEntry]);
const hide = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  looked.mockClear();
  ended.mockClear();
  observe.mockClear();
  unobserve.mockClear();
});
afterEach(() => {
  hide("visible");
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("lookedAt", () => {
  it("999 ms on screen is not looked at", () => {
    const { el } = tile();
    see(el, 0.5);
    vi.advanceTimersByTime(999);
    flushLooked();
    expect(looked).not.toHaveBeenCalled();
  });

  it("1000 ms then a flush sends the photo once", () => {
    const { el } = tile();
    see(el, 0.5);
    vi.advanceTimersByTime(1000);
    flushLooked();
    expect(looked).toHaveBeenCalledTimes(1);
    expect(looked).toHaveBeenCalledWith([{ albumId: "f1", photoId: "b" }]);
  });

  it("the batch sends itself a second later", () => {
    const { el } = tile();
    see(el, 1);
    vi.advanceTimersByTime(2000);
    expect(looked).toHaveBeenCalledTimes(1);
  });

  it("scrolling away at 500 ms cancels", () => {
    const { el } = tile();
    see(el, 1);
    vi.advanceTimersByTime(500);
    see(el, 0.2);
    vi.advanceTimersByTime(2000);
    expect(looked).not.toHaveBeenCalled();
  });

  it("an unloaded image counts from its load", () => {
    const { el, img } = tile(p("b"), false);
    see(el, 1);
    vi.advanceTimersByTime(3000);
    expect(looked).not.toHaveBeenCalled();
    img.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(2000);
    expect(looked).toHaveBeenCalledTimes(1);
  });

  it("the person's own photo is never observed", () => {
    const { el } = tile(p("m", true));
    expect(observe).not.toHaveBeenCalledWith(el);
  });

  it("hiding the app sends what is pending and ends the visit", () => {
    const { el } = tile();
    see(el, 1);
    vi.advanceTimersByTime(1000);
    hide("hidden");
    expect(looked).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("hiding cancels a wait in progress", () => {
    const { el } = tile();
    see(el, 1);
    vi.advanceTimersByTime(500);
    hide("hidden");
    vi.advanceTimersByTime(3000);
    expect(looked).not.toHaveBeenCalled();
  });

  it("showing the app watches every tile again", () => {
    const { el } = tile();
    observe.mockClear();
    hide("visible");
    expect(unobserve).toHaveBeenCalledWith(el);
    expect(observe).toHaveBeenCalledWith(el);
  });
});
