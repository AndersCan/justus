// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { gallery } from "../machines/gallery-machine";
import { pickedPhotos } from "../machines/picked-photos-machine";
import { copy } from "../copy/copy";
import { photosAddRow } from "./gallery";
import * as picker from "./photo-picker";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const summer = { id: "f1", name: "Summer", role: "creator", members: 3 };
const viewerOnly = { id: "f2", name: "Home", role: "reader", members: 3, invite: { owner: "o" } };
const batch = {
  done: 2,
  total: 5,
  added: 2,
  duplicates: 0,
  failed: [],
  running: true,
  folderId: "f1",
};
const rowOf = (folders: object[], b: object | null = null) => {
  const host = document.createElement("div");
  document.body.append(host);
  const page = { folders, batch: b, busy: false, settled: true };
  render(photosAddRow(page as never) ?? "", host);
  return host;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Add photos on All and Added by me", () => {
  test("an album she can add to: the button shows", () => {
    const host = rowOf([summer]);
    expect(host.querySelector("wa-button")?.textContent).toContain(copy("gallery.add_photos"));
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("no album: no button", () => {
    expect(rowOf([]).querySelector("wa-button")).toBeNull();
  });

  test("only Viewer albums: no button", () => {
    expect(rowOf([viewerOnly]).querySelector("wa-button")).toBeNull();
  });

  test("tapping it opens the picker, handing over the picked-photos holder", () => {
    const pick = vi.spyOn(picker, "pickPhotos").mockResolvedValue();
    rowOf([summer]).querySelector("wa-button")!.dispatchEvent(new Event("click"));
    expect(pick).toHaveBeenCalledWith(pickedPhotos.picked);
  });

  test("adding: the button counts and is disabled, the bar shows", () => {
    const host = rowOf([summer], batch);
    const button = host.querySelector("wa-button");
    expect(button?.textContent).toContain(copy("gallery.adding", { current: 3, total: 5 }));
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  test("failures: the card shows with Retry, and Retry re-adds", () => {
    const retry = vi.spyOn(gallery, "retryFailed").mockImplementation(() => {});
    const failed = {
      ...batch,
      running: false,
      failed: [{ source: { kind: "path", path: "/a.jpg", name: "a.jpg" } }],
    };
    const host = rowOf([summer], failed);
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const buttons = [...alert!.querySelectorAll("button")];
    buttons.find((b) => b.textContent?.includes(copy("gallery.retry")))!.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("where the row is drawn, and which album its card names", () => {
  test("a failed batch in the second album: the card is that album's", () => {
    const winter = { id: "f3", name: "Winter", role: "creator", members: 1 };
    const failed = {
      ...batch,
      folderId: "f3",
      running: false,
      failed: [{ source: { kind: "path", path: "/a.jpg", name: "a.jpg" } }],
    };
    const alert = rowOf([summer, winter], failed).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Winter");
  });

  test("no Add photos row on the album grid or on an album page", async () => {
    const { foldersActor } = await import("../machines/folders-machine");
    const real = foldersActor.snapshot();
    vi.spyOn(foldersActor, "snapshot").mockReturnValue({
      ...real,
      path: ["showingAlbums"],
      context: { ...real.context, folders: [summer] },
    } as never);
    const { albumGridView, galleryView } = await import("./gallery");
    for (const view of [albumGridView(), galleryView({ kind: "album", id: "f1" })]) {
      const host = document.createElement("div");
      render(view, host);
      expect(host.querySelector('[data-copy-id="gallery.add_photos"]')).toBeNull();
    }
  });
});
