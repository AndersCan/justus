// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import {
  createRouterActor,
  currentPage,
  onPageChange,
  open,
  parsePath,
  pathFor,
  routerActor,
} from "./router-machine";

describe("parsePath", () => {
  test.each([
    ["/", "gallery", {}],
    ["/mine", "mine", {}],
    ["/albums", "photoAlbums", {}],
    ["/albums/abc", "photoAlbum", { id: "abc" }],
    ["/albums/a%20b", "photoAlbum", { id: "a b" }],
    ["/sharing/x/", "album", { id: "x" }],
    ["/sharing", "sharing", {}],
    ["/ALBUMS", "photoAlbums", {}],
    ["/help/", "help", {}],
  ])("%s", (path, route, params) => {
    expect(parsePath(path)).toEqual({ route, params });
  });

  test.each(["/nope", "/albums/a/b", "/albums/%E0", "/albums//", "", "/join/x"])(
    "%j matches nothing",
    (path) => {
      expect(parsePath(path)).toBeUndefined();
    },
  );

  test("pathFor gives the route's path", () => {
    expect(pathFor("help")).toBe("/help");
  });
});

describe("router actor", () => {
  test("starts on the given page and follows NAVIGATED", () => {
    const actor = createRouterActor({ clock: VirtualClock(), page: parsePath("/help") });
    expect(actor.snapshot().context.page?.route).toBe("help");
  });
});

describe("open", () => {
  test("pushes a history entry and shows the page", () => {
    history.replaceState(null, "", "/");
    const before = history.length;
    open("/albums/q");
    expect(history.length).toBe(before + 1);
    expect(location.pathname).toBe("/albums/q");
    expect(currentPage()).toEqual({ route: "photoAlbum", params: { id: "q" } });
  });

  test("replace keeps the history length", () => {
    history.replaceState(null, "", "/");
    const before = history.length;
    open("/mine", { replace: true });
    expect(history.length).toBe(before);
    expect(currentPage()?.route).toBe("mine");
  });

  test("the current URL is a no-op", () => {
    history.replaceState(null, "", "/help");
    open("/help");
    const before = history.length;
    const fn = vi.fn();
    const off = onPageChange(fn);
    open("/help");
    expect(history.length).toBe(before);
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  test("an unknown path shows no page", () => {
    open("/zzz");
    expect(currentPage()).toBeUndefined();
  });
});

describe("onPageChange", () => {
  test("gets the new and old page, and stops after unsubscribe", () => {
    history.replaceState(null, "", "/");
    open("/help", { replace: true });
    const fn = vi.fn();
    const off = onPageChange(fn);
    open("/settings");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual({ route: "settings", params: {} });
    expect(fn.mock.calls[0][1]).toEqual({ route: "help", params: {} });
    off();
    open("/mine");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("browser wiring", () => {
  function link(attrs: Record<string, string>) {
    const a = document.createElement("a");
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    document.body.append(a);
    return a;
  }
  function click(a: HTMLElement, init: MouseEventInit = {}) {
    const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    a.dispatchEvent(e);
    return e;
  }

  test("a plain same-origin link click is prevented and navigates", () => {
    history.replaceState(null, "", "/");
    const e = click(link({ href: "/help" }));
    expect(e.defaultPrevented).toBe(true);
    expect(currentPage()?.route).toBe("help");
  });

  test.each([
    ["meta key", { href: "/mine" }, { metaKey: true }],
    ["ctrl key", { href: "/mine" }, { ctrlKey: true }],
    ["shift key", { href: "/mine" }, { shiftKey: true }],
    ["alt key", { href: "/mine" }, { altKey: true }],
    ["middle button", { href: "/mine" }, { button: 1 }],
    ["target _blank", { href: "/mine", target: "_blank" }, {}],
    ["download", { href: "/mine", download: "" }, {}],
    ["rel external", { href: "/mine", rel: "external" }, {}],
    ["other origin", { href: "https://example.org/mine" }, {}],
  ])("%s is left to the browser", (_n, attrs, init) => {
    history.replaceState(null, "", "/");
    open("/help", { replace: true });
    const e = click(link(attrs), init);
    expect(e.defaultPrevented).toBe(false);
    expect(currentPage()?.route).toBe("help");
  });

  test("an already prevented click is ignored", () => {
    history.replaceState(null, "", "/");
    open("/help", { replace: true });
    const a = link({ href: "/mine" });
    a.addEventListener("click", (ev) => ev.preventDefault());
    click(a);
    expect(currentPage()?.route).toBe("help");
  });

  test("popstate follows the location", () => {
    history.replaceState(null, "", "/albums/z");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(routerActor.snapshot().context.page).toEqual({
      route: "photoAlbum",
      params: { id: "z" },
    });
  });
});
