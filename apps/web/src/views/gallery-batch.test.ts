// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { gallery, galleryActor } from "../machines/gallery-machine";
import "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

const photo = { id: "p1", name: "p1.jpg", folderId: "f1", url: "u", thumbUrl: "t", addedAt: 1 };
const batchOf = () => galleryActor.snapshot().context.batch;

describe("add batch toast", () => {
  test("a clean batch says what happened and is dismissed; one with failures stays up", async () => {
    hoisted.gateway.list.mockResolvedValue([null, { photos: [] }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));
    hoisted.gateway.add.mockResolvedValueOnce([null, photo]);
    gallery.addMany([{ kind: "path", path: "/a.jpg", name: "a.jpg" }], "f1");
    await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    expect(hoisted.toast.mock.calls[0][0]).toContain("Added a photo");
    expect(hoisted.toast.mock.calls[0][1]).toEqual({});
    await vi.waitFor(() => expect(batchOf()).toBeNull());

    hoisted.toast.mockClear();
    hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
    gallery.addMany([{ kind: "path", path: "/b.jpg", name: "b.jpg" }], "f1");
    await vi.waitFor(() => expect(batchOf()?.running).toBe(false));
    await galleryActor.settled();
    expect(hoisted.toast).not.toHaveBeenCalled();
    expect(batchOf()?.failed).toHaveLength(1);
  });

  test("a batch with duplicates stays 10 s with Dismiss", async () => {
    hoisted.toast.mockClear();
    hoisted.gateway.list.mockResolvedValue([null, { photos: [photo] }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));
    hoisted.gateway.add.mockResolvedValueOnce([null, photo]);
    gallery.addMany([{ kind: "path", path: "/d.jpg", name: "d.jpg" }], "f1");
    await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    expect(hoisted.toast.mock.calls[0][0]).toContain("already");
    expect(hoisted.toast.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        duration: 10_000,
        action: expect.objectContaining({ label: "Dismiss" }),
      }),
    );
  });
});
