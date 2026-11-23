import { CoreError, type Either } from "@ekrooh/bare/core";
import { describe, expect, test } from "vite-plus/test";
import type { ListOptions, ListResult, Photo } from "@justus/core";
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
  const asked: ListOptions[] = [];
  const starts = [undefined, ...pages.map((page) => page.next)];
  function readPage(position: ListOptions): Promise<Either<CoreError, ListResult>> {
    asked.push(position);
    const page = pages[starts.indexOf(position.from)];
    if (page === undefined) {
      return Promise.resolve([new CoreError("PLUGIN_ERROR", "no page"), null]);
    }
    return Promise.resolve([null, page]);
  }
  return { asked, readPage };
}

describe("listAllPhotos", () => {
  test("reads every page of one list in order and joins the photos", async () => {
    const [a, b, c] = ["a", "b", "c"].map(photoCalled);
    const { asked, readPage } = pagesOf([
      { photos: [a, b], next: 2, listId: "7" },
      { photos: [c] },
    ]);
    expect(await listAllPhotos(readPage)).toEqual([null, { photos: [a, b, c] }]);
    expect(asked).toEqual([{}, { from: 2, listId: "7" }]);
  });

  test("a page that fails fails the whole list", async () => {
    const { readPage } = pagesOf([{ photos: [photoCalled("a")], next: 1, listId: "7" }]);
    const [error, result] = await listAllPhotos(readPage);
    expect(error?.message).toBe("no page");
    expect(result).toBeNull();
  });

  test("a next that does not move on fails instead of showing only the first page", async () => {
    const { asked, readPage } = pagesOf([{ photos: [photoCalled("a")], next: 0, listId: "7" }]);
    const [error] = await listAllPhotos(readPage);
    expect(error?.message).toBe("photos.list: next page does not move on");
    expect(asked).toEqual([{}]);
  });
});
