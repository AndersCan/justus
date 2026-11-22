import { CoreError, type Either } from "@ekrooh/bare/core";
import { describe, expect, test } from "vite-plus/test";
import type { ListResult, Photo } from "@justus/core";
import { listAllPhotos } from "./list-all-photos";

function photoCalled(id: string): Photo {
  return {
    id,
    url: `http://127.0.0.1/photos/${id}`,
    name: `${id}.jpg`,
    mime: "image/jpeg",
    size: 1,
    addedAt: 1,
    member: { key: "a".repeat(64), name: "Ada" },
    folderId: "album",
  };
}

function pagesOf(pages: ListResult[]) {
  const asked: number[] = [];
  const starts = [0, ...pages.map((page) => page.next)];
  function readPage(from: number): Promise<Either<CoreError, ListResult>> {
    asked.push(from);
    const page = pages[starts.indexOf(from)];
    if (page === undefined) {
      return Promise.resolve([new CoreError("PLUGIN_ERROR", "no page"), null]);
    }
    return Promise.resolve([null, page]);
  }
  return { asked, readPage };
}

describe("listAllPhotos", () => {
  test("reads every page in order and joins the photos", async () => {
    const [a, b, c] = ["a", "b", "c"].map(photoCalled);
    const { asked, readPage } = pagesOf([{ photos: [a, b], next: 2 }, { photos: [c] }]);
    expect(await listAllPhotos(readPage)).toEqual([null, { photos: [a, b, c] }]);
    expect(asked).toEqual([0, 2]);
  });

  test("a photo that shifts onto the next page while it is read is listed once", async () => {
    const [a, b, c] = ["a", "b", "c"].map(photoCalled);
    const { readPage } = pagesOf([{ photos: [a, b], next: 2 }, { photos: [b, c] }]);
    expect(await listAllPhotos(readPage)).toEqual([null, { photos: [a, b, c] }]);
  });

  test("a page that fails fails the whole list", async () => {
    const { readPage } = pagesOf([{ photos: [photoCalled("a")], next: 1 }]);
    const [error, result] = await listAllPhotos(readPage);
    expect(error?.message).toBe("no page");
    expect(result).toBeNull();
  });

  test("a next that does not move forward ends the list", async () => {
    const a = photoCalled("a");
    const { asked, readPage } = pagesOf([{ photos: [a], next: 0 }]);
    expect(await listAllPhotos(readPage)).toEqual([null, { photos: [a] }]);
    expect(asked).toEqual([0]);
  });
});
