import { describe, expect, test } from "vite-plus/test";
import type { FolderSummary } from "@justus/core";
import { batchSummary, imageFiles, planAdd } from "./add-photos";

const album = (id: string, extra: Partial<FolderSummary> = {}) =>
  ({ id, name: id, role: "member", members: 1, ...extra }) as FolderSummary;

describe("planAdd", () => {
  test("the album on screen takes the photos", () => {
    expect(planAdd("a", [album("a"), album("b")])).toEqual({ kind: "direct", folderId: "a" });
  });

  test("a Viewer's album and a pending join cannot take photos", () => {
    const viewer = album("a", { role: "reader" });
    expect(planAdd("a", [viewer])).toEqual({ kind: "viewer", album: viewer });
    const pending = album("p", { pending: true });
    expect(planAdd("p", [pending])).toEqual({ kind: "pending", album: pending });
  });
});

describe("batchSummary", () => {
  test("counts what was added", () => {
    expect(batchSummary({ added: 1, duplicates: 0, failed: [] }, "Trip")).toBe(
      "Added a photo to Trip",
    );
    expect(batchSummary({ added: 12, duplicates: 2, failed: [] }, "Trip")).toBe(
      "Added 12 photos to Trip · 2 already there",
    );
  });

  test("a re-add of photos already there says so", () => {
    expect(batchSummary({ added: 0, duplicates: 3, failed: [] }, "Trip")).toBe(
      "Those photos are already in Trip",
    );
  });

  test("failures lead", () => {
    expect(batchSummary({ added: 3, duplicates: 0, failed: [1, 2] }, "Trip")).toBe(
      "2 photos couldn't be added. 3 added to Trip.",
    );
    expect(batchSummary({ added: 0, duplicates: 0, failed: [1] }, "Trip")).toBe(
      "1 photo couldn't be added to Trip.",
    );
  });
});

test("imageFiles keeps only images", () => {
  const files = [
    new File(["x"], "a.jpg", { type: "image/jpeg" }),
    new File(["x"], "notes.txt", { type: "text/plain" }),
  ];
  expect(imageFiles(files).map((f) => f.name)).toEqual(["a.jpg"]);
});
