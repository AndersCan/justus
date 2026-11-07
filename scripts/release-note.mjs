#!/usr/bin/env node
/**
 * Prints a one-line release note (at most 120 characters) from the merged PR
 * titles since the previous release tag.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PR_SUFFIX = / \(#\d+\)$/;
const SKIPPED = /^(ci|test|tests|chore|docs|build|refactor|style|vision)(\([^)]*\))?!?:|^Bump /i;
const EMPTY_NOTE = "Bug fixes and improvements.";

/** Takes subjects newest first and returns one line of at most `max` characters. */
export function releaseNote(subjects, max = 120) {
  const titles = [];
  for (const subject of subjects) {
    if (!PR_SUFFIX.test(subject)) continue;
    const title = subject.replace(PR_SUFFIX, "").trim();
    if (SKIPPED.test(title)) continue;
    const shown = title.replace(/^Android:\s*/i, "");
    if (shown !== "") titles.push(shown);
  }
  if (titles.length === 0) return EMPTY_NOTE;

  function lineFor(count) {
    const suffix = count === titles.length ? "." : `; and ${titles.length - count} more.`;
    return titles.slice(0, count).join("; ") + suffix;
  }

  let count = 1;
  while (count < titles.length && lineFor(count + 1).length <= max) count += 1;
  const line = lineFor(count);
  if (line.length <= max) return line;

  const suffix = lineFor(1).slice(titles[0].length);
  return titles[0].slice(0, Math.max(0, max - suffix.length - 1)).trimEnd() + "…" + suffix;
}

/** Returns the newest release tag before HEAD, or undefined when there is none. */
export function previousTag(git) {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD~1"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  function git(args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
  }
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.error("release-note: the checkout is shallow; use fetch-depth: 0");
    process.exit(1);
  }
  const tag = previousTag(git);
  const range = tag ? [`${tag}..HEAD`] : [];
  const log = git(["log", "--first-parent", "--format=%s", ...range]);
  console.log(releaseNote(log.split("\n").filter(Boolean)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
