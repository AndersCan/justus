// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { render } from "lit-html";
import type { SyncMember } from "@justus/core";
import { memberColor } from "../utils/palette";
import { presenceDots } from "./presence-dots";

const member = (key: string, name: string, color?: number): SyncMember => ({
  key,
  name,
  admin: false,
  connected: true,
  ...(color !== undefined && { color }),
});
const k0 = member("k0", "Me", 0);
const k1 = member("k1", "Ben", 1);
const k2 = member("k2", "Cara", 2);
const k3 = member("k3", "Dan", 3);

describe("presence dots motion", () => {
  type Call = { el: Element; keyframes: any; options: any };
  let calls: Call[];
  const saved = {
    animate: Element.prototype.animate,
    getAnimations: Element.prototype.getAnimations,
    rect: Element.prototype.getBoundingClientRect,
    matchMedia: window.matchMedia,
  };

  beforeEach(() => {
    calls = [];
    Element.prototype.animate = function (this: Element, keyframes: any, options: any) {
      calls.push({ el: this, keyframes, options });
      return { finished: Promise.resolve() } as any;
    };
    Element.prototype.getAnimations = (() => []) as any;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const i = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: i * 18, top: 0, width: 12, height: 12 } as any;
    };
    window.matchMedia = (() => ({ matches: false })) as any;
    window.innerWidth = 400;
    window.innerHeight = 800;
  });

  afterEach(() => {
    Element.prototype.animate = saved.animate;
    Element.prototype.getAnimations = saved.getAnimations;
    Element.prototype.getBoundingClientRect = saved.rect;
    window.matchMedia = saved.matchMedia;
    document.body.replaceChildren();
  });

  const dots = (host: Element) =>
    new Map(
      [...host.querySelectorAll("[data-motion-key]")].map((el) => [
        el.getAttribute("data-motion-key")!,
        el,
      ]),
    );
  const inner = (el: Element) => el.firstElementChild!;

  const mount = (members: SyncMember[]) => {
    const host = document.createElement("div");
    document.body.append(host);
    render(presenceDots(members, "f1"), host);
    const before = dots(host);
    calls = [];
    return { host, before };
  };

  test("a member who joins fades in and the other dots keep their element and colour", async () => {
    const { host, before } = mount([k0, k1, k2]);
    render(presenceDots([k0, k1, k2, k3], "f1"), host);
    await Promise.resolve();
    const after = dots(host);
    expect([...after.keys()]).toEqual(["k0", "k1", "k2", "k3"]);
    for (const key of ["k0", "k1", "k2"]) {
      expect(after.get(key)).toBe(before.get(key));
      expect(inner(after.get(key)!).getAttribute("style")?.replace(/\s/g, "")).toBe(
        `background:${memberColor({ k0: 0, k1: 1, k2: 2 }[key])};`,
      );
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].el).toBe(after.get("k3"));
    expect(calls[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  test("a member who leaves fades out alone and the dots after it slide over", async () => {
    const { host, before } = mount([k0, k1, k2]);
    render(presenceDots([k0, k2], "f1"), host);
    await Promise.resolve();
    const after = dots(host);
    expect([...after.keys()]).toEqual(["k0", "k2"]);
    expect(after.get("k0")).toBe(before.get("k0"));
    expect(after.get("k2")).toBe(before.get("k2"));
    const ghost = before.get("k1") as HTMLElement;
    expect(ghost.parentElement).toBe(document.body);
    expect(ghost.inert).toBe(true);
    expect(inner(ghost).getAttribute("style")).toContain(memberColor(1));
    expect(calls.find((c) => c.el === ghost)?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    const slide = calls.find((c) => c.el === after.get("k2"));
    expect(slide?.keyframes).toEqual([
      { transform: "translate(18px, 0px)" },
      { transform: "none" },
    ]);
    expect(slide?.options.delay).toBe(150);
    expect(calls.some((c) => c.el === after.get("k0"))).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(ghost.isConnected).toBe(false);
  });

  test("a member going offline changes no dot", async () => {
    const { host, before } = mount([k0, k1, k2]);
    render(presenceDots([k0, { ...k1, connected: false }, k2], "f1"), host);
    await Promise.resolve();
    const after = dots(host);
    for (const key of ["k0", "k1", "k2"]) expect(after.get(key)).toBe(before.get(key));
    expect(calls).toEqual([]);
  });
});

describe("presence dots colour", () => {
  const styles = (members: SyncMember[]) => {
    const host = document.createElement("div");
    render(presenceDots(members, "f1"), host);
    return [...host.querySelectorAll("[data-motion-key] > span")].map((s) =>
      s.getAttribute("style"),
    );
  };
  test("two members with colours 1 and 2 get different fills", () => {
    const [a, b] = styles([k1, k2]);
    expect(a).toBe(`background:${memberColor(1)};`);
    expect(b).toBe(`background:${memberColor(2)};`);
  });
  test("a member with a colour gets a filled dot, not the hollow one", () => {
    const host = document.createElement("div");
    render(presenceDots([k1], "f1"), host);
    const dot = host.querySelector("[data-motion-key] > span")!;
    expect(dot.className.split(" ")).toContain("ui-presence-dot");
    expect(dot.className).not.toContain("ui-presence-dot-none");
  });
  test("a member without a colour gets a hollow dot with no style", () => {
    const host = document.createElement("div");
    render(presenceDots([member("k9", "Zed")], "f1"), host);
    const dot = host.querySelector("[data-motion-key] > span")!;
    expect(dot.hasAttribute("style")).toBe(false);
    expect(dot.className).toContain("ui-presence-dot-none");
  });
});
