// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render } from "lit-html";
import { openLightbox, closeLightbox, step, deleteFromLightbox, lightboxView } from "./lightbox";
import { confirmAction } from "./confirm";
import { toast } from "./toast";
import { lightboxActor } from "../machines/lightbox-machine";
import { galleryActor, gallery } from "../machines/gallery-machine";
import { folders } from "../machines/folders-machine";
import { syncActor } from "../machines/sync-machine";
import { friendsActor } from "../machines/friends-machine";
import type { Photo } from "@justus/core";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn(), folders: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));
vi.mock("./confirm", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

function photo(id: string): Photo {
  return {
    id,
    url: `blob:${id}`,
    name: id,
    mime: "image/jpeg",
    size: 1,
    addedAt: 0,
    member: { key: "m", name: "M" },
  };
}

const setPhotos = (photos: Photo[]) =>
  vi.spyOn(galleryActor, "snapshot").mockReturnValue({ context: { photos } } as never);

describe("lightbox navigation", () => {
  afterEach(() => {
    closeLightbox();
    vi.restoreAllMocks();
  });

  it("steps forward and wraps from the last photo back to the first", () => {
    const photos = [photo("a"), photo("b"), photo("c")];
    setPhotos(photos);
    openLightbox(photos[0]);
    step(1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("b");
    step(1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("c");
    step(1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("a");
  });

  it("steps backward and wraps from the first photo to the last", () => {
    const photos = [photo("a"), photo("b")];
    setPhotos(photos);
    openLightbox(photos[0]);
    step(-1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("b");
    step(-1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("a");
  });

  it("leaves the open photo unchanged when it is no longer in the gallery", () => {
    const photos = [photo("a"), photo("b")];
    setPhotos(photos);
    openLightbox(photo("ghost"));
    step(1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("ghost");
  });

  it("does nothing and throws nothing with no open photo", () => {
    setPhotos([photo("a")]);
    expect(() => step(1)).not.toThrow();
    expect(lightboxActor.snapshot().context.photo).toBeUndefined();
  });
  it("steps within the grid it was opened from, not every photo", () => {
    const all = [photo("a"), photo("b"), photo("c")];
    setPhotos(all);
    openLightbox(all[0], [all[0], all[2]]);
    step(1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("c");
  });

  it("close clears the photo", () => {
    openLightbox(photo("a"));
    closeLightbox();
    expect(lightboxActor.snapshot().context.photo).toBeUndefined();
  });
});

describe("lightbox follows the album", () => {
  const reload = async (photos: Photo[]) => {
    hoisted.gateway.list.mockResolvedValueOnce([null, { photos }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().context.photos).toEqual(photos));
  };

  afterEach(() => {
    closeLightbox();
  });

  it("a photo deleted elsewhere closes the open view", async () => {
    const [a, b, c] = [photo("a"), photo("b"), photo("c")];
    await reload([a, b, c]);
    openLightbox(b, [a, b, c]);
    await reload([a, c]);
    await vi.waitFor(() => expect(lightboxActor.snapshot().context.photo).toBeUndefined());
  });

  it("after a delete elsewhere, stepping skips the deleted photo", async () => {
    const [a, b, c] = [photo("a"), photo("b"), photo("c")];
    await reload([a, b, c]);
    openLightbox(a, [a, b, c]);
    await reload([a, c]);
    step(1);
    expect(lightboxActor.snapshot().context.photo?.id).toBe("c");
  });
});

describe("Delete", () => {
  const reload = async (photos: Photo[]) => {
    hoisted.gateway.list.mockResolvedValueOnce([null, { photos }]);
    gallery.load();
    await vi.waitFor(() => expect(galleryActor.snapshot().context.photos).toEqual(photos));
  };
  const [a, b] = [photo("a"), photo("b")];

  afterEach(() => {
    closeLightbox();
    vi.clearAllMocks();
    vi.mocked(confirmAction).mockResolvedValue(true);
  });

  it("asks once, in one sentence for everyone", async () => {
    await reload([a, b]);
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    for (const p of [
      { ...a, mine: true },
      { ...b, mine: false },
    ]) {
      await deleteFromLightbox(p);
      await vi.waitFor(() => expect(galleryActor.snapshot().context.photos).not.toContain(p));
      await reload([a, b]);
    }
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Delete “a”?",
      detail:
        "It will be gone from the album for everyone. Copies saved outside Justus can't be taken back.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Delete “b”?",
      detail:
        "It will be gone from the album for everyone. Copies saved outside Justus can't be taken back.",
      confirmLabel: "Delete",
      tone: "danger",
    });
  });

  it("names the phones Justus can't erase", async () => {
    await reload([a, b]);
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    const holders = {
      kind: "inAlbum" as const,
      here: true,
      others: [{ key: "n", name: "Nils" }],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
    };
    await deleteFromLightbox({ ...a, holders });
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        detail:
          "It will be gone from the album for everyone. Nils has the full photo. It's removed from their phone the next time they open Justus. Copies saved outside Justus can't be taken back.",
      }),
    );
  });

  it("keeps the photo open until the album answers, then closes it", async () => {
    await reload([a, b]);
    openLightbox(b, [a, b]);
    let done!: (r: [null, undefined]) => void;
    hoisted.gateway.remove.mockReturnValue(new Promise((r) => (done = r)));
    await deleteFromLightbox(b);
    await vi.waitFor(() => expect(hoisted.gateway.remove).toHaveBeenCalled());
    expect(lightboxActor.snapshot().context.photo?.id).toBe("b");
    done([null, undefined]);
    await vi.waitFor(() => expect(lightboxActor.snapshot().context.photo).toBeUndefined());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Deleted “b”.");
  });

  const member = (name: string, connected: boolean) => ({
    key: name,
    name,
    admin: false,
    connected,
  });
  const albumStatus = () =>
    ({
      context: {
        status: {
          folder: { id: "f1" },
          members: [member("Ada", true), member("Ben", true), member("Cara", false)],
        },
      },
    }) as never;

  const holdersOf = (others: { key: string; name: string }[]) => ({
    kind: "inAlbum" as const,
    here: true,
    others,
    unsure: [],
    waiting: [],
    previews: [],
    former: [],
    left: [],
  });

  it("names who has the full photo and who sees it's gone later", async () => {
    await reload([a, b]);
    vi.spyOn(syncActor, "snapshot").mockReturnValue(albumStatus());
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox({
      ...b,
      folderId: "f1",
      holders: holdersOf([
        { key: "Ben", name: "Ben" },
        { key: "Cara", name: "Cara" },
      ]),
    });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      "Deleted “b”. Ben and Cara have the full photo. Cara will see it's gone when connected.",
    );
    vi.mocked(syncActor.snapshot).mockRestore();
  });

  it("uses the saved friend name for a member", async () => {
    await reload([a, b]);
    vi.spyOn(syncActor, "snapshot").mockReturnValue({
      context: {
        status: {
          folder: { id: "f1" },
          members: [member("Ada", true), { ...member("Ben", true), identity: "id-ben" }],
        },
      },
    } as never);
    vi.spyOn(friendsActor, "snapshot").mockReturnValue({
      context: { friends: { "id-ben": "Benny" } },
    } as never);
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox({
      ...b,
      folderId: "f1",
      holders: holdersOf([{ key: "Ben", name: "Ben" }]),
    });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("Deleted “b”. Benny has the full photo.");
    vi.mocked(syncActor.snapshot).mockRestore();
    vi.mocked(friendsActor.snapshot).mockRestore();
  });

  it("names nobody when the photo is not in the open album", async () => {
    await reload([a, b]);
    vi.spyOn(syncActor, "snapshot").mockReturnValue(albumStatus());
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox({ ...b, folderId: "f2" });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("Deleted “b”.");
    vi.mocked(syncActor.snapshot).mockRestore();
  });

  it("a photo that was already gone leaves the list without a message", async () => {
    await reload([a, b]);
    hoisted.gateway.remove.mockResolvedValue([
      { code: "justus.photos/not-found", message: "gone" },
      null,
    ]);
    await deleteFromLightbox(b);
    await vi.waitFor(() => expect(galleryActor.snapshot().context.photos).toEqual([a]));
    expect(toast).not.toHaveBeenCalled();
  });

  it("a failed delete keeps the photo open and says so", async () => {
    await reload([a, b]);
    openLightbox(b, [a, b]);
    hoisted.gateway.remove.mockResolvedValue([new Error("nope"), null]);
    await deleteFromLightbox(b);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("Couldn't delete “b”. Try again.");
    expect(lightboxActor.snapshot().context.photo?.id).toBe("b");
  });

  it("Keep does nothing", async () => {
    await reload([a, b]);
    vi.mocked(confirmAction).mockResolvedValue(false);
    await deleteFromLightbox(b);
    expect(hoisted.gateway.remove).not.toHaveBeenCalled();
  });
});

describe("the photo card", () => {
  afterEach(() => {
    closeLightbox();
    vi.restoreAllMocks();
  });

  it("shows the photo, not its file name, and keeps the name as alt text", () => {
    const p = { ...photo("holiday-001.jpg"), url: "blob:x" };
    setPhotos([p]);
    openLightbox(p);
    const host = document.createElement("div");
    render(lightboxView(), host);
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("holiday-001.jpg");
    expect(host.textContent).not.toContain("holiday-001.jpg");
    render(null, host);
  });

  it("draws its More options as the round icon button", async () => {
    const p = { ...photo("a"), folderId: "f", mine: true };
    vi.spyOn(galleryActor, "snapshot").mockReturnValue({
      context: { photos: [p] },
      path: [],
    } as never);
    hoisted.gateway.folders.mockResolvedValue([
      null,
      { folders: [{ id: "f", name: "F", role: "creator" }], activeFolderId: null },
    ]);
    folders.refresh();
    await vi.waitFor(() => expect(folders.state()).toBe("showingAlbums"));
    openLightbox(p);
    const host = document.createElement("div");
    render(lightboxView(), host);
    expect(host.querySelector("[aria-label='More options']")?.className).toBe("ui-icon-btn");
    render(null, host);
  });
});

describe("tapping the photo", () => {
  afterEach(() => {
    closeLightbox();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const mount = () => {
    const photos = [photo("a"), photo("b")];
    setPhotos(photos);
    openLightbox(photos[0]);
    const el = document.createElement("div");
    document.body.append(el);
    render(lightboxView(), el);
    return el;
  };
  const controls = (el: Element) =>
    el.querySelector("[data-controls]")?.getAttribute("data-controls");
  const tapPhoto = (el: Element) =>
    (el.querySelector('[data-part="photo"]') as HTMLElement).click();

  it("hides the controls and shows them again, keeping the photo open", () => {
    const el = mount();
    expect(controls(el)).toBe("shown");
    tapPhoto(el);
    expect(controls(el)).toBe("hidden");
    expect(lightboxActor.snapshot().context.photo?.id).toBe("a");
    tapPhoto(el);
    expect(controls(el)).toBe("shown");
  });

  it("ignores a tap on the info bar", () => {
    const el = mount();
    (el.querySelector('[data-part="info"]') as HTMLElement).click();
    expect(controls(el)).toBe("shown");
  });

  it("ignores a tap that only closes the menu", () => {
    const el = mount();
    const menu = document.createElement("wa-dropdown");
    menu.setAttribute("open", "");
    document.body.append(menu);
    el.firstElementChild?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    menu.remove();
    tapPhoto(el);
    expect(controls(el)).toBe("shown");
    el.firstElementChild?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    tapPhoto(el);
    expect(controls(el)).toBe("hidden");
  });

  it("keeps the controls hidden while stepping with the keys", () => {
    const el = mount();
    tapPhoto(el);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(lightboxActor.snapshot().context.photo?.id).toBe("b");
    expect(controls(el)).toBe("hidden");
  });

  // Last: a swipe suppresses taps for 350 ms, module-wide.
  it("ignores the click that follows a swipe", () => {
    const el = mount();
    const root = el.firstElementChild as Element;
    const touch = (type: string, x: number) => {
      const e = new Event(type, { bubbles: true });
      const list = [{ clientX: x, clientY: 0 }];
      Object.assign(e, { touches: list, changedTouches: list });
      root.dispatchEvent(e);
    };
    touch("touchstart", 300);
    touch("touchend", 100);
    tapPhoto(el);
    expect(controls(el)).toBe("shown");
  });
});

describe("the viewer's buttons", () => {
  afterEach(() => {
    closeLightbox();
    document.body.innerHTML = "";
  });

  const mount = () => {
    const photos = [photo("a"), photo("b"), photo("c")];
    setPhotos(photos);
    openLightbox(photos[0]);
    const el = document.createElement("div");
    document.body.append(el);
    render(lightboxView(), el);
    return el;
  };
  const press = (el: Element, label: string) =>
    (el.querySelector(`button[aria-label="${label}"]`) as HTMLElement).click();

  it("Close closes the photo", () => {
    const el = mount();
    press(el, "Close");
    expect(lightboxActor.snapshot().context.photo).toBeUndefined();
  });

  it("Next steps forward and Previous steps back", () => {
    const el = mount();
    press(el, "Next photo");
    expect(lightboxActor.snapshot().context.photo?.id).toBe("b");
    press(el, "Previous photo");
    press(el, "Previous photo");
    expect(lightboxActor.snapshot().context.photo?.id).toBe("c");
  });
});

describe("the photo grows and shrinks", () => {
  type Doc = { startViewTransition?: unknown };
  afterEach(() => {
    closeLightbox();
    delete (document as Doc).startViewTransition;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders the viewer inside the open update and removes it inside the close update", () => {
    window.matchMedia = (() => ({ matches: false })) as never;
    const host = document.createElement("div");
    document.body.append(host);
    render(lightboxView(), host);
    const figure = document.createElement("figure");
    figure.dataset.photoTile = "/a";
    document.body.append(figure);
    const seen: boolean[] = [];
    const afterUpdate: (string | null)[] = [];
    let closing = false;
    (document as Doc).startViewTransition = (cb: () => void) => {
      cb();
      seen.push(
        closing
          ? host.querySelector("[data-lightbox]") === null
          : host.querySelector("[data-lightbox] [data-part=photo]") !== null,
      );
      if (closing) afterUpdate.push(figure.getAttribute("data-vt"));
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    };
    openLightbox(photo("a"));
    expect(seen).toEqual([true]);
    closing = true;
    closeLightbox();
    expect(seen).toEqual([true, true]);
    expect(afterUpdate).toEqual(["photo"]);
    render(null, host);
  });

  it("draws the grid's thumbnail under the photo, and nothing when there is none", () => {
    const host = document.createElement("div");
    render(lightboxView(), host);
    openLightbox({ ...photo("a"), thumbUrl: "blob:t" });
    expect(host.querySelector("[data-part=placeholder]")?.getAttribute("src")).toBe("blob:t");
    closeLightbox();
    openLightbox(photo("b"));
    expect(host.querySelector("[data-part=placeholder]")).toBeNull();
    render(null, host);
  });
});
