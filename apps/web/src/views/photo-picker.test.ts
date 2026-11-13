// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { addPicked, addableAlbum, pickerInput, startAdd } from "./photo-picker";
import { foldersActor } from "../machines/folders-machine";
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
