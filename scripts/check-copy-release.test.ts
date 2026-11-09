// @ts-expect-error check-copy-release.mjs is a plain script without type declarations
import { STORE_SHOTS, draftIds, draftShots, releaseProblems } from "./check-copy-release.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { expect, test } from "vite-plus/test";

const entry = (status: string) => ({ text: "x", status, where: "w", who: "w", screen: "" });
const catalogue = {
  "album.a": entry("approved"),
  "album.b": entry("draft"),
  "store.title": entry("approved"),
  "store.short_description": entry("draft"),
};
const manifest = { "1_album": { approved: true }, "2_invite": { approved: false }, "3_photo": {} };
const allShots = Object.fromEntries(
  (STORE_SHOTS as string[]).map((name) => [name, { approved: true }]),
);

test("draftIds lists non-approved ids, optionally by prefix", () => {
  expect(draftIds(catalogue)).toEqual(["album.b", "store.short_description"]);
  expect(draftIds(catalogue, "store.")).toEqual(["store.short_description"]);
});

test("draftShots lists screenshots without approved: true", () => {
  expect(draftShots(manifest)).toEqual(["2_invite", "3_photo", "4_help"]);
});

test("a screenshot missing from the manifest, or an empty manifest, is unapproved", () => {
  expect(draftShots({})).toEqual(STORE_SHOTS);
  expect(draftShots({ ...allShots, "4_help": undefined })).toEqual(["4_help"]);
});

test("STORE_SHOTS matches SCREENSHOTS in the Fastfile and the manifest keys", () => {
  const fastfile = fs.readFileSync("apps/android/fastlane/Fastfile", "utf8");
  const match = /^SCREENSHOTS = %w\[([^\]]+)\]/m.exec(fastfile);
  expect(match?.[1]?.split(/\s+/)).toEqual(STORE_SHOTS);
  const file = JSON.parse(fs.readFileSync("apps/android/fastlane/store-screenshots.json", "utf8"));
  expect(Object.keys(file)).toEqual(STORE_SHOTS);
});

test("CLI exits 2 for a bad scope and 1 while drafts remain", () => {
  const run = (...args: string[]) => spawnSync("node", ["scripts/check-copy-release.mjs", ...args]);
  expect(run().status).toBe(2);
  expect(run("nope").status).toBe(2);
  expect(run("store").status).toBe(1);
});

test("app scope names draft app ids and ignores store ids", () => {
  expect(releaseProblems({ catalogue, manifest, scope: "app" })).toEqual([
    "Draft app text: album.b",
  ]);
});

test("store scope names draft listing text and screenshots", () => {
  expect(releaseProblems({ catalogue, manifest, scope: "store" })).toEqual([
    "Draft store listing text: store.short_description",
    "Store screenshots not approved: 2_invite, 3_photo, 4_help",
  ]);
});

test("all approved passes in both scopes", () => {
  const ok = {
    catalogue: { "album.a": entry("approved"), "store.title": entry("approved") },
    manifest: allShots,
  };
  expect(releaseProblems({ ...ok, scope: "app" })).toEqual([]);
  expect(releaseProblems({ ...ok, scope: "store" })).toEqual([]);
});

test("note scope refuses a [user] line Play cannot show", () => {
  const long = "x".repeat(499);
  const base = { catalogue: {}, manifest: {}, scope: "note" };
  expect(releaseProblems({ ...base, noteLines: ["ok", long] })).toEqual([
    `Release note line over 500 characters: ${long.slice(0, 40)}…`,
  ]);
  expect(releaseProblems({ ...base, noteLines: ["ok"] })).toEqual([]);
});

test("note scope keeps a [user] line that makes exactly 500 characters", () => {
  const exact = "x".repeat(498);
  expect(
    releaseProblems({ catalogue: {}, manifest: {}, scope: "note", noteLines: [exact] }),
  ).toEqual([]);
});
