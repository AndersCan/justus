import { describe, it, expect, afterEach } from "vite-plus/test";
import { $lightbox, openLightbox, closeLightbox, step } from "./lightbox";
import { $photos } from "../machines/gallery-machine";
import type { Photo } from "@justus/core";

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

describe("lightbox navigation", () => {
  afterEach(() => {
    closeLightbox();
    $photos.set([]);
  });

  it("steps forward and wraps from the last photo back to the first", () => {
    const photos = [photo("a"), photo("b"), photo("c")];
    $photos.set(photos);
    openLightbox(photos[0]);
    step(1);
    expect($lightbox.get()?.id).toBe("b");
    step(1);
    expect($lightbox.get()?.id).toBe("c");
    step(1);
    expect($lightbox.get()?.id).toBe("a");
  });

  it("steps backward and wraps from the first photo to the last", () => {
    const photos = [photo("a"), photo("b")];
    $photos.set(photos);
    openLightbox(photos[0]);
    step(-1);
    expect($lightbox.get()?.id).toBe("b");
    step(-1);
    expect($lightbox.get()?.id).toBe("a");
  });

  it("leaves the open photo unchanged when it is no longer in the gallery", () => {
    const photos = [photo("a"), photo("b")];
    $photos.set(photos);
    openLightbox(photo("ghost"));
    step(1);
    expect($lightbox.get()?.id).toBe("ghost");
  });

  it("does nothing and throws nothing with no open photo", () => {
    $photos.set([photo("a")]);
    expect(() => step(1)).not.toThrow();
    expect($lightbox.get()).toBeNull();
  });
});
