// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import {
  addPicked,
  addableAlbum,
  pickedPhotosInput,
  pickerInput,
  pickPhotos,
  startAdd,
} from "./photo-picker";
import { copy } from "../copy/copy";
import { foldersActor } from "../machines/folders-machine";
import { syncActor } from "../machines/sync-machine";
import { gallery, galleryActor } from "../machines/gallery-machine";
import { toast } from "./toast";

vi.mock("./toast", () => ({ toast: vi.fn() }));
const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), media: { pickMany: vi.fn() } },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));

afterEach(() => vi.restoreAllMocks());

describe("pickerInput", () => {
  test("a pick adds the images to the album and tells the page once", () => {
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    const onAdding = vi.fn();
    const host = document.createElement("div");
    render(pickerInput("f1", onAdding), host);
    const input = host.querySelector("input")!;
    const file = new File(["x"], "a.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(addMany).toHaveBeenCalledWith([{ kind: "file", file }], "f1");
    expect(onAdding).toHaveBeenCalledTimes(1);
  });

  test("no images: nothing is added and the page is not told", () => {
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    addMany.mockClear();
    const onAdding = vi.fn();
    const host = document.createElement("div");
    render(pickerInput("f1", onAdding), host);
    const input = host.querySelector("input")!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "a.txt", { type: "text/plain" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
    expect(addMany).not.toHaveBeenCalled();
    expect(onAdding).not.toHaveBeenCalled();
  });
});

describe("addPicked", () => {
  const source = [{ kind: "path" as const, path: "/a.jpg", name: "a.jpg" }];

  test("while a batch runs it says so and adds nothing", () => {
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    const snapshot = galleryActor.snapshot();
    vi.spyOn(galleryActor, "snapshot").mockReturnValue({
      ...snapshot,
      context: { ...snapshot.context, batch: { running: true } },
    } as never);
    expect(addPicked("f1", source, "library")).toBe(false);
    expect(toast).toHaveBeenCalledWith("Still adding the last photos. Try again in a moment");
    expect(addMany).not.toHaveBeenCalled();
  });

  test("otherwise it starts the batch", () => {
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    expect(addPicked("f1", source, "library")).toBe(true);
    expect(addMany).toHaveBeenCalledWith(source, "f1");
  });
});

describe("startAdd in the native shell", () => {
  afterEach(() => {
    (window as { BareShell?: boolean }).BareShell = false;
  });

  test("a pick tells the page; a cancel adds nothing, says nothing", async () => {
    (window as { BareShell?: boolean }).BareShell = true;
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({
      context: { folders: [{ id: "f1", name: "Trip", role: "creator", members: 1 }] },
    } as never);
    const onAdding = vi.fn();
    hoisted.gateway.media.pickMany.mockResolvedValueOnce([
      undefined,
      { items: [{ path: "/a.jpg", name: "a.jpg" }] },
    ]);
    await startAdd("f1", "library", onAdding);
    expect(addMany).toHaveBeenCalledTimes(1);
    expect(onAdding).toHaveBeenCalledTimes(1);

    hoisted.gateway.media.pickMany.mockResolvedValueOnce([new Error("cancelled"), undefined]);
    vi.mocked(toast).mockClear();
    await startAdd("f1", "library", onAdding);
    expect(onAdding).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  test("a batch already running: the pick does not tell the page", async () => {
    (window as { BareShell?: boolean }).BareShell = true;
    const addMany = vi.spyOn(gallery, "addMany").mockImplementation(() => {});
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({
      context: { folders: [{ id: "f1", name: "Trip", role: "creator", members: 1 }] },
    } as never);
    const real = galleryActor.snapshot();
    vi.spyOn(galleryActor, "snapshot").mockReturnValue({
      ...real,
      context: { ...real.context, batch: { running: true } },
    } as never);
    const onAdding = vi.fn();
    hoisted.gateway.media.pickMany.mockResolvedValueOnce([
      undefined,
      { items: [{ path: "/a.jpg", name: "a.jpg" }] },
    ]);
    await startAdd("f1", "library", onAdding);
    expect(addMany).not.toHaveBeenCalled();
    expect(onAdding).not.toHaveBeenCalled();
  });
});

describe("addableAlbum on a pending album", () => {
  test("names the person who invited you when the Admin is not known", () => {
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({
      context: { folders: [{ id: "f1", name: "Trip", role: "reader", pending: true, members: 2 }] },
    } as never);
    expect(addableAlbum("f1")).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      "You can add photos to “Trip” once the person who invited you lets you in",
    );
  });
});

describe("addableAlbum on a pending album whose Admin is known", () => {
  test("names the Admin from this album's member list", () => {
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({
      context: { folders: [{ id: "f1", name: "Trip", role: "reader", pending: true, members: 2 }] },
    } as never);
    vi.spyOn(syncActor, "snapshot").mockReturnValue({
      context: { status: { folder: { id: "f1" }, members: [{ name: "Ada", admin: true }] } },
    } as never);
    expect(addableAlbum("f1")).toBeNull();
    expect(toast).toHaveBeenCalledWith("You can add photos to “Trip” once Ada lets you in");
  });
});

describe("pickPhotos", () => {
  afterEach(() => {
    (window as { BareShell?: boolean }).BareShell = false;
  });

  test("native: the host's items arrive once, in picked order; a cancel says nothing", async () => {
    (window as { BareShell?: boolean }).BareShell = true;
    const onPicked = vi.fn();
    hoisted.gateway.media.pickMany.mockResolvedValueOnce([
      undefined,
      {
        items: [
          { path: "/b.jpg", name: "b.jpg" },
          { path: "/a.jpg", name: "a.jpg" },
        ],
      },
    ]);
    await pickPhotos(onPicked);
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(onPicked).toHaveBeenCalledWith([
      { kind: "path", path: "/b.jpg", name: "b.jpg" },
      { kind: "path", path: "/a.jpg", name: "a.jpg" },
    ]);

    hoisted.gateway.media.pickMany.mockResolvedValueOnce([new Error("cancelled"), undefined]);
    vi.mocked(toast).mockClear();
    await pickPhotos(onPicked);
    expect(onPicked).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  test("browser: it opens the file chooser; the files arrive in the order chosen", async () => {
    const onPicked = vi.fn();
    const host = document.createElement("div");
    render(pickedPhotosInput(onPicked), host);
    const input = host.querySelector("input")!;
    const click = vi.spyOn(input, "click");
    await pickPhotos(onPicked);
    expect(click).toHaveBeenCalledTimes(1);
    const two = new File(["x"], "2.png", { type: "image/png" });
    const one = new File(["x"], "1.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [two, one], configurable: true });
    input.dispatchEvent(new Event("change"));
    expect(onPicked).toHaveBeenCalledWith([
      { kind: "file", file: two },
      { kind: "file", file: one },
    ]);
  });

  test("browser: no image says so and picks nothing", () => {
    const onPicked = vi.fn();
    vi.mocked(toast).mockClear();
    const host = document.createElement("div");
    render(pickedPhotosInput(onPicked), host);
    const input = host.querySelector("input")!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "a.txt", { type: "text/plain" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
    expect(onPicked).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(copy("gallery.only_photos_can_be_added"));
  });
});
