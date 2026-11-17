// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { decideLanding, type LandingInput } from "./landing";

const base: LandingInput = {
  appStart: true,
  route: "gallery",
  seen: "ready",
  lastAlbum: "f1",
  foldersSettled: true,
  folders: [{ id: "f1" }],
  inviteOpen: false,
};
const decide = (o: Partial<LandingInput>) => decideLanding({ ...base, ...o });

describe("decideLanding", () => {
  test("opens the last album on a phone start", () => {
    expect(decide({})).toEqual({ kind: "open", albumId: "f1" });
  });
  test("a browser start stays", () => {
    expect(decide({ appStart: false, seen: "reading" })).toEqual({ kind: "stay" });
  });
  test("waits while the seen file is read", () => {
    expect(decide({ seen: "reading" })).toEqual({ kind: "wait" });
  });
  test("an unreadable file or no last album stays", () => {
    expect(decide({ seen: "unreadable" })).toEqual({ kind: "stay" });
    expect(decide({ lastAlbum: undefined })).toEqual({ kind: "stay" });
  });
  test("waits on the welcome page, then opens once on the gallery", () => {
    expect(decide({ route: "welcome" })).toEqual({ kind: "wait" });
    expect(decide({ route: "gallery" })).toEqual({ kind: "open", albumId: "f1" });
  });
  test("another page stays, including the join page", () => {
    expect(decide({ route: "sharingJoin" })).toEqual({ kind: "stay" });
    expect(decide({ route: "settings" })).toEqual({ kind: "stay" });
    expect(decide({ route: undefined })).toEqual({ kind: "stay" });
  });
  test("an open invite stays", () => {
    expect(decide({ inviteOpen: true })).toEqual({ kind: "stay" });
  });
  test("waits until the album list is settled", () => {
    expect(decide({ foldersSettled: false })).toEqual({ kind: "wait" });
  });
  test("an album that is gone from the list is forgotten", () => {
    expect(decide({ folders: [{ id: "f2" }] })).toEqual({ kind: "forget" });
  });
  test("an album with a removed notice is forgotten", () => {
    const folders = [{ id: "f1", notice: { kind: "removed" } }] as LandingInput["folders"];
    expect(decide({ folders })).toEqual({ kind: "forget" });
  });
});

const mock = vi.hoisted(() => ({
  folders: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    folders: mock.folders,
    seen: { read: mock.read, write: mock.write },
    requests: vi.fn(async () => [null, { requests: [] }]),
    status: vi.fn(async () => [null, {}]),
    logs: { view: vi.fn(), clear: vi.fn() },
  },
}));

async function start(path: string, appStart: boolean, lastAlbum: string, ids: string[]) {
  vi.resetModules();
  history.replaceState(null, "", path);
  mock.read.mockResolvedValue([null, { seen: { version: 1, known: {}, lastAlbum } }]);
  mock.write.mockResolvedValue([null, {}]);
  mock.folders.mockResolvedValue([
    null,
    {
      folders: ids.map((id) => ({ id, name: id, kind: "owned" })),
      activeId: null,
    },
  ]);
  const { foldersActor } = await import("../machines/folders-machine");
  const { folders } = await import("../machines/folders-machine");
  const { landOnLastAlbum } = await import("./landing");
  landOnLastAlbum({ appStart });
  folders.refresh();
  await vi.waitFor(() => expect(foldersActor.snapshot().context.folders.length).toBe(ids.length));
  await new Promise((r) => setTimeout(r, 20));
}

describe("landOnLastAlbum", () => {
  test("a phone start replaces / with the last album", async () => {
    const before = history.length;
    await start("/", true, "f1", ["f1"]);
    expect(location.pathname).toBe("/albums/f1");
    expect(history.length).toBe(before);
  });
  test("a browser start stays on /", async () => {
    await start("/", false, "f1", ["f1"]);
    expect(location.pathname).toBe("/");
  });
  test("a gone album is forgotten without a word", async () => {
    await start("/", true, "f9", ["f1"]);
    expect(location.pathname).toBe("/");
    expect(mock.write).toHaveBeenCalledWith({ version: 1, known: {} });
    expect(document.querySelector('[data-copy-id="gallery.this_album_isn_t_on"]')).toBeNull();
  });
});
