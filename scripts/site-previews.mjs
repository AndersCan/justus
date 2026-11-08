#!/usr/bin/env node
// Assembles the Pages site (main plus one preview per open same-repo pull request)
// from `site-pages` artifacts, and keeps one "Site preview" comment per pull request.
//   node scripts/site-previews.mjs assemble <dir>
//   node scripts/site-previews.mjs comment <site-previews.json> <siteUrl>
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- site-preview -->";
export const MAX_PREVIEWS = 20;

const short = (sha) => sha.slice(0, 7);
const newestFirst = (a, b) => b.created_at.localeCompare(a.created_at);

/**
 * Picks the artifact sources. `prs` is `gh pr list --json number,headRefName,headRefOid,isCrossRepository`,
 * `runs` the `workflow_runs` of the successful `site-pages` runs.
 */
export function pickSources({ repo, prs, runs }) {
  const own = runs.filter((run) => run.head_repository?.full_name === repo).sort(newestFirst);
  const mainRun = own.find((run) => run.head_branch === "main" && run.event !== "pull_request");
  const main = mainRun ? { runId: mainRun.id, sha: mainRun.head_sha } : undefined;

  const previews = [];
  const skipped = [];
  const ordered = [...prs].sort((a, b) => b.number - a.number);
  for (const pr of ordered) {
    if (pr.isCrossRepository) {
      skipped.push({ number: pr.number, reason: "from a fork" });
      continue;
    }
    const run = own.find((r) => r.event === "pull_request" && r.head_branch === pr.headRefName);
    if (!run) {
      skipped.push({ number: pr.number, reason: "no successful build yet" });
      continue;
    }
    if (previews.length >= MAX_PREVIEWS) {
      skipped.push({ number: pr.number, reason: "more than 20 open pull requests" });
      continue;
    }
    previews.push({ number: pr.number, runId: run.id, sha: run.head_sha });
  }
  previews.sort((a, b) => a.number - b.number);
  skipped.sort((a, b) => a.number - b.number);
  return { main, previews, skipped };
}

/** The comment text for a live preview. `siteUrl` is the Pages root, with or without a trailing slash. */
export function commentBody(preview, siteUrl) {
  const root = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
  return `${MARKER}\nSite preview of ${short(preview.sha)}: ${root}pr/${preview.number}/`;
}

export function expiredBody(sha) {
  return `${MARKER}\nNo site preview: the build of ${short(sha)} expired. Push a commit to rebuild it.`;
}

/**
 * `existing` is the body of the first comment starting with the marker (or undefined);
 * `wanted` is `{ body, expired }`.
 */
export function commentAction(existing, wanted) {
  if (existing === undefined) return wanted.expired ? "none" : "create";
  return existing === wanted.body ? "none" : "update";
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ghJson = (args) => JSON.parse(gh(args));

function repoName() {
  return (
    process.env.GITHUB_REPOSITORY ??
    ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner
  );
}

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function assemble(dir) {
  const repo = repoName();
  const prs = ghJson([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,headRefName,headRefOid,isCrossRepository",
  ]);
  const { workflow_runs: runs } = ghJson([
    "api",
    `repos/${repo}/actions/workflows/site-pages.yml/runs?status=success&per_page=100`,
  ]);
  const picked = pickSources({ repo, prs, runs });
  if (!picked.main) throw new Error("no successful site-pages build of main to publish");

  gh([
    "run",
    "download",
    String(picked.main.runId),
    "--repo",
    repo,
    "--name",
    "site-dist",
    "--dir",
    dir,
  ]);
  if (!existsSync(`${dir}/index.html`)) throw new Error(`${dir}/index.html is missing`);
  summary(`main: ${short(picked.main.sha)}`);

  const live = [];
  const expired = [];
  for (const preview of picked.previews) {
    try {
      gh([
        "run",
        "download",
        String(preview.runId),
        "--repo",
        repo,
        "--name",
        "site-dist",
        "--dir",
        `${dir}/pr/${preview.number}`,
      ]);
      live.push({ number: preview.number, sha: preview.sha });
      summary(`#${preview.number}: preview of ${short(preview.sha)}`);
    } catch {
      expired.push({ number: preview.number, sha: preview.sha });
      summary(`#${preview.number}: build of ${short(preview.sha)} expired`);
    }
  }
  for (const skip of picked.skipped) summary(`#${skip.number}: no preview, ${skip.reason}`);
  writeFileSync("site-previews.json", `${JSON.stringify({ previews: live, expired }, null, 2)}\n`);
}

function comment(file, siteUrl) {
  const repo = repoName();
  const { previews, expired } = JSON.parse(readFileSync(file, "utf8"));
  const wanted = [
    ...previews.map((p) => ({ number: p.number, body: commentBody(p, siteUrl), expired: false })),
    ...expired.map((p) => ({ number: p.number, body: expiredBody(p.sha), expired: true })),
  ];
  for (const want of wanted) {
    const comments = ghJson([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${want.number}/comments`,
    ]).flat();
    const found = comments.find((c) => c.body.startsWith(MARKER));
    const action = commentAction(found?.body, want);
    if (action === "create") {
      gh([
        "api",
        "-X",
        "POST",
        `repos/${repo}/issues/${want.number}/comments`,
        "-f",
        `body=${want.body}`,
      ]);
    } else if (action === "update") {
      gh([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/issues/comments/${found.id}`,
        "-f",
        `body=${want.body}`,
      ]);
    }
    console.log(`#${want.number}: ${action}`);
  }
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === "assemble" && rest.length === 1) return assemble(rest[0]);
  if (command === "comment" && rest.length === 2) return comment(rest[0], rest[1]);
  throw new Error("usage: site-previews.mjs assemble <dir> | comment <json> <siteUrl>");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
