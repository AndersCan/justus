// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { addPicked } from "./photo-picker";
import "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

const photo = { id: "p1", name: "p1.jpg", folderId: "f1", url: "u", thumbUrl: "t", addedAt: 1 };
const fresh = { ...photo, id: "p2", name: "p2.jpg" };

describe("camera batch toast keeps Take another", () => {
  test("clean camera batch offers Take another at the default length", async () => {
    hoisted.gateway.list.mockResolvedValue([null, { photos: [photo] }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));
    hoisted.gateway.add.mockResolvedValueOnce([null, fresh]);
    addPicked("f1", [{ kind: "path", path: "/c.jpg", name: "c.jpg" }], "camera");
    await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    const options = hoisted.toast.mock.calls[0][1];
    expect(options.action.label).toBe("Take another");
    expect(options.duration).toBeUndefined();
    await vi.waitFor(() => expect(galleryActor.snapshot().context.batch).toBeNull());
  });

  test("camera batch with a duplicate keeps Take another, not Dismiss, for 10 s", async () => {
    hoisted.toast.mockClear();
    hoisted.gateway.add.mockResolvedValueOnce([null, photo]);
    addPicked("f1", [{ kind: "path", path: "/d.jpg", name: "d.jpg" }], "camera");
    await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    expect(hoisted.toast.mock.calls[0][0]).toContain("already");
    const options = hoisted.toast.mock.calls[0][1];
    expect(options.action.label).toBe("Take another");
    expect(options.duration).toBe(10_000);
  });
});
