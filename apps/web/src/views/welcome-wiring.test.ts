import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const route = vi.hoisted(() => ({ current: "welcome" as string | undefined }));
const open = vi.hoisted(() => vi.fn());
const folderList = vi.hoisted(() => vi.fn());

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    lock: { status: vi.fn(), setEnabled: vi.fn() },
    setName: vi.fn(),
    folders: folderList,
  },
}));
vi.mock("../machines/router-machine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../machines/router-machine")>()),
  currentPage: () => (route.current ? { route: route.current } : undefined),
  open,
}));

import { foldersActor, folders, nameSeen } from "../machines/folders-machine";
import "./welcome";

const album = { id: "a1", name: "M" };

beforeEach(() => {
  open.mockClear();
  route.current = "welcome";
});

describe("welcome listener", () => {
  it("keeps the intro on a first run, even though the worklet made up a name", async () => {
    folderList.mockResolvedValue([null, { folders: [], activeFolderId: null }]);
    foldersActor.send(nameSeen.create({ name: "Device-12345" }));
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).not.toBe("albumsNotLoaded"));
    expect(open).not.toHaveBeenCalled();
  });

  it("skips the intro when the phone already has an album", async () => {
    folderList.mockResolvedValue([null, { folders: [album], activeFolderId: "a1" }]);
    folders.refresh();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("/", { replace: true }));
  });
});
