// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { html, render } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { gridMotion, planMotion, type Box } from "./grid-motion";

const box = (left: number, top: number): Box => ({ left, top, width: 100, height: 100 });
const viewport = { width: 400, height: 800 };
const row = (keys: string[]) => new Map(keys.map((k, i) => [k, box(i * 100, 0)]));

describe("planMotion", () => {
  test("a photo added at the top fades in and the tiles after it slide over", () => {
    expect(planMotion({ first: row(["a", "b"]), last: row(["n", "a", "b"]), viewport })).toEqual({
      moves: [
        { key: "a", dx: -100, dy: 0 },
        { key: "b", dx: -100, dy: 0 },
      ],
      enters: ["n"],
      exits: [],
      delayMs: 0,
    });
  });

  test("a removed photo fades out where it was and the rest close the gap after it", () => {
    expect(planMotion({ first: row(["a", "b", "c"]), last: row(["a", "c"]), viewport })).toEqual({
      moves: [{ key: "c", dx: 100, dy: 0 }],
      enters: [],
      exits: [{ key: "b", box: box(100, 0) }],
      delayMs: 150,
    });
  });

  test("tiles that kept their place are left alone", () => {
    expect(planMotion({ first: row(["a", "b"]), last: row(["a", "b"]), viewport })).toEqual({
      moves: [],
      enters: [],
      exits: [],
      delayMs: 0,
    });
  });

  test("tiles off screen are not animated", () => {
    const far = new Map([["z", box(0, 5000)]]);
    expect(planMotion({ first: new Map(), last: far, viewport }).enters).toEqual([]);
  });
});

type Call = { el: Element; keyframes: unknown; options: any };

let calls: Call[];
let reduced: boolean;
let running: { finish: ReturnType<typeof vi.fn> }[];

beforeEach(() => {
  calls = [];
  reduced = false;
  running = [];
  Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
    calls.push({ el: this, keyframes, options });
    return { finished: Promise.resolve() } as any;
  };
  Element.prototype.getAnimations = (() => running) as any;
  // 4 columns of 100px, by position among siblings.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const i = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    return { left: (i % 4) * 100, top: Math.floor(i / 4) * 100, width: 100, height: 100 } as any;
  };
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes("reduce") })) as any;
  window.innerWidth = 400;
  window.innerHeight = 800;
});

afterEach(() => {
  document.body.replaceChildren();
});

const view = (keys: string[], settle = "album") => html`<div ${gridMotion({ keys, settle })}>
  <div class="grid">
    ${repeat(
      keys,
      (k) => k,
      (k) => html`<figure data-photo-key=${k}></figure>`,
    )}
  </div>
</div>`;

function mount(keys: string[]) {
  const host = document.createElement("div");
  document.body.append(host);
  render(view(keys), host);
  const tile = (k: string) => host.querySelector<HTMLElement>(`[data-photo-key="${k}"]`)!;
  const again = async (next: string[], settle = "album") => {
    render(view(next, settle), host);
    await Promise.resolve();
  };
  return { host, tile, again };
}

const keyOf = (c: Call) => (c.el as HTMLElement).dataset.photoKey;

describe("gridMotion", () => {
  test("the first render of an album animates nothing", async () => {
    mount(["a", "b"]);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("removing a tile fades that same element out in place and slides the next tiles after the fade", async () => {
    const { tile, again } = mount(["a", "b", "c"]);
    const b = tile("b");
    const c = tile("c");
    await again(["a", "c"]);
    const fade = calls.find((x) => x.el === b)!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(b.parentElement).toBe(document.body);
    expect(b.style.left).toBe("100px");
    expect(b.hasAttribute("inert")).toBe(true);
    const slide = calls.find((x) => x.el === c)!;
    expect(slide.keyframes).toEqual([
      { transform: "translate(100px, 0px)" },
      { transform: "none" },
    ]);
    expect(slide.options.delay).toBe(150);
    expect(calls).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(b.isConnected).toBe(false);
  });

  test("adding a photo fades in only the new tile", async () => {
    const { tile, again } = mount(["a", "b"]);
    await again(["a", "b", "n"]);
    expect(calls.map(keyOf)).toEqual(["n"]);
    expect(calls[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(tile("n")).toBe(calls[0]!.el);
  });

  test("changing album, sort or density animates nothing", async () => {
    const { again } = mount(["a", "b"]);
    await again(["b", "n"], "other-album");
    await again(["n", "b"], "other-sort");
    expect(calls).toEqual([]);
  });

  test("with reduced motion nothing animates and the tiles stay the same elements", async () => {
    reduced = true;
    const { tile, again } = mount(["a", "b", "c"]);
    const a = tile("a");
    const c = tile("c");
    await again(["a", "c", "n"]);
    expect(calls).toEqual([]);
    expect(tile("a")).toBe(a);
    expect(tile("c")).toBe(c);
  });

  test("a change mid-animation settles running tile animations before measuring", async () => {
    const { again } = mount(["a", "b"]);
    const anim = { finish: vi.fn() };
    running = [anim];
    await again(["a", "b", "n"]);
    expect(anim.finish).toHaveBeenCalled();
  });
});
