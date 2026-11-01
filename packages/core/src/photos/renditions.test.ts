import { describe, expect, it } from "vite-plus/test";
import { fitWithin, isSha256Hex } from "./renditions";

describe("fitWithin", () => {
  it("scales the long edge down to the limit, keeping the aspect ratio", () => {
    expect(fitWithin(4032, 3024, 2560)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(3024, 4032, 640)).toEqual({ width: 480, height: 640 });
  });

  it("never upscales a small image", () => {
    expect(fitWithin(800, 600, 2560)).toEqual({ width: 800, height: 600 });
  });

  it("keeps a sliver at least one pixel wide", () => {
    expect(fitWithin(10000, 2, 640)).toEqual({ width: 640, height: 1 });
  });
});

describe("guards", () => {
  it("accepts only a lowercase hex sha256", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });
});
