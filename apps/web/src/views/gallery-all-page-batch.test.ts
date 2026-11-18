// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { open } from "../machines/router-machine";
import { galleryView } from "./gallery";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

test("a failed batch on the All page shows no progress bar or alert", async () => {
  hoisted.gateway.list.mockResolvedValue([null, { photos: [] }]);
  gallery.load();
  await vi.waitFor(() => expect(galleryActor.snapshot().path[0]).toBe("showingPhotos"));
  open("/photos");
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany([{ kind: "path", path: "/a.jpg", name: "a.jpg" }], "f1");
  await vi.waitFor(() => expect(galleryActor.snapshot().context.batch?.running).toBe(false));
  const host = document.createElement("div");
  const { render } = await import("lit-html");
  render(galleryView({ kind: "all" } as never), host);
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
