// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { foldersActor } from "../machines/folders-machine";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { open } from "../machines/router-machine";
import { galleryView } from "./gallery";
import { copy } from "../copy/copy";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./toast", () => ({ toast: hoisted.toast }));

test("a failed batch on the All page with no album she can add to shows no progress bar or alert", async () => {
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

const realFolders = foldersActor.snapshot();
const summer = { id: "f1", name: "Summer", role: "creator", members: 1 };

test("with an album she can add to, a failed batch on All keeps its card and raises no toast", async () => {
  vi.spyOn(foldersActor, "snapshot").mockReturnValue({ context: { folders: [summer] } } as never);
  hoisted.toast.mockClear();
  open("/");
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany([{ kind: "path", path: "/a.jpg", name: "a.jpg" }], "f1");
  await vi.waitFor(() => expect(galleryActor.snapshot().context.batch?.running).toBe(false));
  await galleryActor.settled();
  expect(hoisted.toast).not.toHaveBeenCalled();
  gallery.dismissBatch();
});

test("a clean batch ending on All toasts with Open Summer, which goes to the album", async () => {
  hoisted.toast.mockClear();
  open("/");
  hoisted.gateway.add.mockResolvedValue([
    null,
    { id: "p", name: "p.jpg", folderId: "f1", url: "u", thumbUrl: "t", addedAt: 1 },
  ]);
  gallery.addMany(
    [
      { kind: "path", path: "/a.jpg", name: "a.jpg" },
      { kind: "path", path: "/b.jpg", name: "b.jpg" },
    ],
    "f1",
  );
  await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
  const options = hoisted.toast.mock.calls[0][1];
  expect(options.action.label).toBe(copy("add_photos.open_album", { album: "Summer" }));
  options.action.run();
  expect(location.pathname).toBe("/albums/f1");
});

test("on the album grid a failed batch still toasts: no add row there", async () => {
  hoisted.toast.mockClear();
  open("/albums");
  hoisted.gateway.add.mockReset();
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany([{ kind: "path", path: "/c.jpg", name: "c.jpg" }], "f1");
  await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
});

test("the page header draws Add photos on All and Added by me when she has an album to add to", async () => {
  vi.spyOn(foldersActor, "snapshot").mockReturnValue({
    path: ["showingAlbums"],
    context: { ...realFolders.context, folders: [summer] },
  } as never);
  const { render } = await import("lit-html");
  for (const kind of ["all", "mine"]) {
    const host = document.createElement("div");
    render(galleryView({ kind } as never), host);
    expect(host.querySelector("wa-button")?.textContent).toContain(copy("gallery.add_photos"));
  }
});

test("a failed batch for an album she can only view still toasts on All", async () => {
  const viewerOnly = { id: "f9", name: "Home", role: "reader", members: 2, invite: { owner: "o" } };
  vi.spyOn(foldersActor, "snapshot").mockReturnValue({
    context: { folders: [viewerOnly] },
  } as never);
  hoisted.toast.mockClear();
  open("/");
  hoisted.gateway.add.mockReset();
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany([{ kind: "path", path: "/d.jpg", name: "d.jpg" }], "f9");
  await vi.waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
});

test("on Added by me, a failed batch keeps its card and raises no toast", async () => {
  vi.spyOn(foldersActor, "snapshot").mockReturnValue({ context: { folders: [summer] } } as never);
  hoisted.toast.mockClear();
  open("/mine");
  hoisted.gateway.add.mockReset();
  hoisted.gateway.add.mockResolvedValueOnce([{ message: "boom" }, null]);
  gallery.addMany([{ kind: "path", path: "/e.jpg", name: "e.jpg" }], "f1");
  await vi.waitFor(() => expect(galleryActor.snapshot().context.batch?.running).toBe(false));
  await galleryActor.settled();
  expect(hoisted.toast).not.toHaveBeenCalled();
  gallery.dismissBatch();
});
