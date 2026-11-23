import { describe, expect, test } from "vite-plus/test";
import { photoEvents } from "./events";

describe("photoEvents.photos.list", () => {
  test("a later page asks for where it starts and which list it comes from", () => {
    expect(photoEvents.photos.list(true, { from: 3, listId: "7" }).args).toEqual({
      all: true,
      from: 3,
      listId: "7",
    });
  });

  test("page one asks for nothing but the album choice", () => {
    const args = [photoEvents.photos.list(true).args, photoEvents.photos.list().args];
    expect(args).toEqual([{ all: true }, {}]);
  });
});
