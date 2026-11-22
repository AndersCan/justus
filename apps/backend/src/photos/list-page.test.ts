import { answerList, createListPages, LIST_GONE, listPage } from "./list-page";
import { describe, expect, test } from "vite-plus/test";
import { MAX_HEADER_BYTES } from "@ekrooh/bare/core";
import type { Photo } from "@justus/core";

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
    expect(headerBytes({ photos })).toBeGreaterThan(MAX_HEADER_BYTES);
    const pages = [listPage(photos, { from: 0 })];
    while (pages.at(-1)?.next !== undefined) {
      pages.push(listPage(photos, { from: pages.at(-1)?.next ?? 0 }));
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(headerBytes(page)).toBeLessThan(MAX_HEADER_BYTES);
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

function manyPhotos(count: number): Photo[] {
  return Array.from({ length: count }, (_, index) => photoNumbered(index));
}

describe("createListPages", () => {
  test("a photo deleted between pages does not push another one out of the read", () => {
    const pages = createListPages();
    const photos = manyPhotos(400);
    const first = pages.first(photos);
    photos.splice(1, 1);
    const read = [...first.photos];
    let next = pages.later({ from: first.next, listId: first.listId });
    while (next !== undefined) {
      read.push(...next.photos);
      next =
        next.next === undefined ? undefined : pages.later({ from: next.next, listId: next.listId });
    }
    expect(read).toEqual(manyPhotos(400));
  });

  test("a list that fits one page is not kept", () => {
    const pages = createListPages();
    const first = pages.first(manyPhotos(2));
    expect(first.listId).toBeUndefined();
    expect(pages.later({ from: 1, listId: "1" })).toBeUndefined();
  });

  test("only the newest lists are kept for later pages", () => {
    const pages = createListPages();
    const reads = Array.from({ length: 5 }, () => pages.first(manyPhotos(400)));
    expect(pages.later({ from: reads[0]?.next, listId: reads[0]?.listId })).toBeUndefined();
    expect(pages.later({ from: reads[4]?.next, listId: reads[4]?.listId })?.photos.length).toBe(
      reads[4]?.photos.length,
    );
  });
});

describe("answerList", () => {
  test("page one reads the phone's photos, a later page reads the saved list", async () => {
    const pages = createListPages();
    const asked: boolean[] = [];
    function read(all: boolean) {
      asked.push(all);
      return Promise.resolve(manyPhotos(400));
    }
    const [, first] = await answerList({ all: true }, { pages, read });
    const [, second] = await answerList(
      { all: true, from: first?.next, listId: first?.listId },
      { pages, read },
    );
    expect(asked).toEqual([true]);
    expect(second?.photos[0]).toEqual(photoNumbered(first?.photos.length ?? 0));
  });

  test("a later page of a list that is gone fails, so the web starts over", async () => {
    const pages = createListPages();
    const [error] = await answerList(
      { from: 3, listId: "9" },
      { pages, read: () => Promise.resolve([]) },
    );
    expect(error?.message).toBe(LIST_GONE);
  });
});
