// @vitest-environment happy-dom
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { galleryView } from "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

type Call = { el: Element; keyframes: any; options: any };

const H = (el: Element): number =>
  el.matches('[data-motion-key^="batch:"]')
    ? 80
    : el.matches("figure, h2") || el.children.length === 0
      ? 56
      : [...el.children].reduce((n, c) => n + H(c), 0);
const top = (el: Element): number => {
  const p = el.parentElement;
  if (!p) return 0;
  const i = [...p.children].indexOf(el);
  return top(p) + [...p.children].slice(0, i).reduce((n, c) => n + H(c), 0);
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("add-progress strip motion", () => {
  let calls: Call[];
  let host: HTMLElement;
  let finish: (r: unknown) => void;
  const saved = {
    animate: Element.prototype.animate,
    getAnimations: Element.prototype.getAnimations,
    rect: Element.prototype.getBoundingClientRect,
    matchMedia: window.matchMedia,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  };
  const old = {
    id: "o1",
    name: "o1.jpg",
    folderId: "f1",
    url: "u",
    thumbUrl: "t",
    addedAt: Date.now() - 60 * 86_400_000,
  };
  const byKey = (key: string) => host.querySelector(`[data-motion-key="${key}"]`);
  const callsOn = (el: Element | null) => calls.filter((c) => c.el === el);
  const source = { kind: "path" as const, path: "/a.jpg", name: "a.jpg" };
  const startAdd = async () => {
    hoisted.gateway.add.mockReturnValueOnce(new Promise((r) => (finish = r)));
    gallery.addMany([source], "f1");
    await vi.waitFor(() => expect(byKey("batch:adding")).not.toBeNull());
    await flush();
  };

  beforeEach(async () => {
    Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
      calls.push({ el: this, keyframes, options });
      return { finished: Promise.resolve() } as any;
    };
    Element.prototype.getAnimations = (() => []) as any;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { top: top(this), left: 0, width: 300, height: H(this) } as any;
    };
    window.matchMedia = (() => ({ matches: false })) as any;
    window.innerWidth = 400;
    window.innerHeight = 4000;
    hoisted.gateway.list.mockResolvedValue([null, { photos: [old] }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));
    host = document.createElement("div");
    document.body.append(host);
    render(galleryView({ kind: "all" }), host);
    await flush();
    calls = [];
  });

  afterEach(async () => {
    finish?.([null, { ...old, id: "late" }]);
    await vi.waitFor(() => expect(galleryActor.snapshot().context.batch).toBeNull());
    Element.prototype.animate = saved.animate;
    Element.prototype.getAnimations = saved.getAnimations;
    Element.prototype.getBoundingClientRect = saved.rect;
    window.matchMedia = saved.matchMedia;
    window.innerWidth = saved.innerWidth;
    window.innerHeight = saved.innerHeight;
    render(nothing, host);
    document.body.replaceChildren();
  });

  test("adding photos fades the progress strip in and slides the photos down", async () => {
    const wrap = byKey("section:photos");
    await startAdd();
    expect(byKey("section:photos")).toBe(wrap);
    expect(callsOn(byKey("batch:adding"))[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(callsOn(wrap)[0].keyframes).toEqual([
      { transform: "translate(0px, -80px)" },
      { transform: "none" },
    ]);
    expect(callsOn(byKey("f1/o1"))).toEqual([]);
  });

  test("the last photo and the end of adding slide the photos back up without moving them twice", async () => {
    await startAdd();
    calls = [];
    finish([null, { ...old, id: "p2", name: "p2.jpg", addedAt: Date.now() }]);
    await vi.waitFor(() => expect(galleryActor.snapshot().context.batch).toBeNull());
    await flush();
    await flush();
    const ghost = calls.find((c) => c.el.getAttribute("data-motion-key") === "batch:adding");
    expect(ghost?.el.hasAttribute("inert")).toBe(true);
    expect(ghost?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    const slide = callsOn(byKey("section:photos"))[0];
    expect(slide.keyframes).toEqual([{ transform: "translate(0px, 80px)" }, { transform: "none" }]);
    expect(slide.options.delay).toBe(150);
    expect(callsOn(byKey("f1/o1")).map((c) => c.keyframes)).toEqual([
      [{ transform: "translate(0px, -112px)" }, { transform: "none" }],
    ]);
    expect(callsOn(byKey("f1/p2"))[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });
});
