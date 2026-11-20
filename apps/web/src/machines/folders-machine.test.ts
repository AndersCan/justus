import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { expectNoDesignErrors } from "@mantaq/inspect";
import { VirtualClock, machine } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import {
  foldersMachine,
  folders,
  foldersActor,
  foldersViewModel,
  wireFoldersToSync,
} from "./folders-machine";
import { gateway } from "../gateway";
import { syncMachine, statusSeen, syncActor } from "./sync-machine";

// The mocked gateway is loosely typed so test fixtures don't have to satisfy
// the full FolderSummary/Photo/Either shapes.
const mock = gateway as any;

vi.mock("../gateway", () => {
  const g = {
    list: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
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

  test("refresh also loads the friend invites, and treats a missing list as none", async () => {
    const offer = { code: "c", owner: "o", albumName: "Trip", ownerName: "Nils" };
    mock.folders.mockResolvedValue([null, { folders: [], activeFolderId: null, offers: [offer] }]);
    folders.refresh();
    await vi.waitFor(() => expect(ctx().offers).toEqual([offer]));

    mock.folders.mockResolvedValue([null, { folders: [], activeFolderId: null }]);
    folders.refresh();
    await vi.waitFor(() => expect(ctx().offers).toEqual([]));
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

  test("Save while the album list reloads (a sync push) still saves the name", async () => {
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
    let finish: (v: unknown) => void = () => {};
    mock.folders.mockReturnValueOnce(new Promise((r) => (finish = r)));
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("loadingAlbums"));

    const loadsBefore = mock.folders.mock.calls.length;
    folders.rename("Renamed");
    finish([null, { folders: [], activeFolderId: null }]);
    await vi.waitFor(() => expect(ctx().userName).toBe("Renamed"));
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
    expect(mock.setName).toHaveBeenCalledWith("Renamed");
    expect(mock.folders.mock.calls.length).toBeGreaterThan(loadsBefore);
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
  const send = (actor: ReturnType<typeof foldersMachine.create>, type: string, payload?: unknown) =>
    (actor as any).send({ type, payload });

  function build(port: Record<string, unknown> = {}) {
    const gw = {
      folders: vi.fn().mockResolvedValue([null, { folders: [], activeFolderId: null }]),
      createFolder: vi.fn().mockResolvedValue([null, { folder: folder("f2", "New") }]),
      setActive: vi.fn().mockResolvedValue([null, { folder: folder("f1", "Trip") }]),
      setName: vi.fn().mockResolvedValue([null, { name: "Renamed" }]),
      ...port,
    };
    const actor = foldersMachine.create({ gateway: gw as any });
    const outputs: { type: string; payload: unknown }[] = [];
    onOutput(actor, (e) => outputs.push(e as any));
    return { actor, outputs, gw };
  }
  const ctx = (actor: ReturnType<typeof foldersMachine.create>) => actor.snapshot().context;
  const path = (actor: ReturnType<typeof foldersMachine.create>) => actor.snapshot().path[0];

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

  test("switch emits statusSeen with the new status", async () => {
    const status = { folder: { id: "f3" }, name: "Ann" };
    const { actor, outputs, gw } = await loaded({
      setActive: vi.fn().mockResolvedValue([null, status]),
    });
    send(actor, "SET_ACTIVE", { folderId: "f3" });
    await vi.waitFor(() => expect(outputs.map((o) => o.type)).toEqual(["STATUS_SEEN"]));
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
    const folders = foldersMachine.create({
      clock,
      gateway: {
        folders: vi.fn().mockResolvedValue([null, { folders: [], activeFolderId: null }]),
        setActive: vi.fn().mockResolvedValue([null, status("Ann")]),
        setName: vi.fn().mockResolvedValue([null, { name: "Renamed" }]),
        ...port,
      } as any,
    });
    const sync = syncMachine.create({ clock, gateway: {} as any });
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
      archived: [],
      deleted: [],
      pendingChange: null,
      asks: [],
      offers: [],
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

describe("album lifecycle in the folders machine", () => {
  const send = (actor: ReturnType<typeof foldersMachine.create>, type: string, payload?: unknown) =>
    (actor as any).send({ type, payload });
  const path = (actor: ReturnType<typeof foldersMachine.create>) => actor.snapshot().path[0];
  const trip = { folderId: "f1", name: "Trip" };
  const notice = { id: "f2", name: "Hytta", adminName: "Nils" };

  function build(port: Record<string, unknown> = {}) {
    const listed = vi
      .fn()
      .mockResolvedValueOnce([null, { folders: [folder("f1", "Trip")], activeFolderId: "f1" }])
      .mockResolvedValue([
        null,
        {
          folders: [],
          activeFolderId: null,
          archived: [folder("f1", "Trip")],
          deleted: [notice],
        },
      ]);
    const ok = () => vi.fn().mockResolvedValue([null, { ok: true }]);
    const gw = {
      folders: listed,
      archiveAlbum: ok(),
      restoreAlbum: ok(),
      leaveAlbum: ok(),
      handOverAlbum: ok(),
      stayAdmin: ok(),
      deleteAlbum: ok(),
      dismissAlbumNotice: ok(),
      dismissWhoLeft: ok(),
      dismissWhoJoined: ok(),
      dismissAdminChanged: ok(),
      ...port,
    };
    const actor = foldersMachine.create({ gateway: gw as any });
    return { actor, gw };
  }

  async function loaded(port: Record<string, unknown> = {}) {
    const built = build(port);
    send(built.actor, "REFRESH");
    await vi.waitFor(() => expect(path(built.actor)).toBe("showingAlbums"));
    return built;
  }

  test("archiving lists the album under archived", async () => {
    const { actor, gw } = await loaded();
    send(actor, "ARCHIVE_ALBUM", trip);
    expect(path(actor)).toBe("archivingAlbum");
    expect(foldersViewModel(actor.snapshot()).busy).toBe(true);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(gw.archiveAlbum).toHaveBeenCalledWith("f1");
    const context = actor.snapshot().context;
    expect(context.folders).toEqual([]);
    expect(context.archived.map((f) => f.id)).toEqual(["f1"]);
    expect(context.pendingChange).toEqual({ kind: "archive", ...trip });
  });

  test.each([
    ["RESTORE_ALBUM", "restoringAlbum", "restoreAlbum"],
    ["LEAVE_ALBUM", "leavingAlbum", "leaveAlbum"],
    ["DELETE_ALBUM", "deletingAlbum", "deleteAlbum"],
    ["DISMISS_DELETED_NOTICE", "dismissingDeletedNotice", "dismissAlbumNotice"],
    ["DISMISS_WHO_LEFT", "dismissingWhoLeft", "dismissWhoLeft"],
    ["DISMISS_WHO_JOINED", "dismissingWhoJoined", "dismissWhoJoined"],
    ["DISMISS_ADMIN_CHANGED", "dismissingAdminChanged", "dismissAdminChanged"],
  ] as const)("%s is busy in %s and calls %s", async (type, busy, call) => {
    const { actor, gw } = await loaded();
    send(actor, type, trip);
    expect(path(actor)).toBe(busy);
    expect(foldersViewModel(actor.snapshot()).busy).toBe(true);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect((gw as any)[call]).toHaveBeenCalledWith("f1");
  });

  test("a failed delete stays and keeps what failed", async () => {
    const { actor } = await loaded({
      deleteAlbum: vi.fn().mockResolvedValue([new Error("NOT_CREATOR"), null]),
    });
    send(actor, "DELETE_ALBUM", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("couldNotChangeAlbum"));
    const context = actor.snapshot().context;
    expect(context.folders.map((f) => f.id)).toEqual(["f1"]);
    expect(context.pendingChange).toEqual({ kind: "delete", ...trip });
    expect(context.error).toBe("NOT_CREATOR");
    expect(foldersViewModel(actor.snapshot())).toMatchObject({ settled: true, busy: false });
  });

  test("a failed who-left dismiss stays and keeps what failed", async () => {
    const { actor } = await loaded({
      dismissWhoLeft: vi.fn().mockResolvedValue([new Error("NOT_CREATOR"), null]),
    });
    send(actor, "DISMISS_WHO_LEFT", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("couldNotChangeAlbum"));
    expect(actor.snapshot().context.pendingChange).toEqual({ kind: "dismissWhoLeft", ...trip });
  });

  test("a change that cannot reload the lists fails too", async () => {
    const failing = await loaded({
      folders: vi
        .fn()
        .mockResolvedValueOnce([null, { folders: [folder("f1", "Trip")], activeFolderId: "f1" }])
        .mockResolvedValue([new Error("offline"), null]),
    });
    send(failing.actor, "ARCHIVE_ALBUM", trip);
    await vi.waitFor(() => expect(path(failing.actor)).toBe("couldNotChangeAlbum"));
  });

  test("dismissing removes the notice", async () => {
    const { actor } = await loaded();
    send(actor, "DISMISS_DELETED_NOTICE", { folderId: "f2", name: "Hytta" });
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(actor.snapshot().context.deleted).toEqual([notice]);
  });

  test("handing over passes the chosen person and is busy meanwhile", async () => {
    const { actor, gw } = await loaded();
    send(actor, "HAND_OVER_ALBUM", { ...trip, memberKey: "ben" });
    expect(path(actor)).toBe("handingOverAlbum");
    expect(foldersViewModel(actor.snapshot()).busy).toBe(true);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(gw.handOverAlbum).toHaveBeenCalledWith("f1", "ben");
  });

  test("Stay Admin calls the handover off", async () => {
    const { actor, gw } = await loaded();
    send(actor, "STAY_ADMIN", trip);
    expect(path(actor)).toBe("stayingAdmin");
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(gw.stayAdmin).toHaveBeenCalledWith("f1");
  });

  test("a failed handover keeps the album and names what failed", async () => {
    const { actor } = await loaded({
      handOverAlbum: vi.fn().mockResolvedValue([{ message: "no" }, null]),
    });
    send(actor, "HAND_OVER_ALBUM", { ...trip, memberKey: "ben" });
    await vi.waitFor(() => expect(path(actor)).toBe("couldNotChangeAlbum"));
    expect(actor.snapshot().context.pendingChange?.kind).toBe("handOver");
  });

  test("leaving as a removed person keeps removed on the change", async () => {
    const { actor, gw } = await loaded();
    send(actor, "LEAVE_ALBUM", { ...trip, removed: true });
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(gw.leaveAlbum).toHaveBeenCalledWith("f1");
    expect(actor.snapshot().context.pendingChange).toEqual({
      kind: "leave",
      ...trip,
      removed: true,
    });
  });

  test("a finished leave keeps the album left, a removed person's does not", async () => {
    const { actor } = await loaded();
    send(actor, "LEAVE_ALBUM", { ...trip, removed: true });
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(foldersViewModel(actor.snapshot()).youLeft).toBeUndefined();
    send(actor, "LEAVE_ALBUM", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(foldersViewModel(actor.snapshot()).youLeft).toEqual(trip);
  });

  test("a failed leave keeps no line, the next leave replaces it, dismissing clears it", async () => {
    const { actor, gw } = await loaded({
      leaveAlbum: vi
        .fn()
        .mockResolvedValueOnce([new Error("nope"), null])
        .mockResolvedValue([null, { ok: true }]),
    });
    send(actor, "LEAVE_ALBUM", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("couldNotChangeAlbum"));
    expect(actor.snapshot().context.youLeft).toBeUndefined();
    send(actor, "LEAVE_ALBUM", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    send(actor, "LEAVE_ALBUM", { folderId: "f9", name: "Other" });
    await vi.waitFor(() => expect(gw.leaveAlbum).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(actor.snapshot().context.youLeft?.name).toBe("Other"));
    send(actor, "DISMISS_YOU_LEFT");
    expect(actor.snapshot().context.youLeft).toBeUndefined();
    expect(path(actor)).toBe("showingAlbums");
  });

  test("archiving, restoring or deleting another album keeps the line and never writes one", async () => {
    const { actor } = await loaded();
    send(actor, "ARCHIVE_ALBUM", { folderId: "f9", name: "Other" });
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    expect(actor.snapshot().context.youLeft).toBeUndefined();
    send(actor, "LEAVE_ALBUM", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
    for (const kind of ["ARCHIVE_ALBUM", "RESTORE_ALBUM", "DELETE_ALBUM"]) {
      send(actor, kind, { folderId: "f9", name: "Other" });
      await vi.waitFor(() => expect(path(actor)).toBe("showingAlbums"));
      expect(actor.snapshot().context.youLeft).toEqual(trip);
    }
  });

  test("busy while leaving", async () => {
    const { actor } = await loaded({ leaveAlbum: vi.fn(() => new Promise(() => {})) });
    send(actor, "LEAVE_ALBUM", trip);
    send(actor, "ARCHIVE_ALBUM", trip);
    expect(path(actor)).toBe("leavingAlbum");
    expect(foldersViewModel(actor.snapshot())).toMatchObject({ busy: true, settled: false });
  });

  test("another change can start after a failure", async () => {
    const { actor } = await loaded({
      archiveAlbum: vi.fn().mockResolvedValue([new Error("nope"), null]),
    });
    send(actor, "ARCHIVE_ALBUM", trip);
    await vi.waitFor(() => expect(path(actor)).toBe("couldNotChangeAlbum"));
    send(actor, "LEAVE_ALBUM", trip);
    expect(path(actor)).toBe("leavingAlbum");
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("has no design errors", () => {
    expectNoDesignErrors({
      machine: machine("folders", {
        create: () => foldersMachine.create({ gateway: {} as any }),
      }),
      payloads: {
        ALBUMS_LOADED: [{ folders: [], asks: [], offers: [], activeId: null }],
        ARCHIVE_ALBUM: [trip],
        RESTORE_ALBUM: [trip],
        LEAVE_ALBUM: [trip],
        DELETE_ALBUM: [trip],
        DISMISS_DELETED_NOTICE: [trip],
        NAME_SEEN: [{ name: "Summer" }],
      },
    } as any);
  });
});
