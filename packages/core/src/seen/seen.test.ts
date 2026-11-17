import { describe, expect, test } from "vite-plus/test";
import { emptySeen, parseSeen } from "./types";

describe("parseSeen", () => {
  test("a version 2 record is undefined", () => {
    expect(parseSeen({ version: 2, known: {} })).toBeUndefined();
  });

  test("non-string ids are dropped", () => {
    expect(parseSeen({ version: 1, known: { a: ["x", 3, null, "y"] } })).toEqual({
      version: 1,
      known: { a: ["x", "y"] },
    });
  });

  test("an absent lastAlbum stays absent", () => {
    const parsed = parseSeen({ version: 1, known: {} });
    expect(parsed).toEqual(emptySeen());
    expect(parsed && "lastAlbum" in parsed).toBe(false);
  });

  test("a string lastAlbum is kept, another type is dropped", () => {
    expect(parseSeen({ version: 1, lastAlbum: "a1", known: {} })?.lastAlbum).toBe("a1");
    expect(parseSeen({ version: 1, lastAlbum: 4, known: {} })).toEqual(emptySeen());
  });

  test("wrong shapes are undefined", () => {
    for (const v of [null, 1, "x", [], {}, { version: 1 }, { version: 1, known: [] }]) {
      expect(parseSeen(v)).toBeUndefined();
    }
    expect(parseSeen({ version: 1, known: { a: "x" } })).toBeUndefined();
  });
});
