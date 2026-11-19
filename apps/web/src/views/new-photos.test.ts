import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Fn = () => void;
const fake = <T>(state: T) => {
  const fns: Fn[] = [];
  return {
    state,
    snapshot: () => state,
    on: (_: string, o: { fn: Fn }) => fns.push(o.fn),
    change: () => fns.forEach((fn) => fn()),
  };
};
const h = vi.hoisted(() => ({
  listed: vi.fn(),
  opened: vi.fn(),
  ended: vi.fn(),
  pageFns: [] as (() => void)[],
  page: undefined as unknown,
}));
const seenA = fake({ context: { status: "ready", known: {} as Record<string, string[]> } });
const galleryA = fake({
  settled: false,
  context: { photos: [] as { id: string; folderId: string }[] },
});
const foldersA = fake({
  settled: true,
  context: { folders: [] as { id: string; notice?: { kind: string } }[] },
});

vi.mock("../machines/seen-machine", () => ({
  seen: { albumsListed: h.listed, albumOpened: h.opened, visitEnded: h.ended },
  seenActor: seenA,
  seenReady: (s: { context: { status: string } }) => s.context.status,
}));
vi.mock("../machines/gallery-machine", () => ({
  galleryActor: galleryA,
  galleryViewModel: (s: { settled: boolean }) => ({ settled: s.settled }),
}));
vi.mock("../machines/folders-machine", () => ({
  foldersActor: foldersA,
  foldersViewModel: (s: { settled: boolean }) => ({ settled: s.settled }),
}));
vi.mock("../machines/router-machine", () => ({
  currentPage: () => h.page,
  onPageChange: (fn: () => void) => h.pageFns.push(fn),
}));
vi.mock("./looked-at", () => ({ flushLooked: vi.fn() }));

await import("./new-photos");

beforeEach(() => {
  h.listed.mockClear();
  h.opened.mockClear();
  h.page = undefined;
  seenA.state.context.known = {};
  galleryA.state.settled = false;
  galleryA.state.context.photos = [];
  foldersA.state.context.folders = [];
});

describe("first listing of an album", () => {
  it("waits for the gallery to settle, then records only unknown albums with photos", () => {
    foldersA.state.context.folders = [{ id: "f1" }, { id: "f2" }, { id: "f3" }];
    seenA.state.context.known = { f2: ["x"] };
    galleryA.state.context.photos = [
      { id: "a", folderId: "f1" },
      { id: "x", folderId: "f2" },
      { id: "y", folderId: "f2" },
    ];
    galleryA.change();
    expect(h.listed).not.toHaveBeenCalled();
    galleryA.state.settled = true;
    galleryA.change();
    expect(h.listed).toHaveBeenCalledTimes(1);
    expect(h.listed).toHaveBeenCalledWith([{ albumId: "f1", photoIds: ["a"] }]);
  });

  it("sends nothing when every unknown album is empty", () => {
    foldersA.state.context.folders = [{ id: "f1" }];
    galleryA.state.settled = true;
    galleryA.change();
    expect(h.listed).not.toHaveBeenCalled();
  });
});

describe("last album", () => {
  it("remembers the album page on screen, once per visit, not a removed one", () => {
    foldersA.state.context.folders = [{ id: "f1" }, { id: "f2", notice: { kind: "removed" } }];
    galleryA.state.context.photos = [
      { id: "a", folderId: "f1" },
      { id: "z", folderId: "f2" },
    ];
    h.page = { route: "photoAlbum", params: { id: "f2" } };
    h.pageFns.forEach((fn) => fn());
    expect(h.opened).not.toHaveBeenCalled();
    h.page = { route: "photoAlbum", params: { id: "f1" } };
    h.pageFns.forEach((fn) => fn());
    expect(h.opened).not.toHaveBeenCalled();
    galleryA.state.settled = true;
    h.pageFns.forEach((fn) => fn());
    seenA.change();
    expect(h.opened).toHaveBeenCalledTimes(1);
    expect(h.opened).toHaveBeenCalledWith("f1", ["a"]);
  });
});

describe("visit", () => {
  it("leaving the page ends the visit", () => {
    h.ended.mockClear();
    h.pageFns.forEach((fn) => fn());
    expect(h.ended).toHaveBeenCalledTimes(1);
  });
});
