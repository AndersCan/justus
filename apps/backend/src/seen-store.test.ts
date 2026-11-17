import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { SeenRecord } from "@justus/core";
import { createSeenStore, SEEN_NEWER_VERSION } from "./seen-store";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seen-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = (files: object = fs) =>
  createSeenStore({ dir, files: files as never, paths: path as never });
const file = () => path.join(dir, "seen.json");
const record: SeenRecord = { version: 1, lastAlbum: "a1", known: { a1: ["p1", "p2"] } };

describe("seen store", () => {
  test("a missing file reads as an empty record", () => {
    expect(open().read()).toEqual([null, { version: 1, known: {} }]);
  });

  test("a written record is read back by a new store", async () => {
    expect(await open().write(record)).toEqual([null, {}]);
    expect(open().read()).toEqual([null, record]);
  });

  test("a non-JSON file reads as empty and is replaced on write", async () => {
    fs.writeFileSync(file(), "not json {");
    const store = open();
    expect(store.read()).toEqual([null, { version: 1, known: {} }]);
    await store.write(record);
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual(record);
  });

  test("a file of the wrong shape reads as empty", () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, known: 4 }));
    expect(open().read()).toEqual([null, { version: 1, known: {} }]);
  });

  test("a newer version errors on read and write, and the file stays as it was", async () => {
    fs.writeFileSync(file(), '{"version":2,"x":1}');
    const store = open();
    expect(store.read()[0]?.code).toBe(SEEN_NEWER_VERSION);
    expect((await store.write(record))[0]?.code).toBe(SEEN_NEWER_VERSION);
    expect(fs.readFileSync(file(), "utf8")).toBe('{"version":2,"x":1}');
  });

  test("a seen.json that cannot be read (a directory) reads as empty", () => {
    fs.mkdirSync(file());
    expect(open().read()).toEqual([null, { version: 1, known: {} }]);
  });

  test("the first write makes a storage dir that does not exist yet", async () => {
    const nested = path.join(dir, "not-yet");
    const store = createSeenStore({ dir: nested, files: fs as never, paths: path as never });
    expect(await store.write(record)).toEqual([null, {}]);
    expect(JSON.parse(fs.readFileSync(path.join(nested, "seen.json"), "utf8"))).toEqual(record);
  });
});
