// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { VirtualClock } from "@mantaq/core";
import { requestRowOf } from "../utils/people";
import { createGalleryActor } from "../machines/gallery-machine";
import {
  albumAddRow,
  albumHeader,
  missingAlbumText,
  requestLineText,
  scopeEmptyState,
  scopePhotos,
  viewerLine,
} from "./gallery";
import { focusOnArrival } from "./arrival-focus";
import type { PhotoScope } from "../utils/photo-scope";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));

const DAY = 86_400_000;
const rec = (id: string, ageDays = 1) => ({
  id,
  name: `${id}.jpg`,
  folderId: "f1",
  url: `blob:${id}`,
  thumbUrl: `blob:${id}-thumb`,
  addedAt: Date.now() - ageDays * DAY,
});
type Rec = ReturnType<typeof rec>;

function build(initial: Rec[], scope: PhotoScope = { kind: "album", id: "f1" }) {
  let current = initial;
  const port = {
    // New objects on every call, like a real sync.
    list: vi.fn(async () => [null, { photos: current.map((p) => ({ ...p })) }]),
    add: vi.fn(async () => [null, rec("added", 0)]),
    upload: vi.fn(),
    remove: vi.fn(),
  };
  const actor = createGalleryActor({ clock: VirtualClock(), gateway: port as any });
  const host = document.createElement("div");
  render(
    scopePhotos(actor, {
      scope,
      sort: "added",
      density: "comfortable" as any,
      empty: () => "empty",
    }),
    host,
  );
  const reload = async (next: Rec[]) => {
    current = next;
    (actor as any).send({ type: "LOAD" });
    await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("loadingPhotos"));
    await vi.waitFor(() => expect(actor.snapshot().path[0]).toBe("showingPhotos"));
  };
  const tiles = () =>
    new Map(
      [...host.querySelectorAll<HTMLElement>("figure[data-motion-key]")].map((el) => [
        el.dataset.motionKey!,
        el,
      ]),
    );
  return { actor, host, reload, tiles };
}

function watchSrc(host: HTMLElement) {
  const records: MutationRecord[] = [];
  const mo = new MutationObserver((r) => records.push(...r));
  mo.observe(host, { subtree: true, childList: true, attributeFilter: ["src"], attributes: true });
  return {
    records: async () => {
      await Promise.resolve();
      return [...records, ...mo.takeRecords()];
    },
  };
}

describe("album grid tiles", () => {
  test("control: the observer sees a replaced img and a src write", async () => {
    const h = document.createElement("div");
    h.innerHTML = `<img src="a">`;
    const w = watchSrc(h);
    h.querySelector("img")!.setAttribute("src", "b");
    h.replaceChildren(document.createElement("img"));
    const kinds = (await w.records()).map((r) => r.type);
    expect(kinds).toContain("attributes");
    expect(kinds).toContain("childList");
  });

  test("a sync that adds one photo and removes another keeps every other tile's image element", async () => {
    const [a, b, c] = [rec("a", 3), rec("b", 2), rec("c", 1)];
    const h = build([a, b, c]);
    await h.reload([a, b, c]);
    const before = h.tiles();
    const imgs = new Map([...before].map(([k, el]) => [k, el.querySelector("img")]));
    const w = watchSrc(h.host);
    await h.reload([a, c, rec("n", 0)]);
    const after = h.tiles();
    expect([...after.keys()]).toEqual(["f1/n", "f1/c", "f1/a"]);
    expect(after.get("f1/a")).toBe(before.get("f1/a"));
    expect(after.get("f1/c")).toBe(before.get("f1/c"));
    expect(after.get("f1/a")!.querySelector("img")).toBe(imgs.get("f1/a"));
    expect(after.get("f1/c")!.querySelector("img")).toBe(imgs.get("f1/c"));
    expect(after.has("f1/b")).toBe(false);
    const srcWrites = (await w.records()).filter((r) => r.type === "attributes");
    expect(srcWrites).toEqual([]);
  });

  test("a new Recently added group above older months keeps the month tiles", async () => {
    const old = [rec("o1", 60), rec("o2", 61)];
    const h = build(old);
    await h.reload(old);
    const before = h.tiles();
    await h.reload([rec("fresh", 0), ...old]);
    const after = h.tiles();
    expect(after.size).toBe(3);
    expect(after.get("f1/o1")).toBe(before.get("f1/o1"));
    expect(after.get("f1/o2")).toBe(before.get("f1/o2"));
  });

  test("an added photo replaced by the reloaded full record keeps its tile", async () => {
    const h = build([]);
    await h.reload([]);
    (h.actor as any).send({
      type: "ADD_MANY",
      payload: { sources: [{ kind: "path", path: "/tmp/x.jpg", name: "x.jpg" }], folderId: "f1" },
    });
    await vi.waitFor(() => expect(h.tiles().has("f1/added")).toBe(true));
    const tile = h.tiles().get("f1/added");
    await vi.waitFor(() => expect(h.actor.snapshot().context.batch?.running).toBe(false));
    await h.reload([rec("added", 0)]);
    expect(h.tiles().size).toBe(1);
    expect(h.tiles().get("f1/added")).toBe(tile);
  });

  test("the All photos scope keeps its tiles across a reload", async () => {
    const [a, b] = [rec("a", 3), rec("b", 2)];
    const h = build([a, b], { kind: "all" });
    await h.reload([a, b]);
    const before = h.tiles();
    expect(before.size).toBe(2);
    await h.reload([a, b, rec("n", 0)]);
    const after = h.tiles();
    expect(after.size).toBe(3);
    expect(after.get("f1/a")).toBe(before.get("f1/a"));
    expect(after.get("f1/b")).toBe(before.get("f1/b"));
  });
});

describe("timeline headings motion", () => {
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
      const root = this.closest("[data-album-photos]");
      if (!root) return { top: 0, left: 0, width: 0, height: 0 } as any;
      const i = [...root.querySelectorAll("[data-motion-key]")].indexOf(this);
      return { top: i * 60, left: 0, width: 300, height: 50 } as any;
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

  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const headings = (host: Element) =>
    new Map(
      [...host.querySelectorAll<HTMLElement>('h2[data-motion-key^="group:"]')].map((el) => [
        el.dataset.motionKey!,
        el,
      ]),
    );
  const keyframesOf = (el: Element) => calls.filter((c) => c.el === el).map((c) => c.keyframes);

  test("a month heading slides with its photos when a photo is added above it", async () => {
    const old = [rec("o1", 60)];
    const h = build(old);
    document.body.append(h.host);
    await h.reload(old);
    await settle();
    const before = headings(h.host);
    const monthKey = [...before.keys()].find((k) => k !== "group:Recently added")!;
    calls = [];
    await h.reload([rec("fresh", 0), ...old]);
    await settle();
    const after = headings(h.host);
    const slide = [{ transform: "translate(0px, -120px)" }, { transform: "none" }];
    expect(after.get(monthKey)).toBe(before.get(monthKey));
    expect(keyframesOf(after.get(monthKey)!)).toContainEqual(slide);
    expect(keyframesOf(h.tiles().get("f1/o1")!)).toContainEqual(slide);
    expect(keyframesOf(after.get("group:Recently added")!)).toContainEqual([
      { opacity: 0 },
      { opacity: 1 },
    ]);
  });

  test("the heading of a month whose last photo leaves fades out where it was", async () => {
    const list = [rec("fresh", 0), rec("o1", 60)];
    const h = build(list);
    document.body.append(h.host);
    await h.reload(list);
    await settle();
    calls = [];
    await h.reload([rec("fresh", 0)]);
    await settle();
    const fade = calls.find((c) => c.el.tagName === "H2" && c.keyframes[1]?.opacity === 0);
    expect(fade).toBeDefined();
    const ghost = fade!.el as HTMLElement;
    expect(ghost.dataset.motionKey).not.toBe("group:Recently added");
    expect(ghost.style.position).toBe("fixed");
    expect(ghost.hasAttribute("inert")).toBe(true);
    expect(fade!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect([...headings(h.host).keys()]).toEqual(["group:Recently added"]);
  });
});

describe("missingAlbumText", () => {
  test("loading while the list is loading or empty", () => {
    expect(missingAlbumText({ folders: [{}], foldersLoading: true })).toBe("Loading…");
    expect(missingAlbumText({ folders: [], foldersLoading: false })).toBe("Loading…");
  });
  test("says the album is missing once loaded, even after a failed refresh", () => {
    expect(missingAlbumText({ folders: [{}], foldersLoading: false })).toBe(
      "This album isn't on this phone.",
    );
  });
});

describe("viewerLine", () => {
  const status = {
    folder: { id: "f1" },
    members: [
      { name: "Me", admin: false },
      { name: "Maya", admin: true },
    ],
  } as never;

  test("names the Admin of the album on screen", () => {
    expect(viewerLine({ status }, { id: "f1" })).toBe(
      "You can see every photo but not add any. Maya decides who can add photos.",
    );
  });

  test("says The Admin when the status is for another album or missing", () => {
    const line = "You can see every photo but not add any. The Admin decides who can add photos.";
    expect(viewerLine({ status }, { id: "f2" })).toBe(line);
    expect(viewerLine({ status: null }, { id: "f1" })).toBe(line);
  });
});

describe("albumAddRow for a removed album", () => {
  test("says the person is no longer in it and offers no add button", () => {
    const host = document.createElement("div");
    const album = {
      id: "f1",
      name: "Trip",
      role: "reader",
      members: 3,
      notice: { kind: "removed" },
    };
    render(albumAddRow({ status: null, folders: [album] } as never, album as never), host);
    expect(host.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "You're no longer in Trip. You can still see the photos you have.",
    );
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("scopeEmptyState for an album", () => {
  const draw = (album: Record<string, unknown>) => {
    const host = document.createElement("div");
    render(scopeEmptyState({ folders: [album] } as never, {} as never, album as never), host);
    return host;
  };
  test("a removed album says how to come back, with no button", () => {
    const host = draw({ id: "f1", name: "Trip", role: "reader", notice: { kind: "removed" } });
    expect(host.querySelector("h2")?.textContent).toBe("No photos on this phone");
    expect(host.querySelector("p")?.textContent).toBe(
      "The Admin removed you from Trip, so new photos won't arrive. To ask to rejoin, paste a new invite link from the Admin. The Admin decides.",
    );
    expect(host.querySelector("button, a")).toBeNull();
  });
  test("a reader who was not removed keeps the usual text", () => {
    const host = draw({ id: "f1", name: "Trip", role: "reader" });
    expect(host.querySelector("h2")?.textContent).toBe("No photos in this album yet.");
    expect(host.querySelector("p")?.textContent).toContain("Photos show up here");
  });
});

describe("albumHeader after Create album", () => {
  test("the album name has focus", async () => {
    const album = { id: "f1", name: "Trip", role: "creator", members: 1 };
    const status = { folder: { id: "f1" }, members: [{ key: "k0", name: "Me", connected: true }] };
    const page = { status, folders: [album], requests: [], lastSync: Date.now() };
    focusOnArrival("f1");
    const host = document.createElement("div");
    render(albumHeader(page as never, album as never), host);
    document.body.append(host);
    await Promise.resolve();
    expect(document.activeElement).toBe(host.querySelector("h2"));
  });
});

describe("albumHeader for a removed album", () => {
  const status = {
    folder: { id: "f1" },
    members: [
      { key: "k0", name: "Me", connected: true },
      { key: "k1", name: "Anna", connected: true },
    ],
  };
  const render_ = (album: Record<string, unknown>) => {
    const host = document.createElement("div");
    const page = { status, folders: [album], requests: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    return { host, text: host.textContent?.replace(/\s+/g, " ") ?? "" };
  };
  const base = { id: "f1", name: "Trip", role: "reader", members: 2 };

  test("shows no connected, shared or updated line once removed", () => {
    const { host, text } = render_({ ...base, notice: { kind: "removed" } });
    expect(text).not.toContain("connected now");
    expect(text).not.toContain("shared with");
    expect(text).not.toContain("updated");
    expect(host.querySelector("[data-presence-dots]")).toBeNull();
    expect(text).toContain("You're no longer in Trip. You can still see the photos you have.");
  });

  test("still shows who is connected while in the album", () => {
    const { host, text } = render_(base);
    expect(text).toContain("1 connected now");
    expect(text).toContain("shared with 1 other");
    expect(host.querySelector("[data-presence-dots]")).not.toBeNull();
  });
});

describe("albumAddRow for a reader whose role is not known yet", () => {
  const album = {
    id: "f1",
    name: "Trip",
    role: "reader",
    members: 2,
    invite: { code: "c", owner: "o" },
  };
  const row = (status: unknown) => {
    const host = document.createElement("div");
    render(albumAddRow({ status, folders: [album] } as never, album as never), host);
    return { host, text: host.textContent?.replace(/\s+/g, " ").trim() };
  };

  test("says Getting your access…, with no Viewer text and no add button", () => {
    const { host, text } = row(null);
    expect(text).toBe("Getting your access…");
    expect(host.querySelector("button")).toBeNull();
  });

  test("shows the Viewer sentence once this phone is listed as a Viewer", () => {
    const status = {
      folder: { id: "f1" },
      members: [
        { name: "Me", admin: false, viewer: true },
        { name: "Maya", admin: true },
      ],
    };
    expect(row(status).text).toBe(
      "You can see every photo but not add any. Maya decides who can add photos.",
    );
  });
});

describe("albumAddRow for a pending album", () => {
  const album = { id: "f1", name: "Trip", role: "reader", pending: true, members: 2 };
  const text = (status: unknown) => {
    const host = document.createElement("div");
    render(albumAddRow({ status, folders: [album] } as never, album as never), host);
    return host.textContent?.replace(/\s+/g, " ").trim();
  };

  test("names the Admin once the member list has them", () => {
    const status = { folder: { id: "f1" }, members: [{ name: "Ada", admin: true }] };
    expect(text(status)).toBe("You can add photos once Ada lets you in.");
  });

  test("names the person who invited you when the status is for another album", () => {
    const status = { folder: { id: "f2" }, members: [{ name: "Ada", admin: true }] };
    expect(text(status)).toBe("You can add photos once the person who invited you lets you in.");
  });
});

describe("albumAddRow invite buttons while the Admin is alone", () => {
  const album = (role: string, members: number) => ({
    id: "f1",
    name: "Trip",
    role,
    members,
    invite: { code: "c", owner: "o" },
  });
  const statusOf = (id: string, role: string, withInvite = true) => ({
    name: "Nils",
    members: [],
    folder: {
      id,
      name: "Trip",
      role,
      members: 1,
      ...(withInvite ? { invite: { code: "c", owner: "o" } } : {}),
    },
  });
  const row = (a: ReturnType<typeof album>, status: unknown) => {
    const host = document.createElement("div");
    render(albumAddRow({ status, folders: [a] } as never, a as never), host);
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
    return { buttons, text: host.textContent?.replace(/\s+/g, " ") ?? "" };
  };
  const line = "Only you, until you invite someone.";

  test("a waiting request drops the alone line but keeps Copy and its hint slot", () => {
    const a = album("creator", 1);
    const host = document.createElement("div");
    render(
      albumAddRow({ status: statusOf("f1", "creator"), folders: [a] } as never, a as never, true),
      host,
    );
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toContain("Copy invite link");
    expect(host.textContent).not.toContain(line);
    expect(host.querySelector("[data-invite-hint] [data-copy-id]")).not.toBeNull();
  });

  test("alone creator gets the invite button after Add photos and one line", () => {
    const { buttons, text } = row(album("creator", 1), statusOf("f1", "creator"));
    expect(buttons.filter((b) => b === "Copy invite link")).toHaveLength(1);
    expect(buttons.indexOf("Copy invite link")).toBeGreaterThan(
      buttons.findIndex((b) => b?.includes("Add photos")),
    );
    expect(text.split(line)).toHaveLength(2);
  });

  test("with a second person there is no invite button", () => {
    const { buttons, text } = row(album("creator", 2), statusOf("f1", "creator"));
    expect(buttons).not.toContain("Copy invite link");
    expect(text).toContain("Only the 2 people in this album get them.");
  });

  test("status for another album or none: no button, line shown", () => {
    for (const status of [statusOf("other", "creator"), null]) {
      const { buttons, text } = row(album("creator", 1), status);
      expect(buttons).not.toContain("Copy invite link");
      expect(text).toContain(line);
    }
  });

  test("creator without an invite: no button", () => {
    const { buttons, text } = row(album("creator", 1), statusOf("f1", "creator", false));
    expect(buttons).not.toContain("Copy invite link");
    expect(text).toContain(line);
  });

  test("Collaborator whose list still counts one: no invite button, line kept", () => {
    const { buttons, text } = row(album("member", 1), statusOf("f1", "member"));
    expect(buttons).not.toContain("Copy invite link");
    expect(text).toContain(line);
  });

  test("buttons come from the open album's status, not the list entry", () => {
    const { invite: _invite, ...listEntry } = album("creator", 1);
    const { buttons } = row(listEntry as never, statusOf("f1", "creator"));
    expect(buttons).toContain("Copy invite link");
  });

  test("reader alone: no invite button", () => {
    const { buttons } = row(album("reader", 1), statusOf("f1", "reader"));
    expect(buttons).not.toContain("Copy invite link");
  });
});

describe("requestLineText", () => {
  const say = (name: string, friends: Record<string, string>, waiting = 1) => {
    const host = document.createElement("div");
    const row = requestRowOf({ folderId: "f1", requesterName: name } as never, friends);
    render(requestLineText(row, waiting), host);
    return host.textContent?.replace(/\s+/g, " ") ?? "";
  };

  test("one asker is named", () => {
    expect(say("Ben", {})).toBe("Ben wants to join");
  });

  test("a name that copies a friend is hidden", () => {
    const text = say(" mum ", { id1: "Mum" });
    expect(text).toBe("Someone not in your friends wants to join");
    expect(text.toLowerCase()).not.toContain("mum");
  });

  test("several askers are counted, not named", () => {
    expect(say("Mum", { id1: "Mum" }, 2)).toBe("2 people want to join");
  });
});

describe("albumHeader join request line", () => {
  const album = { id: "f1", name: "Trip", role: "creator", members: 1 };
  const alone = { folder: { id: "f1" }, members: [{ key: "k0", name: "Me", connected: true }] };
  const ask = { folderId: "f1", folderName: "Trip", requesterName: "Ben" };
  const draw_ = (over: {
    album?: Record<string, unknown>;
    status?: unknown;
    requests?: unknown[];
  }) => {
    const a = over.album ?? album;
    const host = document.createElement("div");
    const page = {
      status: "status" in over ? over.status : alone,
      folders: [a],
      requests: over.requests ?? [ask],
      lastSync: Date.now(),
    };
    render(albumHeader(page as never, a as never), host);
    return { host, text: host.textContent?.replace(/\s+/g, " ") ?? "" };
  };

  test("the Admin sees who wants to join and a Review link, not the alone line", () => {
    const { host, text } = draw_({});
    expect(text).toContain("Ben wants to join");
    expect(text).not.toContain("Only you so far");
    const link = host.querySelector("[data-request-line] a");
    expect(link?.textContent).toBe("Review");
    expect(link?.getAttribute("href")).toBe("/sharing/f1");
  });

  test("the line shows without a sync status", () => {
    expect(draw_({ status: null }).text).toContain("Ben wants to join");
  });

  test("names the oldest request of this album only", () => {
    const other = { ...ask, folderId: "f2", requesterName: "Zed" };
    const second = { ...ask, requesterName: "Cy" };
    const { text } = draw_({ requests: [other, ask, second] });
    expect(text).toContain("2 people want to join");
    expect(text).not.toContain("Zed");
  });

  test("a waiting request keeps the line about the other people", () => {
    const { text } = draw_({ album: { ...album, members: 3 }, status: null });
    expect(text).toContain("Only the 3 people");
  });

  test("a waiting request hides the alone line", () => {
    const { text } = draw_({ album: { ...album, members: 1 }, status: null });
    expect(text).not.toContain("Only you, until you invite someone.");
  });

  test("a request for another album changes nothing", () => {
    const { host, text } = draw_({ requests: [{ ...ask, folderId: "f2" }] });
    expect(host.querySelector("[data-request-line]")).toBeNull();
    expect(text).toContain("Only you so far");
  });

  test("a reader sees no request line", () => {
    const { host, text } = draw_({ album: { ...album, role: "reader" } });
    expect(host.querySelector("[data-request-line]")).toBeNull();
    expect(text).toContain("Only you so far");
  });

  test("a removed album shows no request line", () => {
    const { host } = draw_({ album: { ...album, notice: { kind: "removed" } } });
    expect(host.querySelector("[data-request-line]")).toBeNull();
  });

  test("with no request the usual presence line shows", () => {
    expect(draw_({ requests: [] }).text).toContain("Only you so far");
  });
});
