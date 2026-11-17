import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error pngjs ships no type declarations, so the import has an implicit any
import { PNG } from "pngjs";
import { expect, test } from "vite-plus/test";
// @ts-expect-error plain .mjs script has no type declarations, so the import has an implicit any
import { isMarker, markerPixels, MIN_PHOTO_PIXELS, writeMarker } from "./photo-marker.mjs";

const script = join(import.meta.dirname, "photo-marker.mjs");

function check(file: string, expected: string) {
  return spawnSync("node", [script, "check", file, expected], { encoding: "utf8" });
}

test("counts every pixel of a magenta block in a white screenshot", () => {
  const png = new PNG({ width: 400, height: 400 });
  png.data.fill(255);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) png.data.set([255, 0, 255, 255], (y * 400 + x) * 4);
  }
  expect(markerPixels(png)).toBe(10000);
});

test("accepts magenta drift and rejects the app's own colours", () => {
  expect(isMarker(234, 51, 247)).toBe(true);
  expect(isMarker(240, 20, 235)).toBe(true);
  for (const [r, g, b] of [
    [0x4b, 0x3f, 0xd6],
    [255, 45, 85],
    [175, 82, 222],
    [255, 255, 255],
    [0, 0, 0],
  ]) {
    expect(isMarker(r, g, b)).toBe(false);
  }
});

test("passes a written marker as shown and fails it as hidden", () => {
  const dir = mkdtempSync(join(tmpdir(), "marker-"));
  const photo = join(dir, "photo.png");
  writeMarker(photo);
  expect(check(photo, "shows").status).toBe(0);
  const wrong = check(photo, "hidden");
  expect(wrong.status).toBe(1);
  expect(wrong.stdout).toContain("1080000 photo pixels");
  expect(MIN_PHOTO_PIXELS).toBe(2000);
});

test("treats 2000 marker pixels as a photo and 1999 as none", () => {
  const dir = mkdtempSync(join(tmpdir(), "marker-"));
  const cases: [number, string][] = [
    [1999, "hidden"],
    [2000, "shows"],
  ];
  for (const [n, expected] of cases) {
    const png = new PNG({ width: 100, height: 100 });
    png.data.fill(255);
    for (let pixel = 0; pixel < n; pixel++) png.data.set([255, 0, 255, 255], pixel * 4);
    const file = join(dir, `${n}.png`);
    writeFileSync(file, PNG.sync.write(png));
    expect(check(file, expected).status).toBe(0);
  }
});
