// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { open } from "../machines/router-machine";
import "./gallery";
import { addPicked } from "./photo-picker";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

const photo = { id: "p1", name: "p1.jpg", folderId: "f1", url: "u", thumbUrl: "t", addedAt: 1 };
const batchOf = () => galleryActor.snapshot().context.batch;
const paths = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({
    kind: "path" as const,
    path: `/${tag}${i}.jpg`,
    name: `${tag}${i}.jpg`,
  }));

test("a batch for f1 that ends on another album's page toasts with Open, and the Open goes to f1", async () => {
  hoisted.gateway.list.mockResolvedValue([null, { photos: [] }]);
  gallery.load();
  await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));
  open("/albums/f2");
  hoisted.gateway.add.mockImplementation(async () => [null, { ...photo, id: `s${Math.random()}` }]);
  gallery.addMany(paths(2, "s"), "f1");
  await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
  const options = hoisted.toast.mock.calls[0][1];
  expect(options.action.label).toBe("Open the album");
  options.action.run();
  expect(location.pathname).toBe("/albums/f1");
  hoisted.gateway.add.mockReset();
  await vi.waitFor(() => expect(batchOf()).toBeNull());
});

test("a batch with a failure that ends off its album still says so, with Open, and keeps the card", async () => {
  hoisted.toast.mockClear();
  open("/albums/f2");
  hoisted.gateway.add.mockResolvedValueOnce([null, { ...photo, id: "ok1" }]);
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany(paths(2, "f"), "f1");
  await vi.waitFor(() => expect(batchOf()?.running).toBe(false));
  await galleryActor.settled();
  await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
  expect(hoisted.toast.mock.calls[0][0]).toContain("couldn't be added");
  expect(hoisted.toast.mock.calls[0][1].action.label).toBe("Open the album");
  expect(batchOf()?.failed).toHaveLength(1);
});

test("a batch with a failure that ends on its own album raises no toast and keeps the card", async () => {
  await vi.waitFor(() => expect(batchOf()).not.toBeNull());
  gallery.dismissBatch();
  hoisted.toast.mockClear();
  open("/albums/f1");
  hoisted.gateway.add.mockResolvedValue([null, { ...photo, id: "g-ok" }]);
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany(paths(5, "g"), "f1");
  await vi.waitFor(() => expect(batchOf()?.running).toBe(false));
  await galleryActor.settled();
  expect(hoisted.toast).not.toHaveBeenCalled();
  expect(batchOf()?.failed).toHaveLength(1);
});

test("a camera batch with a failure off its album offers Open, not Take another", async () => {
  gallery.dismissBatch();
  hoisted.toast.mockClear();
  open("/albums/f2");
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  addPicked("f1", paths(1, "h"), "camera");
  await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
  expect(hoisted.toast.mock.calls[0][1].action.label).toBe("Open the album");
});
