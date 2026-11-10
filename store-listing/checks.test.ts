import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error checks.mjs is a plain script without type declarations
import { captureNotUpscaled, headlineFits } from "./checks.mjs";

const margin = { side: 90, top: 120, bottom: 120 };
const base = {
  lines: 2,
  rect: { left: 90, right: 990, top: 120, bottom: 350 },
  width: 1080,
  height: 1920,
  margin,
};

describe("headlineFits", () => {
  it("passes two lines inside the margins", () => {
    expect(headlineFits(base).ok).toBe(true);
  });
  it("fails on three lines", () => {
    const result = headlineFits({ ...base, lines: 3 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("3 lines");
  });
  it("fails when text crosses the side margin", () => {
    expect(headlineFits({ ...base, rect: { ...base.rect, right: 1000 } }).ok).toBe(false);
    expect(headlineFits({ ...base, rect: { ...base.rect, left: 80 } }).ok).toBe(false);
  });
  it("fails when text crosses the top or bottom margin", () => {
    expect(headlineFits({ ...base, rect: { ...base.rect, top: 100 } }).ok).toBe(false);
    expect(headlineFits({ ...base, rect: { ...base.rect, bottom: 1810 } }).ok).toBe(false);
  });
});

describe("captureNotUpscaled", () => {
  it("passes when the screen is not wider than the capture", () => {
    expect(captureNotUpscaled({ screenWidth: 1080, captureWidth: 1080 }).ok).toBe(true);
    expect(captureNotUpscaled({ screenWidth: 800, captureWidth: 1080 }).ok).toBe(true);
  });
  it("fails when the screen is wider", () => {
    const result = captureNotUpscaled({ screenWidth: 1081, captureWidth: 1080 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("1081");
  });
});
