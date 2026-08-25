import { describe, expect, test, vi, beforeEach } from "vite-plus/test";
import { $photos, $galleryState, $galleryError, gallery } from "./gallery-machine";
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

const photo = (id: string, name = "beach.jpg") => ({ id, name, folderId: "f1" });

beforeEach(() => {
  mock.list.mockReset().mockResolvedValue([null, { photos: [] }]);
  mock.add.mockReset().mockResolvedValue([null, photo("p1", "beach.jpg")]);
  mock.remove.mockReset().mockResolvedValue([null, undefined]);
  $photos.set([]);
  $galleryError.set(null);
});

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

  test("an add failure surfaces an error and returns to ready (no unhandled rejection)", async () => {
    mock.add.mockResolvedValue([new Error("upload rejected"), null]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));

    gallery.add("/tmp/beach.jpg", "beach.jpg");
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));

    expect($galleryError.get()).toMatch(/rejected/i);
    expect($photos.get()).toEqual([]);
  });

  test("remove drops the photo from the gallery", async () => {
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("ready"));
    gallery.add("/tmp/beach.jpg", "beach.jpg");
    await vi.waitFor(() => expect($photos.get().map((p) => p.id)).toContain("p1"));

    gallery.remove("p1");
    await vi.waitFor(() => expect($photos.get().map((p) => p.id)).not.toContain("p1"));

    expect($galleryState.get()).toBe("ready");
  });

  test("a load failure surfaces the error state", async () => {
    mock.list.mockResolvedValue([new Error("no data"), null]);
    gallery.load();
    await vi.waitFor(() => expect($galleryState.get()).toBe("error"));
    expect($galleryError.get()).toMatch(/no data/i);
  });
});
