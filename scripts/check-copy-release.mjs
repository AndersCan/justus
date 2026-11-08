import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOGUE = "apps/web/src/copy/en.json";
export const SHOTS_MANIFEST = "apps/android/fastlane/store-screenshots.json";

/** Ids of catalogue entries whose status is not "approved", filtered by id prefix. */
export function draftIds(catalogue, prefix = "") {
  return Object.entries(catalogue)
    .filter(([id, entry]) => id.startsWith(prefix) && entry.status !== "approved")
    .map(([id]) => id)
    .sort();
}

/** Names of store screenshots whose manifest entry is not approved. */
export function draftShots(manifest) {
  return Object.entries(manifest)
    .filter(([, entry]) => entry.approved !== true)
    .map(([name]) => name)
    .sort();
}

/**
 * What a release refuses. scope "app" is the text inside the app (everything but
 * `store.*`); "store" is the Play listing text and screenshots.
 */
export function releaseProblems({ catalogue, manifest, scope }) {
  const problems = [];
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
  if (scope !== "app" && scope !== "store") {
    console.error("usage: check-copy-release.mjs app|store");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const problems = releaseProblems({
    catalogue: read(CATALOGUE),
    manifest: read(SHOTS_MANIFEST),
    scope,
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
