import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import {
  createFoldersActor,
  folders,
  foldersActor,
  foldersViewModel,
  wireFoldersToSync,
} from "./folders-machine";
import { gateway } from "../gateway";
import { createSyncActor, statusSeen, syncActor } from "./sync-machine";

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

const ctx = () => foldersActor.snapshot().context;
const sync = () => syncActor.snapshot().context;

const folder = (id: string, name: string) => ({ id, name });

beforeEach(() => {
  // The backend returns `activeFolderId: null` for a fresh device with no
  // folder chosen yet — the machine must reach "showingAlbums", not "couldNotLoadAlbums", in that case.
  mock.folders.mockReset().mockResolvedValue([null, { folders: [], activeFolderId: null }]);
  mock.createFolder.mockReset().mockResolvedValue([null, { folder: folder("f2", "New") }]);
  mock.setActive.mockReset().mockResolvedValue([null, { folder: folder("f1", "Trip") }]);
  mock.setName.mockReset().mockResolvedValue([null, { name: "Renamed" }]);
});

describe("folders machine", () => {
  test("refresh loads the folder list and the active folder id", async () => {
    mock.folders.mockResolvedValue([
      null,
      { folders: [folder("f1", "Trip")], activeFolderId: "f1" },
    ]);
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
    expect(ctx().folders.map((f) => f.id)).toContain("f1");
    expect(ctx().activeId).toBe("f1");
  });

  test("refresh also loads the asks, and treats a missing list as none", async () => {
    const ask = { code: "c", status: "waiting" };
    mock.folders.mockResolvedValue([null, { folders: [], activeFolderId: null, asks: [ask] }]);
    folders.refresh();
    await vi.waitFor(() => expect(ctx().asks).toEqual([ask]));

    mock.folders.mockResolvedValue([null, { folders: [], activeFolderId: null }]);
    folders.refresh();
    await vi.waitFor(() => expect(ctx().asks).toEqual([]));
  });

  test("create appends the folder and makes it the active folder", async () => {
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));

    folders.create("New");
    await vi.waitFor(() => expect(ctx().activeId).toBe("f2"));

    expect(folders.state()).toBe("showingAlbums");
    expect(ctx().folders.map((f) => f.id)).toContain("f2");
  });

  test("setActive switches the active folder", async () => {
    mock.folders.mockResolvedValue([
      null,
      { folders: [folder("f1", "Trip")], activeFolderId: "f1" },
    ]);
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));

    folders.switchTo("f1");
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
    expect(ctx().activeId).toBe("f1");
  });

  test("switching gives sync the returned status", async () => {
    const status = { folder: { id: "f1", name: "Trip" }, name: "Ann" };
    mock.setActive.mockResolvedValue([null, status]);
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));

    folders.switchTo("f1");
    await vi.waitFor(() => expect(sync().status).toEqual(status));
    expect(ctx().activeId).toBe("f1");
  });

  test("renaming sets userName", async () => {
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));

    folders.rename("Renamed");
    await vi.waitFor(() => expect(ctx().userName).toBe("Renamed"));
  });

  test("a retry after a failed refresh clears the error", async () => {
    mock.folders.mockResolvedValueOnce([new Error("offline"), null]);
    folders.refresh();
    await vi.waitFor(() => expect(ctx().error).toBe("offline"));

    folders.retry();
    await vi.waitFor(() => expect(ctx().error).toBeNull());
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
  });

  test("a create failure surfaces an error and lands in couldNotCreateAlbum (no unhandled rejection)", async () => {
    mock.createFolder.mockResolvedValue([new Error("folder denied"), null]);
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));

    folders.create("X");
    await vi.waitFor(() => expect(folders.state()).toBe("couldNotCreateAlbum"));

    expect(ctx().error).toMatch(/denied/i);
    expect(ctx().folders.map((f) => f.id)).not.toContain("f2");
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
    await vi.waitFor(() => expect(path(built.actor)).toBe("showingAlbums"));
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
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(ctx(actor).activeId).toBeNull();
  });

  test("a failed refresh sets the error and retry reloads", async () => {
    const fail = vi.fn().mockResolvedValueOnce([new Error("offline"), null]);
    const { actor } = build({ folders: fail });
    send(actor, "REFRESH");
    await vi.waitFor(() => expect(path(actor)).toBe("couldNotLoadAlbums"));
    expect(ctx(actor).error).toBe("offline");
    fail.mockResolvedValue([null, { folders: [], activeFolderId: null }]);
    send(actor, "RETRY");
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(ctx(actor).error).toBeNull();
  });

  test("create prepends the folder and activates it", async () => {
    const { actor, gw } = await loaded();
    send(actor, "CREATE_FOLDER", { name: "New" });
    await vi.waitFor(() => expect(ctx(actor).activeId).toBe("f2"));
    expect(path(actor)).toBe("showingAlbums");
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(gw.createFolder).toHaveBeenCalledWith("New");
  });

  test("a failed create keeps the list and sets the error", async () => {
    const { actor } = await loaded({
      createFolder: vi.fn().mockResolvedValue([new Error("denied"), null]),
    });
    send(actor, "CREATE_FOLDER", { name: "X" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("denied"));
    expect(path(actor)).toBe("couldNotCreateAlbum");
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
    expect(path(actor)).toBe("couldNotOpenAlbum");
    expect(ctx(actor).activeId).toBe("f1");
    expect(outputs).toEqual([]);
  });

  test("rename emits renamed with the saved name", async () => {
    const { actor, outputs } = await loaded();
    send(actor, "SET_NAME", { name: "Me" });
    await vi.waitFor(() => expect(outputs.map((o) => o.type)).toEqual(["RENAMED"]));
    expect(outputs[0]!.payload).toEqual({ name: "Renamed" });
    expect(ctx(actor).folders.map((f) => f.id)).toEqual(["f1"]);
    expect(path(actor)).toBe("showingAlbums");
  });

  test("a failed rename emits nothing and sets the error", async () => {
    const { actor, outputs } = await loaded({
      setName: vi.fn().mockResolvedValue([new Error("too long"), null]),
    });
    send(actor, "SET_NAME", { name: "Me" });
    await vi.waitFor(() => expect(ctx(actor).error).toBe("too long"));
    expect(path(actor)).toBe("couldNotSaveName");
    expect(outputs).toEqual([]);
  });

  const failures = [
    ["couldNotCreateAlbum", "createFolder", "CREATE_FOLDER", { name: "X" }],
    ["couldNotOpenAlbum", "setActive", "SET_ACTIVE", { folderId: "f3" }],
    ["couldNotSaveName", "setName", "SET_NAME", { name: "Me" }],
  ] as const;

  describe.each(failures)("from %s", (failed, call, failingEvent, failingPayload) => {
    const failedHarness = async () => {
      const built = await loaded({ [call]: vi.fn().mockResolvedValue([new Error("nope"), null]) });
      send(built.actor, failingEvent, failingPayload);
      await vi.waitFor(() => expect(path(built.actor)).toBe(failed));
      return built;
    };

    test("the view model is settled, not busy, and carries the message", async () => {
      const { actor } = await failedHarness();
      const vm = foldersViewModel(actor.snapshot());
      expect(vm).toMatchObject({ settled: true, busy: false, error: "nope" });
    });

    test.each([
      ["REFRESH", undefined, "loadingAlbums"],
      ["CREATE_FOLDER", { name: "N" }, "creatingAlbum"],
      ["SET_ACTIVE", { folderId: "f3" }, "openingAlbum"],
      ["SET_NAME", { name: "Me" }, "savingName"],
    ] as const)(
      "%s enters the same state as from ok and clears the error",
      async (type, payload, next) => {
        const { actor } = await failedHarness();
        send(actor, type, payload);
        expect(path(actor)).toBe(next);
        expect(ctx(actor).error).toBeNull();
      },
    );
  });

  test("settled is true only when the albums are listed and nothing is in flight", async () => {
    const { actor } = build();
    expect(foldersViewModel(actor.snapshot()).settled).toBe(false);
    send(actor, "REFRESH");
    expect(foldersViewModel(actor.snapshot()).settled).toBe(false);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(foldersViewModel(actor.snapshot()).settled).toBe(true);
  });
});

describe("folders single owner", () => {
  const status = (name: string, id = "f1") => ({ name, folder: { id }, members: [] }) as any;
  const wired = (port: Record<string, unknown> = {}) => {
    const clock = VirtualClock();
    const folders = createFoldersActor({
      clock,
      gateway: {
        folders: vi.fn().mockResolvedValue([null, { folders: [], activeFolderId: null }]),
        setActive: vi.fn().mockResolvedValue([null, status("Ann")]),
        setName: vi.fn().mockResolvedValue([null, { name: "Renamed" }]),
        ...port,
      } as any,
    });
    const sync = createSyncActor({ clock, gateway: {} as any });
    const off = wireFoldersToSync(folders, sync);
    return { folders, sync, off };
  };

  test("a switch makes sync's context.status the switched status", async () => {
    const { folders, sync } = wired();
    folders.send({ type: "REFRESH" } as never);
    await folders.settled();
    folders.send({ type: "SET_ACTIVE", payload: { folderId: "f1" } } as never);
    await folders.settled();
    expect(sync.snapshot().context.status).toEqual(status("Ann"));
  });

  test("a sync status with a new name gives folders that userName", () => {
    const { folders, sync } = wired();
    sync.send(statusSeen.create({ status: status("Maya") }));
    expect(folders.snapshot().context.userName).toBe("Maya");
  });

  test("the same name sends no event", () => {
    const { folders, sync } = wired();
    const send = vi.spyOn(folders, "send");
    sync.send(statusSeen.create({ status: status("Maya") }));
    sync.send(statusSeen.create({ status: status("Maya", "f2") }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("a rename sets userName", async () => {
    const { folders } = wired();
    folders.send({ type: "REFRESH" } as never);
    await folders.settled();
    folders.send({ type: "SET_NAME", payload: { name: "Me" } } as never);
    await folders.settled();
    expect(folders.snapshot().context.userName).toBe("Renamed");
  });

  test("the returned function unwires both directions", () => {
    const { folders, sync, off } = wired();
    off();
    sync.send(statusSeen.create({ status: status("Maya") }));
    expect(folders.snapshot().context.userName).toBe("");
  });

  test("foldersViewModel: initial snapshot and busy while creating", () => {
    const { folders } = wired({ createFolder: vi.fn(() => new Promise(() => {})) });
    expect(foldersViewModel(folders.snapshot())).toEqual({
      userName: "",
      folders: [],
      asks: [],
      activeFolderId: null,
      state: "albumsNotLoaded",
      busy: false,
      settled: false,
      error: null,
      fatal: false,
    });
    folders.send({ type: "REFRESH" } as never);
    return folders.settled().then(() => {
      folders.send({ type: "CREATE_FOLDER", payload: { name: "X" } } as never);
      const vm = foldersViewModel(folders.snapshot());
      expect(vm.state).toBe("creatingAlbum");
      expect(vm.busy).toBe(true);
    });
  });
});
