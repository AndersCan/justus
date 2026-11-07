import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { createGalleryActor, galleryViewModel, gallery, galleryActor } from "./gallery-machine";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));

const photo = (id: string, name = "beach.jpg", folderId = "f1") => ({ id, name, folderId });
const path = (name: string) => ({ kind: "path" as const, path: `/tmp/${name}`, name });

type Ok = Promise<[unknown, unknown]>;
type Fakes = Partial<{
  list: () => Ok;
  add: (...args: any[]) => Ok;
  upload: (...args: any[]) => Ok;
  remove: (...args: any[]) => Ok;
}>;

function build(fakes: Fakes = {}) {
  const port = {
    list: vi.fn(fakes.list ?? (async () => [null, { photos: [] }])),
    add: vi.fn(fakes.add ?? (async () => [null, photo("p1")])),
    upload: vi.fn(fakes.upload ?? (async () => [null, { id: "u1" }])),
    remove: vi.fn(fakes.remove ?? (async () => [null, undefined])),
  };
  const actor = createGalleryActor({ clock: VirtualClock(), gateway: port as any });
  const send = (type: string, payload?: unknown) => (actor as any).send({ type, payload });
  const stateOf = () => actor.snapshot().path[0];
  const ctx = () => actor.snapshot().context;
  return { actor, port, send, stateOf, ctx };
}

async function ready(h: ReturnType<typeof build>) {
  h.send("LOAD");
  await vi.waitFor(() => expect(h.stateOf()).toBe("ready"));
}

const finished = (h: ReturnType<typeof build>) =>
  vi.waitFor(() => expect(h.ctx().batch?.running).toBe(false));

describe("gallery factory", () => {
  test("load puts the listed photos in context", async () => {
    const h = build({ list: async () => [null, { photos: [photo("p1")] }] });
    await ready(h);
    expect(h.ctx().photos).toEqual([photo("p1")]);
  });

  test("a successful add puts the photo first", async () => {
    const h = build({ list: async () => [null, { photos: [photo("p0")] }] });
    await ready(h);
    h.send("ADD_MANY", { sources: [path("beach.jpg")], folderId: "f1" });
    await finished(h);
    expect(h.stateOf()).toBe("ready");
    expect(h.ctx().photos.map((p: { id: string }) => p.id)).toEqual(["p1", "p0"]);
  });

  test("photos picked while the list is reloading are added once it lands", async () => {
    let land!: () => void;
    const h = build();
    await ready(h);
    h.port.list.mockImplementationOnce(
      () =>
        new Promise<[unknown, unknown]>(
          (resolve) => (land = () => resolve([null, { photos: [] }])),
        ),
    );
    h.send("LOAD");
    await vi.waitFor(() => expect(h.stateOf()).toBe("loading"));
    h.send("ADD_MANY", { sources: [path("beach.jpg")], folderId: "f1" });
    expect(h.ctx().batch?.running).toBe(true);
    land();
    await finished(h);
    expect(h.ctx().batch?.added).toBe(1);
    expect(h.ctx().photos.map((p: { id: string }) => p.id)).toContain("p1");
  });

  test("a push during a reload loads the list once more", async () => {
    let land!: () => void;
    const h = build();
    await ready(h);
    h.port.list
      .mockImplementationOnce(
        () =>
          new Promise<[unknown, unknown]>(
            (resolve) => (land = () => resolve([null, { photos: [] }])),
          ),
      )
      .mockResolvedValueOnce([null, { photos: [photo("p9")] }]);
    h.send("LOAD");
    await vi.waitFor(() => expect(h.stateOf()).toBe("loading"));
    h.send("LOAD");
    land();
    await vi.waitFor(() => expect(h.ctx().photos.map((p: { id: string }) => p.id)).toEqual(["p9"]));
    expect(h.stateOf()).toBe("ready");
  });

  test("an add failure is recorded on the batch and returns to ready", async () => {
    const h = build({ add: async () => [new Error("upload rejected"), null] });
    await ready(h);
    h.send("ADD_MANY", { sources: [path("beach.jpg")], folderId: "f1" });
    await finished(h);
    expect(h.stateOf()).toBe("ready");
    expect(h.ctx().batch?.failed[0]?.message).toMatch(/rejected/i);
    expect(h.ctx().photos).toEqual([]);
  });

  test("a rejected add is a failure, not a crash", async () => {
    const h = build({ add: () => Promise.reject(new Error("offline")) });
    await ready(h);
    h.send("ADD_MANY", { sources: [path("a.jpg")], folderId: "f1" });
    await finished(h);
    expect(h.ctx().batch?.failed[0]?.message).toBe("offline");
  });

  test("a host's shared copies travel with the add; its original is never the photo", async () => {
    const h = build();
    await ready(h);
    h.send("ADD_MANY", {
      sources: [
        {
          kind: "path",
          path: "/tmp/d.jpg",
          thumb: "/tmp/t.jpg",
          original: "/tmp/o.heic",
          takenAt: "2026-07-01T12:00:00",
          name: "IMG_1.HEIC",
        },
      ],
      folderId: "f1",
    });
    await finished(h);
    expect(h.port.add).toHaveBeenCalledWith("/tmp/d.jpg", "IMG_1.HEIC", "f1", {
      thumb: "/tmp/t.jpg",
      original: "/tmp/o.heic",
      takenAt: "2026-07-01T12:00:00",
    });
  });

  test("a batch adds every photo in order, with progress", async () => {
    let n = 0;
    const h = build({ add: async () => [null, photo(`p${++n}`, `${n}.jpg`)] });
    await ready(h);
    h.send("ADD_MANY", {
      sources: [path("1.jpg"), path("2.jpg"), path("3.jpg")],
      folderId: "f1",
    });
    await finished(h);
    expect(h.port.add.mock.calls.map((c) => c[0])).toEqual([
      "/tmp/1.jpg",
      "/tmp/2.jpg",
      "/tmp/3.jpg",
    ]);
    expect(h.port.add).toHaveBeenCalledWith("/tmp/1.jpg", "1.jpg", "f1", {});
    expect(h.ctx().batch).toMatchObject({ total: 3, done: 3, added: 3, duplicates: 0 });
    expect(
      h
        .ctx()
        .photos.map((p: { id: string }) => p.id)
        .sort(),
    ).toEqual(["p1", "p2", "p3"]);
  });

  test("one failure doesn't stop the batch, and Retry re-adds only the failed", async () => {
    const h = build();
    h.port.add
      .mockResolvedValueOnce([null, photo("p1")])
      .mockResolvedValueOnce([new Error("too big"), null])
      .mockResolvedValueOnce([null, photo("p3")]);
    await ready(h);
    h.send("ADD_MANY", {
      sources: [path("1.jpg"), path("2.jpg"), path("3.jpg")],
      folderId: "f1",
    });
    await finished(h);
    expect(h.ctx().batch).toMatchObject({ done: 3, added: 2 });
    expect(h.ctx().batch?.failed.map((f: { source: unknown }) => f.source)).toEqual([
      path("2.jpg"),
    ]);

    h.port.add.mockResolvedValueOnce([null, photo("p2")]);
    h.send("RETRY_FAILED");
    await vi.waitFor(() => expect(h.ctx().batch).toMatchObject({ running: false, added: 1 }));
    expect(h.port.add).toHaveBeenLastCalledWith("/tmp/2.jpg", "2.jpg", "f1", {});
    expect(h.ctx().batch?.failed).toEqual([]);
  });

  test("retrying with nothing failed does nothing", async () => {
    const h = build();
    await ready(h);
    h.send("RETRY_FAILED");
    expect(h.stateOf()).toBe("ready");
    expect(h.ctx().batch).toBeNull();
  });

  test("dismiss closes a finished summary and keeps the photos", async () => {
    const h = build();
    await ready(h);
    h.send("ADD_MANY", { sources: [path("a.jpg")], folderId: "f1" });
    await finished(h);
    h.send("DISMISS_BATCH");
    expect(h.ctx().batch).toBeNull();
    expect(h.ctx().photos).toHaveLength(1);
  });

  test("dismiss does not close a batch that is still running", async () => {
    const h = build({ add: () => new Promise(() => {}) });
    await ready(h);
    h.send("ADD_MANY", { sources: [path("a.jpg")], folderId: "f1" });
    h.send("DISMISS_BATCH");
    expect(h.ctx().batch?.running).toBe(true);
  });

  test("a photo the album already holds counts as a duplicate", async () => {
    const h = build({
      list: async () => [null, { photos: [photo("p1")] }],
      add: async () => [null, photo("p1")],
    });
    await ready(h);
    h.send("ADD_MANY", { sources: [path("again.jpg")], folderId: "f1" });
    await finished(h);
    expect(h.ctx().batch).toMatchObject({ added: 0, duplicates: 1 });
    expect(h.ctx().photos).toHaveLength(1);
  });

  test("a push during a batch reloads once the batch ends", async () => {
    let release!: () => void;
    const h = build({
      add: () => new Promise((resolve) => (release = () => resolve([null, photo("p1")]))),
    });
    await ready(h);
    h.send("ADD_MANY", { sources: [path("a.jpg")], folderId: "f1" });
    h.send("LOAD");
    h.port.list.mockClear().mockResolvedValue([null, { photos: [photo("p1"), photo("p2")] }]);
    release();
    await vi.waitFor(() => expect(h.ctx().photos).toHaveLength(2));
    expect(h.port.list).toHaveBeenCalledTimes(1);
    expect(h.stateOf()).toBe("ready");
  });

  test("browser uploads reload the gallery once the batch ends", async () => {
    const h = build();
    await ready(h);
    h.port.list.mockClear().mockResolvedValue([null, { photos: [photo("u1")] }]);
    const file = new File(["x"], "pick.png", { type: "image/png" });
    h.send("ADD_MANY", { sources: [{ kind: "file", file }], folderId: "f1" });
    await vi.waitFor(() => expect(h.ctx().photos.map((p: { id: string }) => p.id)).toEqual(["u1"]));
    expect(h.port.upload).toHaveBeenCalledWith(file, "f1");
    expect(h.port.list).toHaveBeenCalledTimes(1);
    expect(h.ctx().batch).toMatchObject({ running: false, added: 1 });
  });

  test("the add summary survives a reload", async () => {
    const h = build();
    await ready(h);
    h.send("ADD_MANY", { sources: [path("a.jpg")], folderId: "f1" });
    await finished(h);
    h.send("LOAD");
    await vi.waitFor(() => expect(h.stateOf()).toBe("ready"));
    expect(h.ctx().batch).toMatchObject({ running: false, added: 1 });
  });

  test("remove drops the photo from its own album only", async () => {
    const h = build({
      list: async () => [null, { photos: [photo("p1"), photo("p1", "x.jpg", "f2")] }],
    });
    await ready(h);
    h.send("REMOVE", { id: "p1", folderId: "f1" });
    await vi.waitFor(() => expect(h.ctx().photos).toHaveLength(1));
    expect(h.port.remove).toHaveBeenCalledWith("p1", "f1");
    expect(h.ctx().photos[0]).toMatchObject({ id: "p1", folderId: "f2" });
    expect(h.stateOf()).toBe("ready");
  });

  test("a failed removal keeps the photo and shows the error", async () => {
    const h = build({
      list: async () => [null, { photos: [photo("p1")] }],
      remove: async () => [new Error("not allowed"), null],
    });
    await ready(h);
    h.send("REMOVE", { id: "p1", folderId: "f1" });
    await vi.waitFor(() => expect(h.ctx().error).toBe("not allowed"));
    expect(h.stateOf()).toBe("ready");
    expect(h.ctx().photos).toHaveLength(1);
  });

  test("a load failure shows the error, and Try again recovers", async () => {
    const h = build();
    h.port.list.mockResolvedValueOnce([new Error("no data"), null]);
    h.send("LOAD");
    await vi.waitFor(() => expect(h.stateOf()).toBe("error"));
    expect(h.ctx().error).toBe("no data");
    h.send("RETRY");
    await vi.waitFor(() => expect(h.stateOf()).toBe("ready"));
    expect(h.ctx().error).toBeNull();
  });

  test("a list with no photos is a load failure", async () => {
    const h = build({ list: async () => [null, {}] });
    h.send("LOAD");
    await vi.waitFor(() => expect(h.stateOf()).toBe("error"));
    expect(h.ctx().error).toMatch(/no photos/);
  });
});

describe("gallery idle reset", () => {
  test("a batch finishing keeps the error from a failed load", async () => {
    const h = build();
    h.port.list.mockResolvedValueOnce([new Error("no data"), null]);
    h.send("LOAD");
    h.send("ADD_MANY", { sources: [path("beach.jpg")], folderId: "f1" });
    await finished(h);
    await vi.waitFor(() => expect(h.stateOf()).not.toBe("adding"));
    expect(h.ctx().error).toMatch(/no data/);
  });
});

const single = () => galleryActor.snapshot().context;

describe("gallery singleton", () => {
  test("holds photos, add summary and error in its context", async () => {
    expect(gallery.state()).toBe("booting");
    expect(single().photos).toEqual([]);
    expect(single().batch).toBeNull();
    expect(single().error).toBeNull();

    hoisted.gateway.list.mockResolvedValueOnce([null, { photos: [photo("p0")] }]);
    gallery.load();
    await vi.waitFor(() => expect(gallery.state()).toBe("ready"));
    expect(single().photos).toEqual([photo("p0")]);

    hoisted.gateway.add.mockResolvedValueOnce([null, photo("p1")]);
    gallery.add("/tmp/a.jpg", "a.jpg", "f1");
    await vi.waitFor(() => expect(single().batch?.running).toBe(false));
    expect(single().batch?.added).toBe(1);
    expect(single().photos.map((p) => p.id)).toEqual(["p1", "p0"]);

    gallery.dismissBatch();
    expect(single().batch).toBeNull();

    hoisted.gateway.list.mockResolvedValueOnce([new Error("no data"), null]);
    gallery.load();
    await vi.waitFor(() => expect(gallery.state()).toBe("error"));
    expect(single().error).toMatch(/no data/);
  });
});

describe("gallery last synced and view model", () => {
  test("synced stores the time in context and survives a reload", async () => {
    const h = build();
    expect(h.ctx().lastSyncAt).toBeUndefined();
    h.send("SYNCED", { at: 5 });
    expect(h.ctx().lastSyncAt).toBe(5);
    await ready(h);
    expect(h.ctx().lastSyncAt).toBe(5);
  });

  test("the singleton stores lastSyncAt", () => {
    gallery.synced(7);
    expect(single().lastSyncAt).toBe(7);
  });

  test("galleryViewModel: initial snapshot, role from the passed status", () => {
    const h = build();
    expect(galleryViewModel(h.actor.snapshot(), null)).toEqual({
      state: "booting",
      busy: false,
      error: null,
      fatal: false,
      photos: [],
      role: null,
    });
    const status = { folder: { role: "reader" } } as any;
    expect(galleryViewModel(h.actor.snapshot(), status).role).toBe("reader");
  });

  test("galleryViewModel: busy while removing", async () => {
    const h = build({
      list: async () => [null, { photos: [photo("p1")] }],
      remove: () => new Promise(() => {}),
    });
    await ready(h);
    h.send("REMOVE", { id: "p1", folderId: "f1" });
    const vm = galleryViewModel(h.actor.snapshot(), null);
    expect(vm.state).toBe("removing");
    expect(vm.busy).toBe(true);
  });
});
