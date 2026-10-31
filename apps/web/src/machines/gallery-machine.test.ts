import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { $photos, $galleryState, $galleryError, $addBatch, gallery } from "./gallery-machine";
import { gateway } from "../gateway";

// The mocked gateway is loosely typed so test fixtures don't have to satisfy
// the full FolderSummary/Photo/Either shapes.
const mock = gateway as any;

vi.mock("../gateway", () => {
  const g = {
    list: vi.fn(),
    add: vi.fn(),
    addFile: vi.fn(),
    upload: vi.fn(),
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

const photo = (id: string, name = "beach.jpg") => ({ id, name, folderId: "f1" });

beforeEach(() => {
  mock.list.mockReset().mockResolvedValue([null, { photos: [] }]);
  mock.add.mockReset().mockResolvedValue([null, photo("p1", "beach.jpg")]);
  mock.remove.mockReset().mockResolvedValue([null, undefined]);
  mock.upload.mockReset().mockResolvedValue([null, { id: "u1" }]);
  $photos.set([]);
  $galleryError.set(null);
  gallery.dismissBatch();
});

const path = (name: string) => ({ kind: "path" as const, path: `/tmp/${name}`, name });

describe("gallery machine", () => {
  test("load populates the gallery projection from the backend list", async () => {
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));
    expect($photos.get()).toEqual([]);
  });

  test("a successful add appends the photo to the gallery", async () => {
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));

    gallery.add("/tmp/beach.jpg", "beach.jpg");
    await vi.waitFor(() => expect($photos.get().map((p) => p.id)).toContain("p1"));

    expect($galleryState.get()).toBe("ready");
    expect($photos.get()[0]).toMatchObject({ id: "p1", name: "beach.jpg" });
  });

  test("an add failure is recorded on the batch and returns to ready (no unhandled rejection)", async () => {
    mock.add.mockResolvedValue([new Error("upload rejected"), null]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));

    gallery.add("/tmp/beach.jpg", "beach.jpg");
    await vi.waitFor(() => expect($addBatch.get()?.running).toBe(false));

    expect($galleryState.get()).toBe("ready");
    expect($addBatch.get()?.failed[0]?.message).toMatch(/rejected/i);
    expect($photos.get()).toEqual([]);
  });

  test("a batch adds every photo in order, with progress", async () => {
    let n = 0;
    mock.add.mockImplementation(async () => [null, photo(`p${++n}`, `${n}.jpg`)]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));

    gallery.addMany([path("1.jpg"), path("2.jpg"), path("3.jpg")], "f1");
    await vi.waitFor(() => expect($addBatch.get()?.running).toBe(false));

    expect(mock.add.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "/tmp/1.jpg",
      "/tmp/2.jpg",
      "/tmp/3.jpg",
    ]);
    expect(mock.add).toHaveBeenCalledWith("/tmp/1.jpg", "1.jpg", "f1");
    expect($addBatch.get()).toMatchObject({ total: 3, done: 3, added: 3, duplicates: 0 });
    expect(
      $photos
        .get()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["p1", "p2", "p3"]);
    expect($galleryState.get()).toBe("ready");
  });

  test("one failure doesn't stop the batch, and Retry re-adds only the failed", async () => {
    mock.add
      .mockResolvedValueOnce([null, photo("p1")])
      .mockResolvedValueOnce([new Error("too big"), null])
      .mockResolvedValueOnce([null, photo("p3")]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));

    gallery.addMany([path("1.jpg"), path("2.jpg"), path("3.jpg")], "f1");
    await vi.waitFor(() => expect($addBatch.get()?.running).toBe(false));
    expect($addBatch.get()).toMatchObject({ done: 3, added: 2 });
    expect($addBatch.get()?.failed.map((f) => f.source)).toEqual([path("2.jpg")]);

    mock.add.mockResolvedValueOnce([null, photo("p2")]);
    gallery.retryFailed();
    await vi.waitFor(() => expect($addBatch.get()).toMatchObject({ running: false, added: 1 }));
    expect(mock.add).toHaveBeenLastCalledWith("/tmp/2.jpg", "2.jpg", "f1");
    expect($addBatch.get()?.failed).toEqual([]);
  });

  test("a photo the album already holds counts as a duplicate", async () => {
    mock.list.mockResolvedValue([null, { photos: [photo("p1")] }]);
    mock.add.mockResolvedValue([null, photo("p1")]);
    gallery.load();
    await vi.waitFor(() => expect($photos.get()).toHaveLength(1));

    gallery.addMany([path("again.jpg")], "f1");
    await vi.waitFor(() => expect($addBatch.get()?.running).toBe(false));
    expect($addBatch.get()).toMatchObject({ added: 0, duplicates: 1 });
    expect($photos.get()).toHaveLength(1);
  });

  test("browser uploads reload the gallery once the batch ends", async () => {
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));
    mock.list.mockClear().mockResolvedValue([null, { photos: [photo("u1")] }]);

    const file = new File(["x"], "pick.png", { type: "image/png" });
    gallery.addMany([{ kind: "file", file }], "f1");
    await vi.waitFor(() => expect($photos.get().map((p) => p.id)).toEqual(["u1"]));

    expect(mock.upload).toHaveBeenCalledWith(file, "f1");
    expect(mock.list).toHaveBeenCalledTimes(1);
    expect($addBatch.get()).toMatchObject({ running: false, added: 1 });
  });

  test("remove drops the photo from the gallery", async () => {
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));
    gallery.add("/tmp/beach.jpg", "beach.jpg");
    await vi.waitFor(() => expect($photos.get().map((p) => p.id)).toContain("p1"));

    gallery.remove("p1", "f1");
    await vi.waitFor(() => expect($photos.get().map((p) => p.id)).not.toContain("p1"));

    expect(mock.remove).toHaveBeenCalledWith("p1", "f1");
    expect($galleryState.get()).toBe("ready");
  });

  test("remove only drops the photo from its own album", async () => {
    mock.list.mockResolvedValue([
      null,
      { photos: [photo("p1"), { ...photo("p1"), folderId: "f2" }] },
    ]);
    gallery.load();
    await vi.waitFor(() => expect($photos.get()).toHaveLength(2));

    gallery.remove("p1", "f1");
    await vi.waitFor(() => expect($photos.get()).toHaveLength(1));

    expect($photos.get()[0]).toMatchObject({ id: "p1", folderId: "f2" });
  });

  test("a load failure surfaces the error state", async () => {
    mock.list.mockResolvedValue([new Error("no data"), null]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("error"));
    expect($galleryError.get()).toMatch(/no data/i);
  });
});
