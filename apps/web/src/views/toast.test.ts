// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { toast } from "./toast";

describe("toast motion", () => {
  type Call = { el: Element; keyframes: any; options: any };
  let calls: Call[];
  const saved = {
    animate: Element.prototype.animate,
    getAnimations: Element.prototype.getAnimations,
    rect: Element.prototype.getBoundingClientRect,
    matchMedia: window.matchMedia,
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const live = () =>
    [...document.querySelectorAll(".justus-toast[data-motion-key]")].filter(
      (el) => !el.hasAttribute("inert"),
    );
  const ghosts = () => [...document.querySelectorAll("body > .justus-toast[inert]")];
  const reduce = (matches: boolean) => {
    window.matchMedia = (() => ({ matches })) as any;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
      calls.push({ el: this, keyframes, options });
      return { finished: new Promise(() => {}) } as any;
    };
    Element.prototype.getAnimations = (() => []) as any;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const p = this.parentElement;
      if (!p) return { left: 0, top: 0, width: 0, height: 0 } as any;
      const n = p.children.length;
      const i = [...p.children].indexOf(this);
      return { left: 16, top: 800 - (n - i) * 60, width: 240, height: 48 } as any;
    };
    reduce(false);
    window.innerWidth = 400;
    window.innerHeight = 800;
  });

  afterEach(async () => {
    vi.advanceTimersByTime(10_000);
    await flush();
    Element.prototype.animate = saved.animate;
    Element.prototype.getAnimations = saved.getAnimations;
    Element.prototype.getBoundingClientRect = saved.rect;
    window.matchMedia = saved.matchMedia;
    vi.useRealTimers();
  });

  const textOf = (el: Element) => el.querySelector("span")!.textContent;

  test("a second toast slides the first one up", async () => {
    toast("A");
    await flush();
    toast("B");
    await flush();
    const els = live();
    expect(els.map(textOf)).toEqual(["A", "B"]);
    const move = calls.find((c) => c.el === els[0]);
    expect(move?.keyframes).toEqual([{ transform: "translate(0px, 60px)" }, { transform: "none" }]);
  });

  test("the older toast fades where it was and the newer one keeps its element, text and focus", async () => {
    toast("A");
    await flush();
    toast("B", { action: { label: "Undo", run: vi.fn() } });
    await flush();
    const [a, b] = live() as [HTMLElement, HTMLElement];
    const button = b.querySelector("button")!;
    button.focus();
    calls = [];
    vi.advanceTimersByTime(3200);
    await flush();
    expect(live()[0]).toBe(b);
    expect(textOf(b)).toBe("B");
    expect(document.activeElement).toBe(button);
    expect(a.hasAttribute("inert")).toBe(true);
    expect(a.parentElement).toBe(document.body);
    expect(calls.find((c) => c.el === a)?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(calls.some((c) => c.el === b)).toBe(false);
  });

  test("the newer toast fades and the older one slides down", async () => {
    toast("A", { action: { label: "Albums", run: vi.fn() } });
    await flush();
    toast("B");
    await flush();
    const [a, b] = live();
    calls = [];
    vi.advanceTimersByTime(3200);
    await flush();
    expect(ghosts()).toContain(b);
    expect(live()[0]).toBe(a);
    expect(calls.find((c) => c.el === a)?.keyframes).toEqual([
      { transform: "translate(0px, -60px)" },
      { transform: "none" },
    ]);
  });

  test("clicking a toast's button runs it and the toast fades out", async () => {
    const run = vi.fn();
    toast("Pick", { action: { label: "Go", run } });
    await flush();
    const el = live()[0]!;
    el.querySelector("button")!.click();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(ghosts()).toContain(el);
  });

  test("with reduced motion a toast leaves at once", async () => {
    reduce(true);
    toast("Gone");
    await flush();
    calls = [];
    vi.advanceTimersByTime(3200);
    await flush();
    expect(document.body.textContent).not.toContain("Gone");
    expect(calls).toEqual([]);
  });
});
