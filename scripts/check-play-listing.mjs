import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const METADATA_DIR = "apps/android/fastlane/metadata/android";
// Play Console limits, in characters.
export const LIMITS = {
  "title.txt": 30,
  "short_description.txt": 80,
  "full_description.txt": 4000,
};
export const RELEASE_NOTE_LIMIT = 500;

/** Characters as Play counts them: code points, ignoring one final line ending. */
export function playLength(text) {
  return [...text.replace(/\r?\n$/, "")].length;
}

function limitFor(file) {
  const name = path.basename(file);
  if (Object.hasOwn(LIMITS, name)) return LIMITS[name];
  if (path.basename(path.dirname(file)) === "changelogs" && name.endsWith(".txt")) {
    return RELEASE_NOTE_LIMIT;
  }
  return undefined;
}

/** One problem per file over its limit, in the order given. */
export function listingProblems(files) {
  const problems = [];
  for (const file of files) {
    const limit = limitFor(file.path);
    if (limit === undefined) continue;
    const length = playLength(file.text);
    if (length > limit) problems.push({ path: file.path, length, limit });
  }
  return problems;
}

/** The message a person sees for one problem. */
export function problemLine({ path: file, length, limit }) {
  return `${file} is ${length} characters; Play allows ${limit}`;
}

/** Reads the listing text files under metadataDir, sorted by path. */
export function readListing(metadataDir) {
  const files = [];
  const locales = fs
    .readdirSync(metadataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const locale of locales) {
    const localeDir = path.join(metadataDir, locale);
    for (const name of Object.keys(LIMITS)) {
      const file = path.join(localeDir, name);
      if (fs.existsSync(file)) files.push({ path: file, text: fs.readFileSync(file, "utf8") });
    }
    const changelogs = path.join(localeDir, "changelogs");
    if (!fs.existsSync(changelogs)) continue;
    const notes = fs
      .readdirSync(changelogs)
      .filter((name) => name.endsWith(".txt"))
      .sort();
    for (const name of notes) {
      const file = path.join(changelogs, name);
      files.push({ path: file, text: fs.readFileSync(file, "utf8") });
    }
  }
  return files;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = path.join(root, METADATA_DIR);
  if (!fs.existsSync(dir)) {
    console.error(
      `check-play-listing: no listing at ${METADATA_DIR}; update METADATA_DIR if it moved`,
    );
    process.exit(1);
  }
  const files = readListing(dir).map((file) => ({
    ...file,
    path: path.relative(root, file.path),
  }));
  if (files.length === 0) {
    console.error(`check-play-listing: no listing text under ${METADATA_DIR}`);
    process.exit(1);
  }
  const problems = listingProblems(files);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problemLine(problem));
    console.error("Shorten the text, or check the limit in Play Console.");
    process.exit(1);
  }
  console.log(`Play listing text: ${files.length} file(s) within Play's limits.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
