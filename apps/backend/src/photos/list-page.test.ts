import { describe, expect, test } from "vite-plus/test";
import { listPage } from "./list-page";
import type { Photo } from "@justus/core";

const HEADER_LIMIT = 65_535;

function photoNumbered(index: number): Photo {
  const key = String(index).padStart(64, "0");
  const path = "x".repeat(120);
  return {
    id: `photo-${index}`,
    url: `http://127.0.0.1:9000/photos/album/${path}${index}`,
    name: `holiday-${index}.jpg`,
    mime: "image/jpeg",
    size: 1000 + index,
    addedAt: 1_700_000_000_000 + index,
    member: { key, name: "Ada" },
    sha256: key,
    folderId: "album",
    mine: true,
    holders: {
      kind: "inAlbum",
      here: true,
      previewHere: false,
      others: [{ key, name: "Ben", connected: true, color: 1 }],
      quiet: [],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
      yourColor: 0,
    },
  };
}

function headerBytes(result: unknown): number {
  const envelope = {
    type: "INVOKE_RESPONSE",
    pluginId: "justus.photos",
    event: "photos.list",
    requestId: "r".repeat(36),
    result,
  };
  return Buffer.byteLength(JSON.stringify(envelope));
}

describe("listPage", () => {
  test("a list too big for one invoke header comes back in pages that each fit and add up to every photo", () => {
    const photos = Array.from({ length: 400 }, (_, index) => photoNumbered(index));
    expect(headerBytes({ photos })).toBeGreaterThan(HEADER_LIMIT);
    const pages = [listPage(photos, { from: 0 })];
    while (pages.at(-1)?.next !== undefined) {
      pages.push(listPage(photos, { from: pages.at(-1)?.next ?? 0 }));
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(headerBytes(page)).toBeLessThan(HEADER_LIMIT);
    expect(pages.flatMap((page) => page.photos)).toEqual(photos);
  });

  test("a small list is one page with no next", () => {
    const photos = [photoNumbered(1), photoNumbered(2)];
    expect(listPage(photos, { from: 0 })).toEqual({ photos });
  });

  test("a photo bigger than the budget still gets a page of its own", () => {
    const photos = [photoNumbered(1), photoNumbered(2)];
    expect(listPage(photos, { from: 0, budget: 10 })).toEqual({ photos: [photos[0]], next: 1 });
    expect(listPage(photos, { from: 1, budget: 10 })).toEqual({ photos: [photos[1]] });
  });

  test("a start that is not a whole number reads from the first photo", () => {
    const photos = [photoNumbered(1)];
    expect(listPage(photos, { from: -3 })).toEqual({ photos });
    expect(listPage(photos, { from: Number.NaN })).toEqual({ photos });
  });
});
