#!/usr/bin/env node
// Fails when a WORKAROUND(...)/LIMITATION(...) marker names a closed issue.
// Markers: WORKAROUND(ekrooh#45) / LIMITATION(#123); `#N` is AndersCan/justus.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPOS = { "": "AndersCan/justus", ekrooh: "AndersCan/ekrooh" };
const MARKER = /\b(WORKAROUND|LIMITATION)\((ekrooh)?#(\d+)\)/g;

/** Returns [{ line, marker, repo, number }] for every marker in `text`. */
export function parseMarkers(text) {
  const out = [];
  text.split("\n").forEach((lineText, i) => {
    for (const m of lineText.matchAll(MARKER)) {
      out.push({ line: i + 1, marker: m[0], repo: REPOS[m[2] ?? ""], number: Number(m[3]) });
    }
  });
  return out;
}

const SELF = /^scripts\/check-issue-refs\./;

function scan() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter((f) => f && !SELF.test(f) && f !== "pnpm-lock.yaml");
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    for (const r of parseMarkers(text)) found.push({ file, ...r });
  }
  return found;
}

function issueState(repo, number) {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "view", String(number), "-R", repo, "--json", "state", "-q", ".state"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim();
  } catch (e) {
    throw new Error(`cannot read ${repo}#${number}: ${e.stderr?.toString().trim() || e.message}`);
  }
}

function main() {
  const found = scan();
  const cache = new Map();
  let failed = false;
  for (const f of found) {
    const key = `${f.repo}#${f.number}`;
    if (cache.has(key)) continue;
    try {
      cache.set(key, issueState(f.repo, f.number));
    } catch (e) {
      console.error(`ERROR ${e.message}`);
      cache.set(key, "UNKNOWN");
    }
  }
  for (const f of found) {
    const state = cache.get(`${f.repo}#${f.number}`);
    console.log(
      `${state === "OPEN" ? "ok    " : "FAIL  "}${f.file}:${f.line} ${f.marker} -> ${state}`,
    );
    if (state !== "OPEN") failed = true;
  }
  console.log(`${found.length} marker(s), ${cache.size} issue(s) checked.`);
  if (failed) {
    console.error(
      "\nA marker names a closed or unreadable issue. Remove the workaround, or re-open/re-file\n" +
        "the issue and update the marker. (Auth/network errors: set GH_TOKEN.)",
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
