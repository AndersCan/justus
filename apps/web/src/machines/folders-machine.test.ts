import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import {
  $folders,
  $activeFolderId,
  $foldersState,
  $foldersError,
  folders,
} from "./folders-machine";
import { gateway } from "../gateway";

// The mocked gateway is loosely typed so test fixtures don't have to satisfy
// the full FolderSummary/Photo/Either shapes.
const mock = gateway as any;

vi.mock("../gateway", () => {
  const g = {
    list: vi.fn(),
    add: vi.fn(),
    addFile: vi.fn(),
    remove: vi.fn(),
    join: vi.fn(),
    enroll: vi.fn(),
    status: vi.fn(),
    folders: vi.fn(),
    createFolder: vi.fn(),
    setActive: vi.fn(),
    setName: vi.fn(),
    requests: vi.fn(),
    respond: vi.fn(),
    logs: { view: vi.fn(), clear: vi.fn() },
  };
  return { gateway: g };
});

const folder = (id: string, name: string) => ({ id, name });

beforeEach(() => {
  // The backend returns `activeFolderId: null` for a fresh device with no
  // folder chosen yet — the machine must reach "ok", not "error", in that case.
  mock.folders.mockReset().mockResolvedValue([null, { folders: [], activeFolderId: null }]);
  mock.createFolder.mockReset().mockResolvedValue([null, { folder: folder("f2", "New") }]);
  mock.setActive.mockReset().mockResolvedValue([null, { folder: folder("f1", "Trip") }]);
  mock.setName.mockReset().mockResolvedValue([null, { name: "Renamed" }]);
  $folders.set([]);
  $activeFolderId.set(null);
  $foldersError.set(null);
});

describe("folders machine", () => {
  test("refresh loads the folder list and the active folder id", async () => {
    mock.folders.mockResolvedValue([
      null,
      { folders: [folder("f1", "Trip")], activeFolderId: "f1" },
    ]);
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));
    expect($folders.get().map((f) => f.id)).toContain("f1");
    expect($activeFolderId.get()).toBe("f1");
  });

  test("create appends the folder and makes it the active folder", async () => {
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));

    folders.create("New");
    await vi.waitFor(() => expect($activeFolderId.get()).toBe("f2"));

    expect($foldersState.get()).toBe("ok");
    expect($folders.get().map((f) => f.id)).toContain("f2");
  });

  test("setActive switches the active folder", async () => {
    mock.folders.mockResolvedValue([
      null,
      { folders: [folder("f1", "Trip")], activeFolderId: "f1" },
    ]);
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));

    folders.switchTo("f1");
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));
    expect($activeFolderId.get()).toBe("f1");
  });

  test("a create failure surfaces an error and returns to ok (no unhandled rejection)", async () => {
    mock.createFolder.mockResolvedValue([new Error("folder denied"), null]);
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));

    folders.create("X");
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));

    expect($foldersError.get()).toMatch(/denied/i);
    expect($folders.get().map((f) => f.id)).not.toContain("f2");
  });
});
