// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary, SharedBatch } from "@justus/core";

const mocks = vi.hoisted(() => ({
  addableAlbum: vi.fn(),
  addPicked: vi.fn(),
  startAlbum: vi.fn(),
  open: vi.fn(),
  addStarted: vi.fn(),
  notNow: vi.fn(),
  batches: [] as SharedBatch[],
}));
vi.mock("./photo-picker", () => ({
  addableAlbum: mocks.addableAlbum,
  addPicked: mocks.addPicked,
}));
vi.mock("./start-album", () => ({ startAlbum: mocks.startAlbum }));
vi.mock("../machines/router-machine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../machines/router-machine")>()),
  open: mocks.open,
}));
vi.mock("../machines/shared-photos-machine", () => ({
  sharedPhotos: { addStarted: mocks.addStarted, notNow: mocks.notNow },
  sharedPhotosActor: { snapshot: () => ({}) },
  sharedPhotosViewOf: () => ({ asking: true, batches: mocks.batches, count: 3 }),
}));

import { addableAlbums, addToAlbum, createAndAdd, shareSheetPanel } from "./share-to-album";

afterEach(() => vi.clearAllMocks());

function folder(id: string, over: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    name: id,
    role: "creator",
    shareKey: "k",
    driveKey: "d",
    members: 3,
    addedAt: 0,
    ...over,
  } as FolderSummary;
}

const on = { add: vi.fn(), create: vi.fn(), notNow: vi.fn() };

function draw(v: Parameters<typeof shareSheetPanel>[0]) {
  const host = document.createElement("div");
  render(shareSheetPanel(v, on), host);
  return host;
}
const buttons = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("button")).map((b) => b.textContent?.trim());

describe("addableAlbums", () => {
  test("creator and member in; pending, reader and removed out; order kept", () => {
    const albums = [
      folder("b"),
      folder("pending", { role: "member", pending: true } as never),
      folder("a", { role: "member" } as never),
      folder("viewer", { role: "reader" }),
      folder("gone", { notice: { kind: "removed" } as never }),
    ];
    expect(addableAlbums(albums).map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("shareSheetPanel", () => {
  test("two albums: heading, one named button per album, first focused, no Create album", () => {
    const host = draw({ count: 3, albums: [folder("Summer"), folder("Home")] });
    expect(host.querySelector("h3")?.textContent).toBe("Add 3 photos to");
    const rows = host.querySelectorAll("li button");
    expect(rows[0]?.getAttribute("aria-label")).toBe("Add 3 photos to Summer");
    expect(rows[1]?.getAttribute("aria-label")).toBe("Add 3 photos to Home");
    expect(rows[0]?.textContent).toContain("Yours · 3 members");
    expect(rows[0]?.hasAttribute("autofocus")).toBe(true);
    expect(rows[1]?.hasAttribute("autofocus")).toBe(false);
    expect(buttons(host)).not.toContain("Create album");
    expect(rows[0]?.querySelector("span")?.classList.contains("truncate")).toBe(true);
  });

  test("one photo reads singular", () => {
    const host = draw({ count: 1, albums: [folder("Summer")] });
    expect(host.querySelector("h3")?.textContent).toBe("Add 1 photo to");
  });

  test("no album to add to: one line and Create album", () => {
    const host = draw({ count: 3, albums: [] });
    expect(host.textContent).toContain("No album you can add to");
    expect(buttons(host)).toEqual(["Not now", "Create album"]);
  });

  test("loading and failed offer only Not now", () => {
    const loading = draw({ count: 3, albums: "loading" });
    expect(loading.querySelector("[role=status]")?.textContent).toBe("Loading…");
    expect(buttons(loading)).toEqual(["Not now"]);
    const failed = draw({ count: 3, albums: "failed" });
    expect(failed.textContent).toContain("Your albums could not be read.");
    expect(buttons(failed)).toEqual(["Not now"]);
  });

  test("clicks call add, create and notNow; Not now is the dismiss button", () => {
    const host = draw({ count: 3, albums: [folder("x")] });
    host.querySelector<HTMLButtonElement>("li button")!.click();
    expect(on.add).toHaveBeenCalledWith("x");
    const none = draw({ count: 3, albums: [] });
    none.querySelector<HTMLButtonElement>(".ui-btn-primary")!.click();
    expect(on.create).toHaveBeenCalledTimes(1);
    const ghost = none.querySelector<HTMLButtonElement>("[data-dismiss]")!;
    ghost.click();
    expect(on.notNow).toHaveBeenCalledTimes(1);
  });
});

describe("the live sheet's actions", () => {
  const photo = {
    path: "/p/a.jpg",
    name: "a.jpg",
    original: "/o/a.jpg",
    thumb: "/t/a.jpg",
    takenAt: "2026-01-05",
    type: "image/jpeg",
    url: "u",
  };
  mocks.batches = [
    { id: "1", receivedAt: "", photos: [photo] },
    { id: "2", receivedAt: "", photos: [{ ...photo, path: "/p/b.jpg" }, photo] },
  ];

  test("a refused album starts nothing", () => {
    mocks.addableAlbum.mockReturnValue(null);
    addToAlbum("f1");
    expect(mocks.addPicked).not.toHaveBeenCalled();
    expect(mocks.addStarted).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  test("a refused add does not tell the machine or navigate", () => {
    mocks.addableAlbum.mockReturnValue("f1");
    mocks.addPicked.mockReturnValue(false);
    addToAlbum("f1");
    expect(mocks.addStarted).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  test("a taken add sends every photo of every batch, then opens the album", () => {
    mocks.addableAlbum.mockReturnValue("f1");
    mocks.addPicked.mockReturnValue(true);
    addToAlbum("f1");
    const [folderId, sources, via] = mocks.addPicked.mock.calls[0]!;
    expect(folderId).toBe("f1");
    expect(via).toBe("shared");
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({
      kind: "path",
      path: "/p/a.jpg",
      name: "a.jpg",
      original: "/o/a.jpg",
      thumb: "/t/a.jpg",
      takenAt: "2026-01-05",
    });
    expect(mocks.addStarted).toHaveBeenCalledWith("f1");
    expect(mocks.open).toHaveBeenCalledWith("/albums/f1");
  });

  test("a new album takes the photos; a cancelled name adds nothing", async () => {
    mocks.addableAlbum.mockReturnValue("new-id");
    mocks.addPicked.mockReturnValue(true);
    mocks.startAlbum.mockResolvedValueOnce("new-id");
    await createAndAdd();
    expect(mocks.startAlbum.mock.calls[0]![0]).toBe(
      "Start one per trip, family or event. The 3 photos go into it.",
    );
    expect(mocks.addStarted).toHaveBeenCalledWith("new-id");
    vi.clearAllMocks();
    mocks.startAlbum.mockResolvedValueOnce(null);
    await createAndAdd();
    expect(mocks.addPicked).not.toHaveBeenCalled();
  });
});
