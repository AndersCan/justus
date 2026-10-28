import { describe, expect, test } from "vite-plus/test";
import type { FolderSummary, Photo } from "@justus/core";
import {
  RECENT_MS,
  addTargets,
  albumCards,
  groupPhotos,
  photosInScope,
  takenTime,
} from "./photo-scope";

function photo(id: string, over: Partial<Photo> = {}): Photo {
  return {
    id,
    url: `blob:${id}`,
    name: id,
    mime: "image/jpeg",
    size: 1,
    addedAt: 0,
    member: { key: "m", name: "M" },
    ...over,
  };
}

function folder(id: string, over: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    name: id,
    role: "creator",
    shareKey: "k",
    driveKey: "d",
    members: 1,
    addedAt: 0,
    ...over,
  };
}

describe("photosInScope", () => {
  const photos = [
    photo("a", { folderId: "wedding", mine: true }),
    photo("b", { folderId: "trip", mine: false }),
    photo("c", { folderId: "wedding", mine: false }),
  ];

  test("all keeps every photo", () => {
    expect(photosInScope(photos, { kind: "all" }).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  test("mine keeps only photos this device added", () => {
    expect(photosInScope(photos, { kind: "mine" }).map((p) => p.id)).toEqual(["a"]);
  });

  test("album keeps only that album's photos", () => {
    expect(photosInScope(photos, { kind: "album", id: "wedding" }).map((p) => p.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("groupPhotos", () => {
  const now = new Date(2026, 9, 28).getTime();

  test("the last week leads as Recently added, older photos group by month", () => {
    const photos = [
      photo("new", { addedAt: now - 1000 }),
      photo("week", { addedAt: now - RECENT_MS + 1000 }),
      photo("oct", { addedAt: new Date(2026, 9, 2).getTime() }),
      photo("aug", { addedAt: new Date(2026, 7, 14).getTime() }),
    ];
    expect(
      groupPhotos(photos, "added", now).map((g) => [g.label, g.photos.map((p) => p.id)]),
    ).toEqual([
      ["Recently added", ["new", "week"]],
      ["October 2026", ["oct"]],
      ["August 2026", ["aug"]],
    ]);
  });

  test("by date taken, photos sort and group by when they were taken", () => {
    const photos = [
      photo("scan", { addedAt: now - 1000, takenAt: "1998-07-04T12:00:00" }),
      photo("summer", { addedAt: now - 2000, takenAt: "2026-06-20T15:30:00+02:00" }),
      photo("undated", { addedAt: new Date(2026, 8, 1).getTime() }),
    ];
    expect(
      groupPhotos(photos, "taken", now).map((g) => [g.label, g.photos.map((p) => p.id)]),
    ).toEqual([
      ["September 2026", ["undated"]],
      ["June 2026", ["summer"]],
      ["July 1998", ["scan"]],
    ]);
  });
});

describe("takenTime", () => {
  test("reads a zone-less capture date as local wall-clock time", () => {
    expect(takenTime(photo("a", { takenAt: "2026-06-20T15:30:00" }))).toBe(
      new Date(2026, 5, 20, 15, 30).getTime(),
    );
  });

  test("falls back to the added date when there is no usable capture date", () => {
    expect(takenTime(photo("a", { addedAt: 42 }))).toBe(42);
    expect(takenTime(photo("b", { addedAt: 42, takenAt: "garbage" }))).toBe(42);
  });
});

describe("albumCards", () => {
  test("covers each album with its newest photo and counts its photos", () => {
    const cards = albumCards(
      [folder("wedding"), folder("empty")],
      [
        photo("w2", { folderId: "wedding" }),
        photo("t1", { folderId: "trip" }),
        photo("w1", { folderId: "wedding" }),
      ],
    );
    expect(cards.map((c) => [c.folder.id, c.cover?.id ?? null, c.count])).toEqual([
      ["wedding", "w2", 2],
      ["empty", null, 0],
    ]);
  });
});

describe("addTargets", () => {
  test("excludes albums where this device is a Viewer or still waiting", () => {
    const targets = addTargets([
      folder("mine"),
      folder("member", { role: "member" }),
      folder("viewer", { role: "reader" }),
      folder("waiting", { role: "member", pending: true }),
    ]);
    expect(targets.map((f) => f.id)).toEqual(["mine", "member"]);
  });
});
