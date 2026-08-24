import { describe, expect, test } from "vite-plus/test";
import { guessMime, EXT_MIME, DEFAULT_MIME } from "./mime";

describe("guessMime (shared source of truth, issue #48)", () => {
  test("resolves every known extension to its canonical mime", () => {
    expect(guessMime(".png")).toBe("image/png");
    expect(guessMime(".gif")).toBe("image/gif");
    expect(guessMime(".webp")).toBe("image/webp");
    expect(guessMime(".heic")).toBe("image/heic");
    expect(guessMime(".mp4")).toBe("video/mp4");
    expect(guessMime(".mov")).toBe("video/quicktime");
  });

  test("is case-insensitive", () => {
    expect(guessMime(".PNG")).toBe("image/png");
    expect(guessMime(".HEIC")).toBe("image/heic");
    expect(guessMime(".Mp4")).toBe("video/mp4");
  });

  test("defaults unknown extensions to image/jpeg", () => {
    expect(guessMime(".tiff")).toBe(DEFAULT_MIME);
    expect(guessMime(".cr2")).toBe(DEFAULT_MIME);
    expect(guessMime("")).toBe(DEFAULT_MIME);
  });

  test("EXT_MIME is the single canonical set (guards against future divergence)", () => {
    // Both the served gallery (photo-store) and the tested derivation
    // (gallery-order) delegate here, so editing one table can no longer
    // silently drift the two apart.
    expect(Object.keys(EXT_MIME)).toEqual([".png", ".gif", ".webp", ".heic", ".mp4", ".mov"]);
  });
});
