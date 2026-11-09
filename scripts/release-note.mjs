#!/usr/bin/env node
/**
 * Prints the Play release note for a version: the `[user]:` lines of its
 * section in apps/android/CHANGELOG.md (written by `bumpy version`), one per
 * line as "• …", at most 500 characters (Play's limit).
 * Usage: release-note.mjs <version>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EMPTY_NOTE = "Bug fixes and improvements.";
export const PLAY_LIMIT = 500;
export const CHANGELOG = "apps/android/CHANGELOG.md";

// bumpy writes "- *(minor)* [user]: …" or, for a multi-line body, indented lines.
const USER_LINE = /^\s*(?:-\s+)?(?:\*\([a-z]+\)\*\s+)?\[user\]:\s*(.+?)\s*$/i;

/** Returns the body of the `## <version>` section ("v0.3.0" is "0.3.0"), or "" when there is none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const heading = `## ${version.replace(/^v/, "")}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Returns the text after `[user]:` on each matching line of a changelog section. */
export function userLines(section) {
  const found = [];
  for (const line of section.split("\n")) {
    const match = USER_LINE.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

/** Joins lines as "• …", keeping whole lines while the note fits `max` characters. */
export function releaseNote(lines, max = PLAY_LIMIT) {
  const kept = [];
  let length = 0;
  for (const line of lines) {
    const bullet = `• ${line}`;
    const next = length + (kept.length > 0 ? 1 : 0) + bullet.length;
    if (next > max) break;
    kept.push(bullet);
    length = next;
  }
  return kept.length === 0 ? EMPTY_NOTE : kept.join("\n");
}

function main() {
  const version = process.argv[2];
  if (!version || !/^v?\d+\.\d+\.\d+/.test(version)) {
    console.error("usage: release-note.mjs <version>");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = path.join(root, CHANGELOG);
  const changelog = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  console.log(releaseNote(userLines(changelogSection(changelog, version))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
