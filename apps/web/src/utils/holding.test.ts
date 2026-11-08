import { describe, expect, it } from "vite-plus/test";
import type { Photo, PhotoHolders } from "@justus/core";
import { albumHolding, holdingLine } from "./holding";

const m = (key: string) => ({ key, name: key });
const photo = (folderId: string, holders?: Partial<PhotoHolders>): Photo =>
  ({
    id: "p",
    folderId,
    holders: holders && {
      here: false,
      others: [],
      unsure: [],
      waiting: [],
      former: [],
      ...holders,
    },
  }) as Photo;

describe("albumHolding", () => {
  it("counts only photos of the album", () => {
    const r = albumHolding(
      [photo("f1", { others: [m("kim")] }), photo("f2", { others: [m("kim")] })],
      "f1",
    );
    expect(r.total).toBe(1);
    expect(r.byKey.get("kim")).toEqual({ kind: "count", held: 1 });
  });
  it("leaves out photos without holders", () => {
    const r = albumHolding([photo("f1"), photo("f1", {})], "f1");
    expect(r.total).toBe(1);
  });
  it("counts the adder through others, and you through here", () => {
    const r = albumHolding(
      [photo("f1", { here: true, others: [m("kim")] }), photo("f1", { others: [m("kim")] })],
      "f1",
    );
    expect(r).toEqual({ total: 2, you: 1, byKey: new Map([["kim", { kind: "count", held: 2 }]]) });
  });
  it("silent wins over a count, in either order", () => {
    const a = albumHolding(
      [photo("f1", { others: [m("z")] }), photo("f1", { unsure: [m("z")] })],
      "f1",
    );
    const b = albumHolding(
      [photo("f1", { unsure: [m("z")] }), photo("f1", { others: [m("z")] })],
      "f1",
    );
    expect(a.byKey.get("z")).toEqual({ kind: "silent" });
    expect(b.byKey.get("z")).toEqual({ kind: "silent" });
  });
  it("empty list", () => {
    expect(albumHolding([], "f1")).toEqual({ total: 0, you: 0, byKey: new Map() });
  });
});

describe("holdingLine", () => {
  it("says nothing without photos", () => {
    expect(holdingLine({ kind: "count", held: 0 }, 0)).toBeUndefined();
    expect(holdingLine({ kind: "silent" }, 0)).toBeUndefined();
  });
  it("silent", () => {
    expect(holdingLine({ kind: "silent" }, 3)).toBe("Hasn't said yet which photos they have");
  });
  it("counts", () => {
    expect(holdingLine({ kind: "count", held: 3 }, 3)).toBe("Has 3 of 3 photos");
    expect(holdingLine({ kind: "count", held: 1 }, 12)).toBe("Has 1 of 12 photos");
  });
  it("absent means none", () => {
    expect(holdingLine(undefined, 4)).toBe("Has 0 of 4 photos");
  });
  it("one photo is singular", () => {
    expect(holdingLine({ kind: "count", held: 1 }, 1)).toBe("Has 1 of 1 photo");
  });
});
