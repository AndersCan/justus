// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { VirtualClock } from "@mantaq/core";
import { createGalleryActor } from "../machines/gallery-machine";
import { missingAlbumText, scopePhotos, viewerLine } from "./gallery";
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
      [...host.querySelectorAll<HTMLElement>("[data-motion-key]")].map((el) => [
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
      "You're a Viewer: you see every photo here. Maya decides who adds photos.",
    );
  });

  test("says The Admin when the status is for another album or missing", () => {
    const line = "You're a Viewer: you see every photo here. The Admin decides who adds photos.";
    expect(viewerLine({ status }, { id: "f2" })).toBe(line);
    expect(viewerLine({ status: null }, { id: "f1" })).toBe(line);
  });
});
