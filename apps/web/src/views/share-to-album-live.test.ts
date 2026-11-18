// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";

const m = vi.hoisted(() => ({
  view: { asking: true, batches: [] as unknown[], count: 2 },
  vm: { state: "showingAlbums", fatal: false as unknown, folders: [] as unknown[] },
  notNow: vi.fn(),
  addableAlbum: vi.fn(),
  addPicked: vi.fn(),
  startAlbum: vi.fn(),
  actor: { snapshot: () => ({}), on: () => () => {} },
}));
vi.mock("../machines/folders-machine", async (orig) => ({
  ...(await orig<typeof import("../machines/folders-machine")>()),
  foldersViewModel: () => m.vm,
}));
vi.mock("../machines/shared-photos-machine", () => ({
  sharedPhotos: { addStarted: vi.fn(), notNow: m.notNow },
  sharedPhotosActor: m.actor,
  sharedPhotosViewOf: () => m.view,
}));
vi.mock("./photo-picker", () => ({ addableAlbum: m.addableAlbum, addPicked: m.addPicked }));
vi.mock("./start-album", () => ({ startAlbum: m.startAlbum }));

import { copy } from "../copy/copy";
import { pickedPhotos, pickedPhotosActor } from "../machines/picked-photos-machine";
import { addPickedTo, albumSheet, createAndAdd, sharedPhotosSheet } from "./share-to-album";

afterEach(() => {
  pickedPhotos.cancel();
  vi.clearAllMocks();
  m.view = { asking: true, batches: [], count: 2 };
  m.vm = { state: "showingAlbums", fatal: false, folders: [] };
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function draw() {
  const host = document.createElement("div");
  render(sharedPhotosSheet(), host);
  return host;
}
const folder = { id: "s", name: "Summer", role: "creator", members: 1, addedAt: 0 };

describe("the live sheet", () => {
  test("nothing while the machine is not asking", () => {
    m.view = { ...m.view, asking: false };
    expect(draw().querySelector("dialog")).toBeNull();
  });

  test("albums not loaded yet, or loading: Loading…", () => {
    for (const state of ["albumsNotLoaded", "loadingAlbums"]) {
      m.vm = { ...m.vm, state };
      expect(draw().querySelector("[role=status]")?.textContent).toBe("Loading…");
    }
  });

  test("could not load, or fatal: the albums-not-read line", () => {
    m.vm = { ...m.vm, state: "couldNotLoadAlbums" };
    expect(draw().textContent).toContain("Your albums could not be read.");
    m.vm = { state: "showingAlbums", fatal: { message: "x" }, folders: [folder] };
    expect(draw().textContent).toContain("Your albums could not be read.");
  });

  test("listed: one row per addable album, named with the machine's count", () => {
    m.vm = { ...m.vm, folders: [folder] };
    const row = draw().querySelector("li button");
    expect(row?.getAttribute("aria-label")).toBe("Add 2 photos to Summer");
  });

  test("Not now tells the machine", () => {
    m.vm = { ...m.vm, folders: [folder] };
    draw().querySelector<HTMLButtonElement>("[data-dismiss]")!.click();
    expect(m.notNow).toHaveBeenCalledTimes(1);
  });

  test("a row adds to its album", () => {
    m.vm = { ...m.vm, folders: [folder] };
    m.addableAlbum.mockReturnValue(null);
    draw().querySelector<HTMLButtonElement>("li button")!.click();
    expect(m.addableAlbum).toHaveBeenCalledWith("s");
  });

  test("Create album asks for a name", () => {
    m.startAlbum.mockResolvedValue(null);
    draw().querySelector<HTMLButtonElement>(".ui-btn-primary")!.click();
    expect(m.startAlbum).toHaveBeenCalledTimes(1);
  });

  test("one shared photo: the name sheet says it goes into it", async () => {
    m.view = { ...m.view, count: 1 };
    m.startAlbum.mockResolvedValue(null);
    await createAndAdd();
    expect(m.startAlbum.mock.calls[0]![0]).toBe(
      "Start one per trip, family or event. The 1 photo goes into it.",
    );
  });

  describe("photos picked in the app", () => {
    const picks = ["c", "a", "b"].map((name) => ({ kind: "path" as const, name, path: name }));
    const drawOne = () => {
      const host = document.createElement("div");
      render(albumSheet(), host);
      return host;
    };

    test("the pick's sheet shows while the share sheet also asks: one dialog, the pick's count", () => {
      m.vm = { ...m.vm, folders: [folder] };
      pickedPhotos.picked(picks);
      const host = drawOne();
      expect(host.querySelectorAll("dialog")).toHaveLength(1);
      expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe("Add 3 photos to");
    });

    test("no pick: the share sheet shows", () => {
      const host = drawOne();
      expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe("Add 2 photos to");
    });

    test("neither asking: no dialog", () => {
      m.view = { ...m.view, asking: false };
      expect(drawOne().querySelector("dialog")).toBeNull();
    });

    test("Not now on the pick's sheet drops the pick, not the share", () => {
      m.vm = { ...m.vm, folders: [folder] };
      pickedPhotos.picked(picks);
      drawOne().querySelector<HTMLButtonElement>("[data-dismiss]")!.click();
      expect(pickedPhotosActor.snapshot().context.photos).toEqual([]);
      expect(m.notNow).not.toHaveBeenCalled();
    });

    test("an album adds the pick in picked order, and the pick is let go", () => {
      pickedPhotos.picked(picks);
      m.addableAlbum.mockReturnValue("s");
      m.addPicked.mockReturnValue(true);
      addPickedTo("s");
      expect(m.addPicked).toHaveBeenCalledWith("s", picks, "library");
      expect(pickedPhotosActor.snapshot().context.photos).toEqual([]);
    });

    test("an add that does not start keeps the pick", () => {
      pickedPhotos.picked(picks);
      m.addableAlbum.mockReturnValue("s");
      m.addPicked.mockReturnValue(false);
      addPickedTo("s");
      expect(pickedPhotosActor.snapshot().context.photos).toEqual(picks);
    });

    test("an album she cannot add to adds nothing", () => {
      pickedPhotos.picked(picks);
      m.addableAlbum.mockReturnValue(null);
      addPickedTo("s");
      expect(m.addPicked).not.toHaveBeenCalled();
    });

    test("closing the pick's sheet opens the waiting share sheet as a fresh, open dialog", async () => {
      pickedPhotos.picked(picks);
      const host = document.createElement("div");
      document.body.append(host);
      render(albumSheet(), host);
      await tick();
      const first = host.querySelector("dialog")!;
      expect(first.open).toBe(true);
      host.querySelector<HTMLButtonElement>("[data-dismiss]")!.click();
      await tick();
      const dialogs = host.querySelectorAll("dialog");
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]).not.toBe(first);
      expect(dialogs[0]!.getAttribute("aria-label")).toBe(
        copy("share_to_album.add_photos_to", { count: 2 }),
      );
      expect(dialogs[0]!.open).toBe(true);
      host.remove();
    });

    test("Create album on the pick's sheet (every row gone) starts an album and adds the pick to it", async () => {
      m.view = { ...m.view, asking: false };
      pickedPhotos.picked(picks);
      m.startAlbum.mockResolvedValue("new");
      m.addableAlbum.mockReturnValue("new");
      m.addPicked.mockReturnValue(true);
      const create = [...drawOne().querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === copy("start_album.create_album"),
      );
      create!.click();
      await tick();
      expect(m.startAlbum).toHaveBeenCalledOnce();
      expect(m.addPicked).toHaveBeenCalledWith("new", picks, "library");
      expect(pickedPhotosActor.snapshot().context.photos).toEqual([]);
    });
  });
});
