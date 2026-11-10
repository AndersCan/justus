import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error listing.mjs is a plain script without type declarations
import { readMock, readStoreText } from "./listing.mjs";

const repo = join(import.meta.dirname, "..");

function copy() {
  const root = mkdtempSync(join(tmpdir(), "mock-"));
  for (const path of [
    "store-listing/images.json",
    "store-listing/captures",
    "assets/sample-photos",
    "apps/android/fastlane/metadata/android/en-US",
    "apps/ios/fastlane/metadata/en-US",
  ]) {
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  return root;
}

describe("mock page data", () => {
  it("reads Play and App Store text and the images", () => {
    const root = copy();
    const mock = readMock(root);
    expect(mock.ok).toBe(true);
    expect(mock.text.play.title).toBe("Justus: Private Family Photos");
    expect(mock.text.ios.name).toBe("Justus: Private Family Photos");
    expect(mock.text.ios.promotionalText).toBe(mock.text.play.shortDescription);
    expect(mock.images).toHaveLength(5);
    rmSync(root, { recursive: true });
  });

  it("names the missing App Store file", () => {
    const root = copy();
    rmSync(join(root, "apps/ios/fastlane/metadata/en-US/subtitle.txt"));
    const read = readStoreText(root);
    expect(read).toEqual({
      ok: false,
      message: "apps/ios/fastlane/metadata/en-US/subtitle.txt: file not found",
    });
    rmSync(root, { recursive: true });
  });

  it("reports a bad images.json instead of text", () => {
    const root = copy();
    writeFileSync(join(root, "store-listing/images.json"), "{");
    const mock = readMock(root);
    expect(mock.ok).toBe(false);
    expect(mock.message).toContain("store-listing/images.json");
    rmSync(root, { recursive: true });
  });

  it("points the icons at files that exist", () => {
    const { text } = readMock(repo);
    expect(existsSync(join(repo, text.play.icon))).toBe(true);
    expect(existsSync(join(repo, text.ios.icon))).toBe(true);
  });
});
