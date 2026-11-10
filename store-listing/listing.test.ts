import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error listing.mjs is a plain script without type declarations
import { readListing } from "./listing.mjs";

function png(width: number, height: number) {
  const head = Buffer.alloc(24);
  Buffer.from("\x89PNG\r\n\x1a\n", "latin1").copy(head);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function fixture(config: string) {
  const root = mkdtempSync(join(tmpdir(), "listing-"));
  mkdirSync(join(root, "store-listing/captures/android"), { recursive: true });
  mkdirSync(join(root, "store-listing/captures/ios"), { recursive: true });
  mkdirSync(join(root, "assets/sample-photos"), { recursive: true });
  writeFileSync(join(root, "assets/sample-photos/dog.jpg"), "x");
  writeFileSync(join(root, "store-listing/captures/android/album.png"), png(1080, 2160));
  writeFileSync(join(root, "store-listing/images.json"), config);
  return root;
}

function configWith(image: object, flowPhoto = "dog.jpg") {
  const base = { id: "01_a", layout: "deviceBelow", capture: "album", headline: "Hi" };
  return JSON.stringify({ flowPhoto, images: [{ ...base, ...image }] }, null, 2);
}

describe("readListing", () => {
  it("reads a valid config and finds captures per store", () => {
    const result = readListing(fixture(configWith({})));
    expect(result).toMatchObject({ ok: true, flowPhoto: "dog.jpg" });
    if (!result.ok) return;
    expect(result.images[0].captures).toEqual({
      play: { width: 1080, height: 2160 },
      ios: undefined,
    });
  });

  it("accepts every layout", () => {
    for (const layout of [
      "deviceAbove",
      "deviceLandscape",
      "deviceBelow",
      "headlineBelow",
      "deviceAngled",
    ]) {
      expect(readListing(fixture(configWith({ layout }))).ok).toBe(true);
    }
  });

  it("reports invalid JSON naming the file", () => {
    const result = readListing(fixture("{ nope"));
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("store-listing/images.json: invalid JSON");
  });

  it("rejects an unknown layout with its line", () => {
    const result = readListing(fixture(configWith({ layout: "deviceLeft" })));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("store-listing/images.json");
    expect(result.message).toContain("deviceLeft");
    expect(result.message).toContain(
      "deviceAbove, deviceLandscape, deviceBelow, headlineBelow, deviceAngled",
    );
    expect(result.message).toMatch(/\(line \d+\)/);
  });

  it("rejects a capture that is not a plain file name", () => {
    for (const capture of ["../x", "a/b", "", 5]) {
      expect(readListing(fixture(configWith({ capture }))).ok).toBe(false);
    }
  });

  it("rejects a flowPhoto that is traversal or missing", () => {
    expect(readListing(fixture(configWith({}, "../secret.jpg"))).ok).toBe(false);
    const missing = readListing(fixture(configWith({}, "cat.jpg")));
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("cat.jpg");
  });

  it("rejects a bad id, an empty headline and an empty list", () => {
    expect(readListing(fixture(configWith({ id: "../x" }))).ok).toBe(false);
    expect(readListing(fixture(configWith({ headline: " " }))).ok).toBe(false);
    expect(readListing(fixture(JSON.stringify({ flowPhoto: "dog.jpg", images: [] }))).ok).toBe(
      false,
    );
  });

  it("keeps a missing capture as undefined, not an error", () => {
    const result = readListing(fixture(configWith({ capture: "invite" })));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.images[0].captures.play).toBeUndefined();
  });
});
