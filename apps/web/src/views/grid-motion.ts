import { noChange } from "lit-html";
import { AsyncDirective } from "lit-html/async-directive.js";
import { directive, PartType, type ElementPart, type PartInfo } from "lit-html/directive.js";

export const ENTER_MS = 200;
export const EXIT_MS = 150;
export const MOVE_MS = 250;
const EASING = "cubic-bezier(.22,1,.36,1)";

export type Box = { top: number; left: number; width: number; height: number };

export type MotionPlan = {
  moves: { key: string; dx: number; dy: number }[];
  enters: string[];
  exits: { key: string; box: Box }[];
  delayMs: number;
};

type Viewport = { width: number; height: number };

function isVisible(b: Box, vp: Viewport): boolean {
  return b.top < vp.height && b.top + b.height > 0 && b.left < vp.width && b.left + b.width > 0;
}

/** What to animate when tiles or rows went from `first` to `last` boxes (screen coordinates). */
export function planMotion(change: {
  first: Map<string, Box>;
  last: Map<string, Box>;
  viewport: Viewport;
}): MotionPlan {
  const { first, last, viewport } = change;
  const moves: MotionPlan["moves"] = [];
  const enters: string[] = [];
  const exits: MotionPlan["exits"] = [];
  for (const [key, box] of last) {
    const before = first.get(key);
    if (!before) {
      if (isVisible(box, viewport)) enters.push(key);
      continue;
    }
    const dx = before.left - box.left;
    const dy = before.top - box.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    if (isVisible(before, viewport) || isVisible(box, viewport)) moves.push({ key, dx, dy });
  }
  for (const [key, box] of first) {
    if (!last.has(key) && isVisible(box, viewport)) exits.push({ key, box });
  }
  return { moves, enters, exits, delayMs: exits.length > 0 ? EXIT_MS : 0 };
}

type Measured = Map<string, { el: HTMLElement; box: Box }>;

function measure(root: Element): Measured {
  const out: Measured = new Map();
  for (const el of root.querySelectorAll<HTMLElement>("[data-motion-key]")) {
    const key = el.getAttribute("data-motion-key");
    if (key === null) continue;
    const r = el.getBoundingClientRect();
    out.set(key, { el, box: { top: r.top, left: r.left, width: r.width, height: r.height } });
  }
  return out;
}

function boxes(m: Measured): Map<string, Box> {
  return new Map([...m].map(([key, v]) => [key, v.box]));
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Options = { keys: string[]; settle: string };

class GridMotion extends AsyncDirective {
  #settle: string | undefined;
  #signature = "";
  #pending = false;
  #first: Measured = new Map();
  #root: Element | undefined;

  constructor(info: PartInfo) {
    super(info);
    if (info.type !== PartType.ELEMENT) throw new Error("gridMotion goes on an element");
  }

  render(_options: Options) {
    return noChange;
  }

  override update(part: ElementPart, [opts]: [Options]) {
    const signature = opts.keys.join("\n");
    if (opts.settle !== this.#settle) {
      this.#settle = opts.settle;
      this.#signature = signature;
      return noChange;
    }
    if (signature === this.#signature) return noChange;
    this.#signature = signature;
    if (this.#pending || reducedMotion()) return noChange;
    const root = part.element;
    // A change can land mid-animation: settle running tile animations so
    // positions are read at rest.
    for (const el of root.querySelectorAll("[data-motion-key]")) {
      for (const a of el.getAnimations()) a.finish();
    }
    this.#root = root;
    this.#first = measure(root);
    this.#pending = true;
    queueMicrotask(() => this.#play());
    return noChange;
  }

  #play() {
    const root = this.#root;
    const first = this.#first;
    this.#pending = false;
    this.#first = new Map();
    if (!root) return;
    const last = measure(root);
    // A key whose element was re-created is a new tile, not a move.
    for (const [key, f] of first) {
      if (last.get(key)?.el !== f.el && last.has(key)) first.delete(key);
    }
    const plan = planMotion({
      first: boxes(first),
      last: boxes(last),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    const timing = { delay: plan.delayMs, fill: "backwards" as const, easing: EASING };
    for (const { key, dx, dy } of plan.moves) {
      last
        .get(key)
        ?.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          ...timing,
          duration: MOVE_MS,
        });
    }
    for (const key of plan.enters) {
      last
        .get(key)
        ?.el.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, duration: ENTER_MS });
    }
    for (const { key, box } of plan.exits) {
      const ghost = first.get(key)?.el;
      if (!ghost) continue;
      ghost.style.cssText = `position:fixed;top:${box.top}px;left:${box.left}px;width:${box.width}px;height:${box.height}px;margin:0;pointer-events:none;`;
      ghost.setAttribute("inert", "");
      ghost.setAttribute("aria-hidden", "true");
      document.body.append(ghost);
      const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: EXIT_MS,
        easing: "linear",
        fill: "forwards",
      });
      fade.finished.catch(() => {}).finally(() => ghost.remove());
    }
  }

  protected override disconnected() {
    this.#settle = undefined;
    this.#pending = false;
    this.#root = undefined;
    this.#first = new Map();
  }
}

export const gridMotion = directive(GridMotion);
