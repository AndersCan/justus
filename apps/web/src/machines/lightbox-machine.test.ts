import { describe, expect, test } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import type { Photo } from "@justus/core";
import { createLightboxActor, lightboxEvents } from "./lightbox-machine";

function photo(id: string, folderId = "f"): Photo {
  return {
    id,
    folderId,
    url: `blob:${id}`,
    name: id,
    mime: "image/jpeg",
    size: 1,
    addedAt: 0,
    member: { key: "m", name: "M" },
  };
}

const make = () => createLightboxActor({ clock: VirtualClock() });
const open = (a: ReturnType<typeof make>, p: Photo, within?: Photo[]) =>
  a.send(lightboxEvents.opened.create({ photo: p, within }));
const step = (a: ReturnType<typeof make>, dir: 1 | -1, photos: Photo[]) =>
  a.send(lightboxEvents.stepped.create({ dir, photos }));
const id = (a: ReturnType<typeof make>) => a.snapshot().context.photo?.id;

describe("lightbox machine", () => {
  test("starts closed", () => {
    const a = make();
    expect(a.snapshot().path[0]).toBe("noPhotoOpen");
    expect(id(a)).toBeUndefined();
  });

  test("opening shows the photo and remembers the grid", () => {
    const a = make();
    const ps = [photo("a"), photo("b")];
    open(a, ps[0], ps);
    expect(a.snapshot().path[0]).toBe("showingPhoto");
    expect(a.snapshot().context.sequence).toBe(ps);
  });

  test("step forward wraps from last to first", () => {
    const a = make();
    const ps = [photo("a"), photo("b"), photo("c")];
    open(a, ps[0]);
    step(a, 1, ps);
    expect(id(a)).toBe("b");
    step(a, 1, ps);
    step(a, 1, ps);
    expect(id(a)).toBe("a");
  });

  test("step backward wraps from first to last", () => {
    const a = make();
    const ps = [photo("a"), photo("b")];
    open(a, ps[0]);
    step(a, -1, ps);
    expect(id(a)).toBe("b");
  });

  test("a photo missing from the list is left as it is", () => {
    const a = make();
    open(a, photo("ghost"));
    step(a, 1, [photo("a")]);
    expect(id(a)).toBe("ghost");
  });

  test("the same id in another album is a different photo", () => {
    const a = make();
    const ps = [photo("a", "f1"), photo("a", "f2")];
    open(a, ps[1]);
    step(a, 1, ps);
    expect(a.snapshot().context.photo).toBe(ps[0]);
  });

  test("stepping while closed does nothing", () => {
    const a = make();
    step(a, 1, [photo("a")]);
    expect(a.snapshot().path[0]).toBe("noPhotoOpen");
    expect(id(a)).toBeUndefined();
  });

  test("close clears the photo and the grid", () => {
    const a = make();
    open(a, photo("a"), [photo("a")]);
    a.send(lightboxEvents.closed.create());
    expect(a.snapshot().path[0]).toBe("noPhotoOpen");
    expect(a.snapshot().context).toEqual({ photo: undefined, sequence: undefined });
  });

  test("opening another photo while open replaces it", () => {
    const a = make();
    open(a, photo("a"));
    open(a, photo("b"));
    expect(id(a)).toBe("b");
  });

  const listChanged = (a: ReturnType<typeof make>, photos: Photo[]) =>
    a.send(lightboxEvents.photoListChanged.create({ photos }));

  test("a new photo list without the open photo closes the view", () => {
    const a = make();
    const [pa, pb, pc] = [photo("a"), photo("b"), photo("c")];
    open(a, pb, [pa, pb, pc]);
    listChanged(a, [pa, pc]);
    expect(a.snapshot().path[0]).toBe("noPhotoOpen");
    expect(a.snapshot().context.photo).toBeUndefined();
    expect(a.snapshot().context.sequence).toBeUndefined();
  });

  test("a new photo list drops deleted photos from the steps", () => {
    const a = make();
    const [pa, pb, pc] = [photo("a"), photo("b"), photo("c")];
    open(a, pa, [pa, pb, pc]);
    listChanged(a, [pa, pc]);
    expect(a.snapshot().path[0]).toBe("showingPhoto");
    step(a, 1, a.snapshot().context.sequence ?? []);
    expect(id(a)).toBe("c");
  });

  test("the same id in another album keeps the view open", () => {
    const a = make();
    open(a, photo("a", "f1"));
    listChanged(a, [photo("a", "f2"), photo("a", "f1")]);
    expect(a.snapshot().path[0]).toBe("showingPhoto");
  });

  test("a new photo list while closed does nothing", () => {
    const a = make();
    listChanged(a, [photo("a")]);
    expect(a.snapshot().path[0]).toBe("noPhotoOpen");
  });

  test("a view opened without a grid keeps stepping through every photo", () => {
    const a = make();
    open(a, photo("a"));
    listChanged(a, [photo("a"), photo("b")]);
    expect(a.snapshot().context.sequence).toBeUndefined();
  });
});
