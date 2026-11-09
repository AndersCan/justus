import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { openLightbox, closeLightbox, step, deleteFromLightbox } from "./lightbox";
import { confirmAction } from "./confirm";
import { toast } from "./toast";
import { lightboxActor } from "../machines/lightbox-machine";
import { galleryActor, gallery } from "../machines/gallery-machine";
import { syncActor } from "../machines/sync-machine";
import type { Photo } from "@justus/core";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
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
      detail: "It will be gone from the album for everyone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    expect(confirmAction).toHaveBeenCalledWith({
      title: "Delete “b”?",
      detail: "It will be gone from the album for everyone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
  });

  it("names the phones that keep a copy", async () => {
    await reload([a, b]);
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    const holders = {
      here: true,
      others: [{ key: "n", name: "Nils" }],
      unsure: [],
      waiting: [],
      former: [],
      left: [],
    };
    await deleteFromLightbox({ ...a, holders });
    expect(confirmAction).toHaveBeenCalledWith(
      expect.objectContaining({
        detail:
          "It will be gone from the album for everyone. Nils's phone keeps a copy. Deleting can't take it back.",
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

  it("names whose albums drop it now and later", async () => {
    await reload([a, b]);
    vi.spyOn(syncActor, "snapshot").mockReturnValue(albumStatus());
    hoisted.gateway.remove.mockResolvedValue([null, undefined]);
    await deleteFromLightbox({ ...b, folderId: "f1" });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      "Deleted “b”. Ben's album drops it now, Cara's later, when connected.",
    );
    vi.mocked(syncActor.snapshot).mockRestore();
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
