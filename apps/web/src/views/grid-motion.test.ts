// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { html, render } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";
import { gridMotion, planMotion, type Box } from "./grid-motion";

const box = (left: number, top: number): Box => ({ left, top, width: 100, height: 100 });
const viewport = { width: 400, height: 800 };
const row = (keys: string[]) => new Map(keys.map((k, i) => [k, box(i * 100, 0)]));

describe("planMotion", () => {
  test("fades in a photo added at the top and slides the tiles after it over", () => {
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

  test("fades a removed photo out in place and closes the gap after the fade", () => {
    expect(planMotion({ first: row(["a", "b", "c"]), last: row(["a", "c"]), viewport })).toEqual({
      moves: [{ key: "c", dx: 100, dy: 0 }],
      enters: [],
      exits: [{ key: "b", box: box(100, 0) }],
      delayMs: 150,
    });
  });

  test("leaves tiles that kept their place alone", () => {
    expect(planMotion({ first: row(["a", "b"]), last: row(["a", "b"]), viewport })).toEqual({
      moves: [],
      enters: [],
      exits: [],
      delayMs: 0,
    });
  });

  test("skips tiles that are off screen", () => {
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
      (k) => html`<figure data-motion-key=${k}></figure>`,
    )}
  </div>
</div>`;

function mount(keys: string[]) {
  const host = document.createElement("div");
  document.body.append(host);
  render(view(keys), host);
  const tile = (k: string) => host.querySelector<HTMLElement>(`[data-motion-key="${k}"]`)!;
  const again = async (next: string[], settle = "album") => {
    render(view(next, settle), host);
    await Promise.resolve();
  };
  return { host, tile, again };
}

const keyOf = (c: Call) => (c.el as HTMLElement).dataset.motionKey;

describe("gridMotion", () => {
  test("animates nothing on the first render of an album", async () => {
    mount(["a", "b"]);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("fades the removed element out in place and slides the next tiles after the fade", async () => {
    const { tile, again } = mount(["a", "b", "c"]);
    const b = tile("b");
    const c = tile("c");
    await again(["a", "c"]);
    const fade = calls.find((x) => x.el === b)!;
    expect(fade.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(fade.options).toEqual({ duration: 150, easing: "linear", fill: "forwards" });
    expect(b.parentElement).toBe(document.body);
    expect(b.style.left).toBe("100px");
    expect(b.hasAttribute("inert")).toBe(true);
    // Re-inserting must not replay a CSS insert animation on the ghost.
    expect(b.style.position).toBe("fixed");
    expect(b.style.animation).toBe("none");
    const slide = calls.find((x) => x.el === c)!;
    expect(slide.keyframes).toEqual([
      { transform: "translate(100px, 0px)" },
      { transform: "none" },
    ]);
    expect(slide.options).toEqual({
      delay: 150,
      fill: "backwards",
      easing: "cubic-bezier(.22,1,.36,1)",
      duration: 250,
    });
    expect(calls).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(b.isConnected).toBe(false);
  });

  test("fades in only the new tile when a photo is added", async () => {
    const { tile, again } = mount(["a", "b"]);
    await again(["a", "b", "n"]);
    expect(calls.map(keyOf)).toEqual(["n"]);
    expect(calls[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(calls[0]!.options).toEqual({
      delay: 0,
      fill: "backwards",
      easing: "cubic-bezier(.22,1,.36,1)",
      duration: 200,
    });
    expect(tile("n")).toBe(calls[0]!.el);
  });

  test("animates nothing when the album, sort or density changes", async () => {
    const { again } = mount(["a", "b"]);
    await again(["b", "n"], "other-album");
    await again(["n", "b"], "other-sort");
    expect(calls).toEqual([]);
  });

  test("animates nothing with reduced motion and keeps the same elements", async () => {
    reduced = true;
    const { tile, again } = mount(["a", "b", "c"]);
    const a = tile("a");
    const c = tile("c");
    await again(["a", "c", "n"]);
    expect(calls).toEqual([]);
    expect(tile("a")).toBe(a);
    expect(tile("c")).toBe(c);
  });

  test("settles running tile animations before measuring a mid-animation change", async () => {
    const { again } = mount(["a", "b"]);
    const anim = { finish: vi.fn() };
    running = [anim];
    await again(["a", "b", "n"]);
    expect(anim.finish).toHaveBeenCalled();
  });

  test("animates nothing when the same keys are rendered again", async () => {
    const { again } = mount(["a", "b"]);
    const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");
    await again(["a", "b"]);
    expect(measure).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("treats a re-created element for the same key as an enter, not a move", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const grid = (keys: string[], tag: string) =>
      html`<div ${gridMotion({ keys, settle: "album" })}>
        <div class="grid">
          ${keys.map((k) =>
            tag === "figure"
              ? html`<figure data-motion-key=${k}></figure>`
              : html`<article data-motion-key=${k}></article>`,
          )}
        </div>
      </div>`;
    render(grid(["x", "a"], "figure"), host);
    render(grid(["a"], "article"), host);
    await Promise.resolve();
    expect(calls.map(keyOf).sort()).toEqual(["a", "x"]);
    expect(calls.find((c) => keyOf(c) === "a")?.keyframes).toEqual([
      { opacity: 0 },
      { opacity: 1 },
    ]);
  });

  test("animates once when two changes land in one tick", async () => {
    const { host } = mount(["a", "b"]);
    render(view(["a", "b", "n"]), host);
    render(view(["a", "b", "n", "m"]), host);
    await Promise.resolve();
    expect(calls.map(keyOf)).toEqual(["n", "m"]);
  });

  test("animates nothing after the grid disconnects and reconnects", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = render(view(["a", "b"]), host);
    root.setConnected(false);
    root.setConnected(true);
    render(view(["a", "b", "n"]), host);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  test("drops a removed tile that is off screen without a ghost", async () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const { tile, again } = mount(keys);
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: 0, top: index * 1000, width: 100, height: 100 } as any;
    };
    const far = tile("j");
    await again(keys.slice(0, 9));
    expect(calls.map(keyOf)).not.toContain("j");
    expect(far.isConnected).toBe(false);
  });
});

describe("nested keys", () => {
  test("a keyed element inside a keyed element moves only with its parent", async () => {
    const nested = (keys: string[]) => html`<div ${gridMotion({ keys, settle: "s" })}>
      ${keys.includes("top") ? html`<section data-motion-key="top"></section>` : null}
      <section data-motion-key="p">
        <i data-motion-key="c1"></i><i data-motion-key="c2"></i>
      </section>
    </div>`;
    const host = document.createElement("div");
    document.body.append(host);
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const shifted = host.querySelector('[data-motion-key="top"]') !== null;
      const isTop = this.getAttribute("data-motion-key") === "top";
      return { left: 0, top: isTop || !shifted ? 0 : 100, width: 100, height: 100 } as any;
    };
    render(nested(["p"]), host);
    await Promise.resolve();
    render(nested(["top", "p"]), host);
    await Promise.resolve();
    expect(calls.map(keyOf).sort()).toEqual(["p", "top"]);
  });
});
