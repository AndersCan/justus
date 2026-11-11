import { describe, expect, it } from "vite-plus/test";
import type { Photo, PhotoHolders } from "@justus/core";
import { holdersSheetRows } from "./holders";
import { copy } from "../copy/copy";
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
      previews: [],
      former: [],
      left: [],
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
  it("counts the adder through others", () => {
    const r = albumHolding(
      [photo("f1", { here: true, others: [m("kim")] }), photo("f1", { others: [m("kim")] })],
      "f1",
    );
    expect(r).toEqual({ total: 2, byKey: new Map([["kim", { kind: "count", held: 2 }]]) });
  });
  it("a count the sheets show wins over not said yet, in either order", () => {
    const a = albumHolding(
      [photo("f1", { others: [m("z")] }), photo("f1", { unsure: [m("z")] })],
      "f1",
    );
    const b = albumHolding(
      [photo("f1", { unsure: [m("z")] }), photo("f1", { others: [m("z")] })],
      "f1",
    );
    expect(a.byKey.get("z")).toEqual({ kind: "count", held: 1 });
    expect(b.byKey.get("z")).toEqual({ kind: "count", held: 1 });
  });
  it("silent only when no sheet lists them as holding", () => {
    const r = albumHolding([photo("f1", { unsure: [m("z")] })], "f1");
    expect(r.byKey.get("z")).toEqual({ kind: "silent" });
  });
  it("row == sheet", () => {
    const photos = [
      photo("f1", { here: true, others: [m("a")], unsure: [m("b")] }),
      photo("f1", { others: [m("a"), m("b")], unsure: [m("c")] }),
      photo("f1", { waiting: [m("a")], previews: [m("b")], unsure: [m("a")] }),
      photo("f1"),
      photo("f2", { others: [m("c")] }),
    ];
    const r = albumHolding(photos, "f1");
    for (const key of ["a", "b", "c"]) {
      const sheet = photos.filter(
        (p) => p.folderId === "f1" && holdersSheetRows(p.holders).others.some((o) => o.key === key),
      ).length;
      if (sheet > 0) expect(r.byKey.get(key)).toEqual({ kind: "count", held: sheet });
    }
  });
  it("previews or waiting only : previews reads previews only, waiting reads no photos", () => {
    const r = albumHolding(
      [photo("f1", { previews: [m("p")] }), photo("f1", { waiting: [m("w")] })],
      "f1",
    );
    expect(holdingLine(r.byKey.get("p"), r.total)).toBe("has previews only");
    expect(holdingLine(r.byKey.get("w"), r.total)).toBe("has no photos yet");
  });
  it("empty list", () => {
    expect(albumHolding([], "f1")).toEqual({ total: 0, byKey: new Map() });
  });
});

describe("holdingLine", () => {
  it("says nothing without photos", () => {
    expect(holdingLine({ kind: "count", held: 0 }, 0)).toBeUndefined();
    expect(holdingLine({ kind: "silent" }, 0)).toBeUndefined();
  });
  it("silent", () => {
    expect(holdingLine({ kind: "silent" }, 3)).toBe("their phone hasn't said yet");
  });
  it("everything held says all", () => {
    expect(holdingLine({ kind: "count", held: 3 }, 3)).toBe("has every photo in full");
    expect(holdingLine({ kind: "count", held: 1 }, 1)).toBe("has every photo in full");
  });
  it("part held says the count", () => {
    expect(holdingLine({ kind: "count", held: 2 }, 3)).toBe("has 2 in full");
    expect(holdingLine({ kind: "count", held: 1 }, 12)).toBe("has 1 in full");
  });
  it("absent or zero means none", () => {
    expect(holdingLine(undefined, 4)).toBe("has no photos yet");
    expect(holdingLine({ kind: "count", held: 0 }, 4)).toBe("has no photos yet");
  });
  it("role and phone part fit a 360 px row (~44 chars of text-xs)", () => {
    const phones = [
      holdingLine({ kind: "silent" }, 3),
      holdingLine(undefined, 3),
      holdingLine({ kind: "count", held: 3 }, 3),
      holdingLine({ kind: "count", held: 999 }, 1000),
    ];
    for (const role of [
      "member.role_admin",
      "member.role_collaborator",
      "member.role_viewer",
    ] as const)
      for (const phone of phones) expect(`${copy(role)} · ${phone}`.length).toBeLessThanOrEqual(42);
  });
});
