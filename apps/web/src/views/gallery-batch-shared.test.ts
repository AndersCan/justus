// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { addPicked } from "./photo-picker";
import "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  addEnded: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../machines/shared-photos-machine", () => ({
  sharedPhotos: { addEnded: hoisted.addEnded },
}));

const photo = { id: "p1", name: "p1.jpg", folderId: "f1", url: "u", thumbUrl: "t", addedAt: 1 };
const fresh = { ...photo, id: "p2", name: "p2.jpg" };

describe("a shared batch tells the sharedPhotos machine when it ends", () => {
  test("a clean shared batch sends addEnded(0); a library batch sends nothing", async () => {
    hoisted.gateway.list.mockResolvedValue([null, { photos: [photo] }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));

    hoisted.gateway.add.mockResolvedValueOnce([null, fresh]);
    addPicked("f1", [{ kind: "path", path: "/a.jpg", name: "a.jpg" }], "shared");
    await vi.waitFor(() => expect(hoisted.addEnded).toHaveBeenCalledWith(0));
    await vi.waitFor(() => expect(galleryActor.snapshot().context.batch).toBeNull());

    hoisted.addEnded.mockClear();
    hoisted.gateway.add.mockResolvedValueOnce([null, { ...fresh, id: "p3", name: "p3.jpg" }]);
    addPicked("f1", [{ kind: "path", path: "/b.jpg", name: "b.jpg" }], "library");
    await vi.waitFor(() => expect(galleryActor.snapshot().context.batch).toBeNull());
    expect(hoisted.addEnded).not.toHaveBeenCalled();
  });

  test("a shared batch with a failure sends addEnded(1) and stays on the page", async () => {
    hoisted.addEnded.mockClear();
    hoisted.gateway.add.mockResolvedValueOnce([new Error("disk"), null]);
    addPicked("f1", [{ kind: "path", path: "/c.jpg", name: "c.jpg" }], "shared");
    await vi.waitFor(() => expect(hoisted.addEnded).toHaveBeenCalledWith(1));
    expect(galleryActor.snapshot().context.batch?.failed.length).toBe(1);
  });
});
