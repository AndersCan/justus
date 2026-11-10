import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { deleteFromLightbox } from "./lightbox";
import { toast } from "./toast";
import { galleryActor, gallery } from "../machines/gallery-machine";
import type { Photo } from "@justus/core";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./confirm", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

const photo = (id: string): Photo =>
  ({
    id,
    url: `blob:${id}`,
    name: id,
    mime: "image/jpeg",
    size: 1,
    addedAt: 0,
    member: { key: "m", name: "M" },
  }) as Photo;
const [a, b] = [photo("a"), photo("b")];

// Gallery starts a reload that only lands when `land()` is called.
async function reloadHeld() {
  hoisted.gateway.list.mockResolvedValueOnce([null, { photos: [a, b] }]);
  if (gallery.state() !== "photosNotLoaded") {
    await vi.waitFor(() =>
      expect(["showingPhotos", "couldNotRemovePhoto"]).toContain(gallery.state()),
    );
  }
  gallery.load();
  await vi.waitFor(() => expect(gallery.state()).toBe("showingPhotos"));
  let land: () => void = () => {};
  hoisted.gateway.list.mockReturnValueOnce(
    new Promise((r) => (land = () => r([null, { photos: [a, b] }]))),
  );
  gallery.load();
  expect(gallery.state()).toBe("loadingPhotos");
  return () => land();
}
const queueAdd = () => {
  hoisted.gateway.add.mockResolvedValue([null, { photo: photo("c") }]);
  galleryActor.send({
    type: "ADD_MANY",
    payload: { sources: [{ kind: "path", path: "/c.jpg", name: "c.jpg" }] },
  } as never);
};

describe("a delete confirmed during a reload, next to queued photos", () => {
  beforeEach(() => {
    vi.mocked(toast).mockClear();
    hoisted.gateway.remove.mockReset();
  });

  it("a failed delete still says so", async () => {
    const land = await reloadHeld();
    queueAdd();
    hoisted.gateway.remove.mockResolvedValue([new Error("nope"), null]);
    await deleteFromLightbox(b);
    land();
    await vi.waitFor(() => expect(gallery.state()).toBe("couldNotRemovePhoto"));
    await new Promise((r) => setTimeout(r, 50));
    expect(hoisted.gateway.remove).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Couldn't delete “b”. Try again.");
  });

  it("a delete that ran says Deleted", async () => {
    const land = await reloadHeld();
    queueAdd();
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox(b);
    land();
    await vi.waitFor(() => expect(hoisted.gateway.remove).toHaveBeenCalled());
    await vi.waitFor(() => expect(gallery.state()).toBe("showingPhotos"));
    await new Promise((r) => setTimeout(r, 50));
    expect(toast).toHaveBeenCalledWith("Deleted “b”.");
  });
});

describe("a delete confirmed during a reload, with a push meanwhile", () => {
  it("says Deleted when it ends in the extra reload", async () => {
    vi.mocked(toast).mockClear();
    hoisted.gateway.remove.mockReset();
    const land = await reloadHeld();
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox(b);
    gallery.load();
    hoisted.gateway.list.mockResolvedValue([null, { photos: [a] }]);
    land();
    await vi.waitFor(() => expect(hoisted.gateway.remove).toHaveBeenCalled());
    await vi.waitFor(() => expect(gallery.state()).toBe("showingPhotos"));
    await new Promise((r) => setTimeout(r, 50));
    expect(toast).toHaveBeenCalledWith("Deleted “b”.");
  });
});

describe("a delete confirmed during a reload, next to an upload", () => {
  it("a failed delete still reloads for the uploaded photo", async () => {
    hoisted.gateway.remove.mockReset();
    const land = await reloadHeld();
    hoisted.gateway.upload.mockResolvedValue([null, { id: "u1" }]);
    galleryActor.send({
      type: "ADD_MANY",
      payload: { sources: [{ kind: "file", file: new Blob(["x"]), name: "u.jpg" }] },
    } as never);
    hoisted.gateway.remove.mockResolvedValue([new Error("nope"), null]);
    await deleteFromLightbox(b);
    const before = hoisted.gateway.list.mock.calls.length;
    land();
    await vi.waitFor(() => expect(hoisted.gateway.remove).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(hoisted.gateway.list.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("a second delete confirmed while one waits", () => {
  it("is ignored: the first keeps its place", async () => {
    vi.mocked(toast).mockClear();
    hoisted.gateway.remove.mockReset();
    const land = await reloadHeld();
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox(b);
    await deleteFromLightbox(a);
    land();
    await vi.waitFor(() => expect(hoisted.gateway.remove).toHaveBeenCalled());
    await vi.waitFor(() => expect(gallery.state()).toBe("showingPhotos"));
    expect(hoisted.gateway.remove).toHaveBeenCalledTimes(1);
    expect(hoisted.gateway.remove.mock.calls[0][0]).toBe("b");
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Deleted “b”."));
  });
});
