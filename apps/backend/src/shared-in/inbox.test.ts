import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { MAX_PICK } from "@justus/core";
import { listSharedIn, cleanSharedName } from "./inbox";
import type { Files, Paths } from "../ports/files";

const files = fs as unknown as Files;
const paths = nodePath as unknown as Paths;
const fixture = JSON.parse(
  fs.readFileSync(
    nodePath.join(
      import.meta.dirname,
      "../../../../packages/core/fixtures/shared-in-batch.v1.json",
    ),
    "utf8",
  ),
);
const ID = fixture.id as string;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "shared-in-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Writes a batch dir `name` with a manifest and the named files. */
function batch(name: string, manifest: unknown, fileNames: string[] = []) {
  const d = nodePath.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(
      nodePath.join(d, "batch.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  for (const f of fileNames) fs.writeFileSync(nodePath.join(d, f), f);
  return d;
}

const list = () => {
  const [e, listings] = listSharedIn({ dir, files, paths });
  if (e) throw e;
  return listings;
};
const fixtureFiles = ["0.jpeg", "copy-0-display.jpg", "copy-0-thumb.jpg", "1.png"];
const manifest = (over: Record<string, unknown> = {}) => ({ ...fixture, ...over });

describe("listSharedIn", () => {
  test("lists the fixture batch as picked media with type and url", () => {
    const d = batch(ID, fixture, fixtureFiles);
    expect(list()).toEqual([
      {
        batch: {
          id: ID,
          receivedAt: "2026-11-17T21:30:00.000Z",
          photos: [
            {
              path: nodePath.join(d, "copy-0-display.jpg"),
              original: nodePath.join(d, "0.jpeg"),
              thumb: nodePath.join(d, "copy-0-thumb.jpg"),
              name: "Beach.jpg",
              takenAt: "2026-08-01T12:00:00+02:00",
              type: "image/jpeg",
              url: `/shared-in/${ID}/0`,
            },
            {
              path: nodePath.join(d, "1.png"),
              name: "Map.png",
              type: "image/png",
              url: `/shared-in/${ID}/1`,
            },
          ],
        },
        originals: [nodePath.join(d, "0.jpeg"), nodePath.join(d, "1.png")],
      },
    ]);
  });

  test("a missing inbox is empty", () => {
    fs.rmSync(dir, { recursive: true });
    expect(list()).toEqual([]);
  });

  test("an unreadable inbox is an error", () => {
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "not a dir");
    const [e] = listSharedIn({ dir, files, paths });
    expect(e?.code).toBe("HOST_ERROR");
    fs.rmSync(dir);
  });

  test("dot-prefixed (unfinished) batches are skipped without a log", () => {
    batch(`.tmp-${ID}`, fixture, fixtureFiles);
    expect(list()).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("a dir name that differs from the manifest id is skipped", () => {
    batch("other-id", fixture, fixtureFiles);
    expect(list()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "[justus] shared-in.skip id=other-id reason=bad-manifest",
    );
  });

  test.each(["A..B", "x".repeat(65), "UPPER", "a b"])("id %s is refused", (id) => {
    batch(id, manifest({ id }), fixtureFiles);
    expect(list()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      "[justus] shared-in.skip id=invalid reason=bad-manifest",
    );
  });

  test("a dir name that is not an id is logged as invalid, never by name", () => {
    batch("Beach photo", fixture, fixtureFiles);
    list();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Beach");
  });

  test.each([
    ["unparseable JSON", "{nope"],
    ["a non-object", "[1]"],
    ["items not an array", { ...fixture, items: "x" }],
    ["a newer version", { ...fixture, version: 2 }],
    ["a string version", { ...fixture, version: "1" }],
    ["no receivedAt", { ...fixture, receivedAt: undefined }],
  ])("%s is skipped as bad-manifest", (_n, m) => {
    batch(ID, m, fixtureFiles);
    expect(list()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      `[justus] shared-in.skip id=${ID} reason=bad-manifest`,
    );
  });

  test("a missing manifest is skipped", () => {
    batch(ID, undefined, fixtureFiles);
    expect(list()).toEqual([]);
  });

  test.each(["../x.jpg", "a/b.jpg", ".hidden.jpg", "..jpg", "a b.jpg", `${"a".repeat(128)}.jpg`])(
    "item file %s is dropped",
    (file) => {
      batch(ID, manifest({ items: [{ file }] }), ["x.jpg"]);
      expect(list()).toEqual([]);
    },
  );

  test("a file outside the batch dir is not reachable through `..`", () => {
    fs.writeFileSync(nodePath.join(dir, "secret.jpg"), "s");
    batch(ID, manifest({ items: [{ file: "../secret.jpg" }] }));
    expect(list()).toEqual([]);
  });

  test("a symlinked original is dropped", () => {
    const d = batch(ID, manifest({ items: [{ file: "0.jpg" }, { file: "1.png" }] }), ["1.png"]);
    fs.writeFileSync(nodePath.join(dir, "outside.jpg"), "x");
    fs.symlinkSync(nodePath.join(dir, "outside.jpg"), nodePath.join(d, "0.jpg"));
    const [only] = list();
    expect(only?.batch.photos.map((p) => p.name)).toEqual(["1.png"]);
    expect(only?.batch.photos[0]?.url).toBe(`/shared-in/${ID}/1`);
  });

  test("a missing original is dropped and a directory is not a file", () => {
    const d = batch(ID, manifest({ items: [{ file: "0.jpg" }, { file: "1.png" }] }));
    fs.mkdirSync(nodePath.join(d, "1.png"));
    expect(list()).toEqual([]);
  });

  test("a symlinked copy drops both copies but keeps the original", () => {
    const d = batch(
      ID,
      manifest({ items: [{ file: "0.jpeg", display: "d.jpg", thumb: "t.jpg" }] }),
      ["0.jpeg", "t.jpg"],
    );
    fs.symlinkSync(nodePath.join(dir, "0.jpeg"), nodePath.join(d, "d.jpg"));
    const [only] = list();
    expect(only?.batch.photos).toEqual([
      expect.objectContaining({ path: nodePath.join(d, "0.jpeg") }),
    ]);
    expect(only?.batch.photos[0]).not.toHaveProperty("thumb");
    expect(only?.batch.photos[0]).not.toHaveProperty("original");
  });

  test("a bad thumb drops both copies", () => {
    const d = batch(
      ID,
      manifest({ items: [{ file: "0.jpeg", display: "d.jpg", thumb: "../t.jpg" }] }),
      ["0.jpeg", "d.jpg"],
    );
    expect(list()[0]?.batch.photos[0]?.path).toBe(nodePath.join(d, "0.jpeg"));
  });

  test("a display copy without a thumb is kept", () => {
    const d = batch(ID, manifest({ items: [{ file: "0.jpeg", display: "d.jpg" }] }), [
      "0.jpeg",
      "d.jpg",
    ]);
    expect(list()[0]?.batch.photos[0]).toEqual(
      expect.objectContaining({
        path: nodePath.join(d, "d.jpg"),
        original: nodePath.join(d, "0.jpeg"),
      }),
    );
    expect(list()[0]?.batch.photos[0]).not.toHaveProperty("thumb");
  });

  test("an extension outside the allow-list is dropped with reason type", () => {
    batch(ID, manifest({ items: [{ file: "0.svg" }, { file: "1" }, { file: "2.JPG" }] }), [
      "0.svg",
      "1",
      "2.JPG",
    ]);
    const [only] = list();
    expect(only?.batch.photos.map((p) => [p.name, p.type])).toEqual([["2.JPG", "image/jpeg"]]);
    expect(console.error).toHaveBeenCalledWith(`[justus] shared-in.skip id=${ID} reason=type`);
  });

  test.each([
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.png", "image/png"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.heic", "image/heic"],
  ])("%s serves as %s", (file, type) => {
    batch(ID, manifest({ items: [{ file }] }), [file]);
    expect(list()[0]?.batch.photos[0]?.type).toBe(type);
  });

  test("the name is cleaned, and falls back to the file name", () => {
    batch(
      ID,
      manifest({
        items: [
          { file: "0.jpg", name: "../a\u0000.jpg" },
          { file: "1.jpg", name: "///" },
          { file: "2.jpg", name: 5 },
        ],
      }),
      ["0.jpg", "1.jpg", "2.jpg"],
    );
    expect(list()[0]?.batch.photos.map((p) => p.name)).toEqual(["..a.jpg", "1.jpg", "2.jpg"]);
  });

  test("a takenAt that is not a date is dropped", () => {
    batch(
      ID,
      manifest({
        items: [
          { file: "0.jpg", takenAt: "yesterday" },
          { file: "1.jpg", takenAt: "2026-08-01T12:00:00Z" },
        ],
      }),
      ["0.jpg", "1.jpg"],
    );
    const photos = list()[0]?.batch.photos ?? [];
    expect(photos[0]).not.toHaveProperty("takenAt");
    expect(photos[1]).not.toHaveProperty("takenAt");
  });

  test("more than 50 items lists the first 50", () => {
    const items = Array.from({ length: MAX_PICK + 1 }, (_, i) => ({ file: `${i}.jpg` }));
    batch(
      ID,
      manifest({ items }),
      items.map((i) => i.file),
    );
    const photos = list()[0]?.batch.photos ?? [];
    expect(photos).toHaveLength(MAX_PICK);
    expect(photos.at(-1)?.url).toBe(`/shared-in/${ID}/49`);
  });

  test("a batch whose items are all dropped is not listed", () => {
    batch(ID, manifest({ items: [{ file: "0.svg" }] }), ["0.svg"]);
    expect(list()).toEqual([]);
  });

  test("batches are ordered by receivedAt, then id", () => {
    const item = { items: [{ file: "0.jpg" }] };
    batch("b", { version: 1, id: "b", receivedAt: "2026-01-02T00:00:00.000Z", ...item }, ["0.jpg"]);
    batch("c", { version: 1, id: "c", receivedAt: "2026-01-01T00:00:00.000Z", ...item }, ["0.jpg"]);
    batch("a", { version: 1, id: "a", receivedAt: "2026-01-02T00:00:00.000Z", ...item }, ["0.jpg"]);
    expect(list().map((l) => l.batch.id)).toEqual(["c", "a", "b"]);
  });

  test("logs never carry file names", () => {
    batch(ID, manifest({ items: [{ file: "secret-name.svg" }] }), ["secret-name.svg"]);
    list();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret-name");
  });
});

describe("cleanSharedName", () => {
  test.each([
    ["a/b\\c.jpg", "abc.jpg"],
    ["x\u0007y\u007f", "xy"],
    ["", undefined],
    [undefined, undefined],
    ["a".repeat(300), "a".repeat(255)],
  ])("%j → %j", (raw, out) => {
    expect(cleanSharedName(raw)).toBe(out);
  });
});
