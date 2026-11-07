import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error check-play-listing.mjs is a plain script without type declarations
import { listingProblems, playLength, problemLine, readListing } from "./check-play-listing.mjs";
import { expect, test } from "vite-plus/test";

test.each([
  ["abc\n", 3],
  ["abc\r\n", 3],
  ["abc\n\n", 4],
  ["é".repeat(80), 80],
  ["😀".repeat(80), 80],
  ["", 0],
])("playLength(%j) is %i", (text, expected) => {
  expect(playLength(text)).toBe(expected);
});

test.each([
  ["en-US/title.txt", 30],
  ["en-US/short_description.txt", 80],
  ["en-US/full_description.txt", 4000],
  ["en-US/changelogs/42.txt", 500],
])("%s passes at %i characters and fails one over", (file, limit) => {
  expect(listingProblems([{ path: file, text: "a".repeat(limit) + "\n" }])).toEqual([]);
  expect(listingProblems([{ path: file, text: "a".repeat(limit + 1) + "\n" }])).toEqual([
    { path: file, length: limit + 1, limit },
  ]);
});

test("counts code points, not bytes or UTF-16 units", () => {
  const file = "en-US/short_description.txt";
  expect(listingProblems([{ path: file, text: "é".repeat(80) }])).toEqual([]);
  expect(listingProblems([{ path: file, text: "😀".repeat(80) }])).toEqual([]);
});

test("ignores files Play does not limit here", () => {
  expect(listingProblems([{ path: "en-US/video.txt", text: "a".repeat(5000) }])).toEqual([]);
});

test("problemLine names the file, its length and the limit", () => {
  expect(problemLine({ path: "apps/x/en-US/short_description.txt", length: 93, limit: 80 })).toBe(
    "apps/x/en-US/short_description.txt is 93 characters; Play allows 80",
  );
});

test("readListing reads the limited text files, sorted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-"));
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write("en-US/title.txt", "T");
  write("en-US/short_description.txt", "S");
  write("en-US/video.txt", "V");
  write("en-US/changelogs/2.txt", "two");
  write("en-US/changelogs/10.txt", "ten");
  write("en-US/images/x.png", "png");
  write("README", "readme");
  expect(readListing(dir)).toEqual([
    { path: path.join(dir, "en-US/title.txt"), text: "T" },
    { path: path.join(dir, "en-US/short_description.txt"), text: "S" },
    { path: path.join(dir, "en-US/changelogs/10.txt"), text: "ten" },
    { path: path.join(dir, "en-US/changelogs/2.txt"), text: "two" },
  ]);
});
