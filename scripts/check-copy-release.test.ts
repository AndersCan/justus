// @ts-expect-error check-copy-release.mjs is a plain script without type declarations
import { draftIds, draftShots, releaseProblems } from "./check-copy-release.mjs";
import { expect, test } from "vite-plus/test";

const entry = (status: string) => ({ text: "x", status, where: "w", who: "w", screen: "" });
const catalogue = {
  "album.a": entry("approved"),
  "album.b": entry("draft"),
  "store.title": entry("approved"),
  "store.short_description": entry("draft"),
};
const manifest = { "1_album": { approved: true }, "2_invite": { approved: false }, "3_photo": {} };

test("draftIds lists non-approved ids, optionally by prefix", () => {
  expect(draftIds(catalogue)).toEqual(["album.b", "store.short_description"]);
  expect(draftIds(catalogue, "store.")).toEqual(["store.short_description"]);
});

test("draftShots lists screenshots without approved: true", () => {
  expect(draftShots(manifest)).toEqual(["2_invite", "3_photo"]);
});

test("app scope names draft app ids and ignores store ids", () => {
  expect(releaseProblems({ catalogue, manifest, scope: "app" })).toEqual([
    "Draft app text: album.b",
  ]);
});

test("store scope names draft listing text and screenshots", () => {
  expect(releaseProblems({ catalogue, manifest, scope: "store" })).toEqual([
    "Draft store listing text: store.short_description",
    "Store screenshots not approved: 2_invite, 3_photo",
  ]);
});

test("all approved passes in both scopes", () => {
  const ok = {
    catalogue: { "album.a": entry("approved"), "store.title": entry("approved") },
    manifest: { "1_album": { approved: true } },
  };
  expect(releaseProblems({ ...ok, scope: "app" })).toEqual([]);
  expect(releaseProblems({ ...ok, scope: "store" })).toEqual([]);
});
