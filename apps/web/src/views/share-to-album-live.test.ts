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

import { createAndAdd, sharedPhotosSheet } from "./share-to-album";

afterEach(() => {
  vi.clearAllMocks();
  m.view = { asking: true, batches: [], count: 2 };
  m.vm = { state: "showingAlbums", fatal: false, folders: [] };
});

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
});
