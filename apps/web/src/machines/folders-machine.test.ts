import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import {
  $asks,
  $folders,
  $activeFolderId,
  $foldersState,
  $foldersError,
  $userName,
  folders,
} from "./folders-machine";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { createFoldersActor } from "./folders-machine";
import { gateway } from "../gateway";
import { $syncStatus } from "./sync-machine";

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
    ask: vi.fn(),
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

  test("refresh also loads the asks, and treats a missing list as none", async () => {
    const ask = { code: "c", status: "waiting" };
    mock.folders.mockResolvedValue([null, { folders: [], activeFolderId: null, asks: [ask] }]);
    folders.refresh();
    await vi.waitFor(() => expect($asks.get()).toEqual([ask]));

    mock.folders.mockResolvedValue([null, { folders: [], activeFolderId: null }]);
    folders.refresh();
    await vi.waitFor(() => expect($asks.get()).toEqual([]));
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

  test("switching publishes the returned status to $syncStatus", async () => {
    const status = { folder: { id: "f1", name: "Trip" }, name: "Ann" };
    mock.setActive.mockResolvedValue([null, status]);
    $syncStatus.set(null as any);
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));

    folders.switchTo("f1");
    await vi.waitFor(() => expect($syncStatus.get()).toEqual(status));
    expect($activeFolderId.get()).toBe("f1");
  });

  test("renaming publishes the saved name to $userName", async () => {
    $userName.set("");
    folders.refresh();
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));

    folders.rename("Renamed");
    await vi.waitFor(() => expect($userName.get()).toBe("Renamed"));
  });

  test("a retry after a failed refresh clears $foldersError", async () => {
    mock.folders.mockResolvedValueOnce([new Error("offline"), null]);
    folders.refresh();
    await vi.waitFor(() => expect($foldersError.get()).toBe("offline"));

    folders.retry();
    await vi.waitFor(() => expect($foldersError.get()).toBeNull());
    await vi.waitFor(() => expect($foldersState.get()).toBe("ok"));
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

describe("folders factory", () => {
  const send = (actor: ReturnType<typeof createFoldersActor>, type: string, payload?: unknown) =>
    (actor as any).send({ type, payload });

  function build(port: Record<string, unknown> = {}) {
    const gw = {
      folders: vi.fn().mockResolvedValue([null, { folders: [], activeFolderId: null }]),
      createFolder: vi.fn().mockResolvedValue([null, { folder: folder("f2", "New") }]),
      setActive: vi.fn().mockResolvedValue([null, { folder: folder("f1", "Trip") }]),
      setName: vi.fn().mockResolvedValue([null, { name: "Renamed" }]),
      ...port,
    };
    const actor = createFoldersActor({ clock: VirtualClock(), gateway: gw as any });
    const outputs: { type: string; payload: unknown }[] = [];
    onOutput(actor, (e) => outputs.push(e as any));
    return { actor, outputs, gw };
  }
  const ctx = (actor: ReturnType<typeof createFoldersActor>) => actor.snapshot().context;
  const path = (actor: ReturnType<typeof createFoldersActor>) => actor.snapshot().path[0];

  async function loaded(port: Record<string, unknown> = {}) {
    const built = build({
      folders: vi
        .fn()
        .mockResolvedValue([null, { folders: [folder("f1", "Trip")], activeFolderId: "f1" }]),
      ...port,
    });
    send(built.actor, "REFRESH");
    await vi.waitFor(() => expect(path(built.actor)).toBe("ok"));
    return built;
  }

  test("refresh loads the folders and active id into context", async () => {
    const { actor } = await loaded();
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f1"]);
    expect(ctx(actor).activeId).toBe("f1");
    expect(ctx(actor).error).toBeNull();
  });

  test("refresh with no active folder still reaches ok", async () => {
    const { actor } = build();
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(path(actor)).toBe("ok"));
    expect(ctx(actor).activeId).toBeNull();
  });

  test("a failed refresh sets the error and retry reloads", async () => {
    const fail = vi.fn().mockResolvedValueOnce([new Error("offline"), null]);
    const { actor } = build({ folders: fail });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(path(actor)).toBe("error"));
    expect(ctx(actor).error).toBe("offline");
    fail.mockResolvedValue([null, { folders: [], activeFolderId: null }]);
    send(actor, "RETRY");
    await vi.waitFor(() => expect(path(actor)).toBe("ok"));
    expect(ctx(actor).error).toBeNull();
  });

  test("create prepends the folder and activates it", async () => {
    const { actor, gw } = await loaded();
    send(actor, "CREATE_FOLDER", { name: "New" });
    await vi.waitFor(() => expect(ctx(actor).activeId).toBe("f2"));
    expect(path(actor)).toBe("ok");
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(gw.createFolder).toHaveBeenCalledWith("New");
  });

  test("a failed create keeps the list and sets the error", async () => {
    const { actor } = await loaded({
      createFolder: vi.fn().mockResolvedValue([new Error("denied"), null]),
    });
    send(actor, "CREATE_FOLDER", { name: "X" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("denied"));
    expect(path(actor)).toBe("ok");
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f1"]);
  });

  test("switch emits switchedTo with the new status", async () => {
    const status = { folder: { id: "f3" }, name: "Ann" };
    const { actor, outputs, gw } = await loaded({
      setActive: vi.fn().mockResolvedValue([null, status]),
    });
    send(actor, "SET_ACTIVE", { folderId: "f3" });
    await vi.waitFor(() => expect(outputs.map((o) => o.type)).toEqual(["SWITCHED_TO"]));
    expect(outputs[0]!.payload).toEqual({ status });
    expect(ctx(actor).activeId).toBe("f3");
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f1"]);
    expect(gw.setActive).toHaveBeenCalledWith("f3");
  });

  test("a failed switch keeps the active folder, emits nothing and sets the error", async () => {
    const { actor, outputs } = await loaded({
      setActive: vi.fn().mockResolvedValue([new Error("gone"), null]),
    });
    send(actor, "SET_ACTIVE", { folderId: "f3" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("gone"));
    expect(ctx(actor).activeId).toBe("f1");
    expect(outputs).toEqual([]);
  });

  test("rename emits renamed with the saved name", async () => {
    const { actor, outputs } = await loaded();
    send(actor, "SET_NAME", { name: "Me" });
    await vi.waitFor(() => expect(outputs.map((o) => o.type)).toEqual(["RENAMED"]));
    expect(outputs[0]!.payload).toEqual({ name: "Renamed" });
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f1"]);
    expect(path(actor)).toBe("ok");
  });

  test("a failed rename emits nothing and sets the error", async () => {
    const { actor, outputs } = await loaded({
      setName: vi.fn().mockResolvedValue([new Error("too long"), null]),
    });
    send(actor, "SET_NAME", { name: "Me" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("too long"));
    expect(outputs).toEqual([]);
  });
});
