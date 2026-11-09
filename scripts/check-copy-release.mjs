import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGELOG, PLAY_LIMIT, changelogSection, userLines } from "./release-note.mjs";

export const CATALOGUE = "apps/web/src/copy/en.json";
export const SHOTS_MANIFEST = "apps/android/fastlane/store-screenshots.json";

/** Ids of catalogue entries whose status is not "approved", filtered by id prefix. */
export function draftIds(catalogue, prefix = "") {
  return Object.entries(catalogue)
    .filter(([id, entry]) => id.startsWith(prefix) && entry.status !== "approved")
    .map(([id]) => id)
    .sort();
}

/** The screenshots the listing uploads; must match SCREENSHOTS in apps/android/fastlane/Fastfile. */
export const STORE_SHOTS = ["1_album", "2_invite", "3_photo", "4_help"];

/** Expected store screenshots whose manifest entry is missing or not approved: true. */
export function draftShots(manifest) {
  return STORE_SHOTS.filter((name) => manifest[name]?.approved !== true).sort();
}

/**
 * What a release refuses. scope "app" is the text inside the app (everything but
 * `store.*`); "store" is the Play listing text and screenshots.
 */
export function releaseProblems({ catalogue, manifest, scope, noteLines = [] }) {
  const problems = [];
  if (scope === "note") {
    // A line longer than Play's limit can never be shown, so the note would drop it.
    for (const line of noteLines) {
      if (`• ${line}`.length > PLAY_LIMIT) {
        problems.push(`Release note line over ${PLAY_LIMIT} characters: ${line.slice(0, 40)}…`);
      }
    }
  }
  if (scope === "app") {
    const ids = draftIds(catalogue).filter((id) => !id.startsWith("store."));
    if (ids.length > 0) problems.push(`Draft app text: ${ids.join(", ")}`);
  }
  if (scope === "store") {
    const ids = draftIds(catalogue, "store.");
    if (ids.length > 0) problems.push(`Draft store listing text: ${ids.join(", ")}`);
    const shots = draftShots(manifest);
    if (shots.length > 0) problems.push(`Store screenshots not approved: ${shots.join(", ")}`);
  }
  return problems;
}

function main() {
  const scope = process.argv[2];
  if (scope !== "app" && scope !== "store" && scope !== "note") {
    console.error("usage: check-copy-release.mjs app|store|note <version>");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const changelog = path.join(root, CHANGELOG);
  const noteLines =
    scope === "note" && fs.existsSync(changelog)
      ? userLines(changelogSection(fs.readFileSync(changelog, "utf8"), process.argv[3]))
      : [];
  const problems = releaseProblems({
    catalogue: scope === "note" ? {} : read(CATALOGUE),
    manifest: scope === "note" ? {} : read(SHOTS_MANIFEST),
    scope,
    noteLines,
  });
  if (problems.length > 0) {
    for (const line of problems) console.error(line);
    console.error(
      "Only the owner approves text: set status to approved in en.json, or approved in store-screenshots.json.",
    );
    process.exit(1);
  }
  console.log(`Copy release gate (${scope}): everything approved.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
