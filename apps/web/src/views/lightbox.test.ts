import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { openLightbox, closeLightbox, step } from "./lightbox";
import { lightboxActor } from "../machines/lightbox-machine";
import { galleryActor, gallery } from "../machines/gallery-machine";
import type { Photo } from "@justus/core";

const hoisted = vi.hoisted(() => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));
vi.mock("../gateway", () => ({ gateway: hoisted.gateway }));

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
