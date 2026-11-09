// @ts-expect-error release-note.mjs is a plain script without type declarations
import { changelogSection, releaseNote, userLines } from "./release-note.mjs";
import { spawnSync } from "node:child_process";
import { expect, test } from "vite-plus/test";

const changelog = `# Changelog

## 0.3.0
<sub>2026-11-10</sub>

- *(minor)*
  [user]: Photos you add offline send when you are back online.
  Refactor the send queue.
  [user]: Album grid tiles stay in place.
- *(patch)* [user]: Invite links open the right album.
- *(patch)* Bump a dependency.

## 0.2.6
<sub>2026-11-01</sub>

- *(patch)* Tidy CI.
`;

test("reads only the [user] lines of the asked version, prefix stripped", () => {
  expect(userLines(changelogSection(changelog, "0.3.0"))).toEqual([
    "Photos you add offline send when you are back online.",
    "Album grid tiles stay in place.",
    "Invite links open the right album.",
  ]);
});

test("a version with no [user] lines gets the fallback note", () => {
  expect(releaseNote(userLines(changelogSection(changelog, "0.2.6")))).toBe(
    "Bug fixes and improvements.",
  );
});

test("an unknown version or an empty changelog gets the fallback note", () => {
  expect(changelogSection(changelog, "9.9.9")).toBe("");
  expect(releaseNote(userLines(changelogSection("", "0.3.0")))).toBe("Bug fixes and improvements.");
});

test("a tag name with a leading v finds the same section", () => {
  expect(changelogSection(changelog, "v0.2.6")).toBe(changelogSection(changelog, "0.2.6"));
  expect(changelogSection(changelog, "v0.2.6")).not.toBe("");
});

test("a version is not matched by prefix", () => {
  expect(changelogSection("## 0.3.10\n- [user]: x", "0.3.1")).toBe("");
});

test("lines are bullets, one per line", () => {
  expect(releaseNote(["One.", "Two."])).toBe("• One.\n• Two.");
});

test("over 500 characters is cut at a line boundary", () => {
  const a = "a".repeat(300);
  const b = "b".repeat(300);
  expect(releaseNote([a, b])).toBe(`• ${a}`);
});

test("exactly 500 characters is kept, 501 is cut", () => {
  const first = "a".repeat(248); // "• " + 248 = 250
  const fits = "b".repeat(247); // "\n• " + 247 = 250, total 500
  expect(releaseNote([first, fits]).length).toBe(500);
  expect(releaseNote([first, `${fits}c`])).toBe(`• ${first}`);
});

test("a first line over 500 characters leaves the fallback note", () => {
  expect(releaseNote(["x".repeat(600)])).toBe("Bug fixes and improvements.");
});

test("the script prints the fallback for a version without notes and rejects a bad version", () => {
  const ok = spawnSync("node", ["scripts/release-note.mjs", "0.0.1"], { encoding: "utf8" });
  expect(ok.stdout.trim()).toBe("Bug fixes and improvements.");
  const bad = spawnSync("node", ["scripts/release-note.mjs", "oops"], { encoding: "utf8" });
  expect(bad.status).toBe(2);
});
