import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSIONS_FILE = "apps/backend/src/versions.ts";

/** PEER_PROTOCOL in versions.ts; a missing file (before the number existed) counts as 1. */
export function protocolOf(versionsTs) {
  if (versionsTs === undefined) return 1;
  const match = /export const PEER_PROTOCOL = (\d+);/.exec(versionsTs);
  return match ? Number(match[1]) : 1;
}

/** The first `## ` section of BREAKING.md: its protocol and body (trailing space trimmed). */
export function firstSection(breakingMd) {
  const start = breakingMd.search(/^## /m);
  if (start === -1) return undefined;
  const rest = breakingMd.slice(start);
  const next = rest.slice(3).search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next + 3);
  const newline = section.indexOf("\n");
  const heading = newline === -1 ? section : section.slice(0, newline);
  const match = /^## .* · peer protocol (\d+)\b/.exec(heading);
  if (!match) return undefined;
  const body = newline === -1 ? "" : section.slice(newline + 1);
  return { protocol: Number(match[1]), body: body.trimEnd() };
}

/** The newest `vX.Y.Z` tag by number; other tags are ignored. */
export function latestRelease(tags) {
  const versions = tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .map((tag) => ({ tag, parts: tag.slice(1).split(".").map(Number) }));
  versions.sort(
    (a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2],
  );
  return versions[0]?.tag;
}

/**
 * `protocol`: PEER_PROTOCOL now. `top`: first BREAKING.md section now.
 * `released`: { tag, protocol, top } at the latest release tag, `top` being its first section.
 */
export function problems({ protocol, top, released }) {
  if (top === undefined) {
    return [`BREAKING.md must start with a section "## Unreleased · peer protocol ${protocol}".`];
  }
  if (top.protocol !== protocol) {
    return [
      `BREAKING.md's first section says peer protocol ${top.protocol}, but ${VERSIONS_FILE} has PEER_PROTOCOL = ${protocol}. Make them the same.`,
    ];
  }
  if (released && released.protocol === protocol && released.top?.body !== top.body) {
    return [
      `Peer protocol ${protocol} already shipped in ${released.tag}. A change to a file on a drive needs a new one: set PEER_PROTOCOL = ${protocol + 1} in ${VERSIONS_FILE} and add "## Unreleased · peer protocol ${protocol + 1}" above the first section in BREAKING.md.`,
    ];
  }
  return [];
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitShow(root, tag, file) {
  try {
    return git(root, ["show", `${tag}:${file}`]);
  } catch {
    return undefined;
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tag = latestRelease(git(root, ["tag", "-l", "v*"]).split("\n"));
  if (tag === undefined) {
    console.error(
      "check-peer-protocol: No release tags found. Fetch them (git fetch --tags) and run again.",
    );
    process.exit(1);
  }
  const protocol = protocolOf(fs.readFileSync(path.join(root, VERSIONS_FILE), "utf8"));
  const top = firstSection(fs.readFileSync(path.join(root, "BREAKING.md"), "utf8"));
  const oldBreaking = gitShow(root, tag, "BREAKING.md");
  const released = {
    tag,
    protocol: protocolOf(gitShow(root, tag, VERSIONS_FILE)),
    top: oldBreaking === undefined ? undefined : firstSection(oldBreaking),
  };
  const found = problems({ protocol, top, released });
  if (found.length > 0) {
    for (const line of found) console.error(`check-peer-protocol: ${line}`);
    process.exit(1);
  }
  console.log(
    `check-peer-protocol: peer protocol ${protocol}, last release ${tag} shipped ${released.protocol}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
