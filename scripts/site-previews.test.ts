import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vite-plus/test";
// @ts-expect-error plain .mjs script
import { MARKER, commentAction, commentBody, expiredBody, pickSources } from "./site-previews.mjs";

const repo = "AndersCan/justus";
let n = 0;
const run = (over: object) => ({
  id: ++n,
  event: "pull_request",
  head_branch: "feat",
  head_sha: "1a2b3c4d5e6f",
  created_at: `2026-11-08T00:00:${String(n).padStart(2, "0")}Z`,
  head_repository: { full_name: repo },
  ...over,
});
const pr = (over: object) => ({
  number: 1,
  headRefName: "feat",
  headRefOid: "x",
  isCrossRepository: false,
  ...over,
});

test("main is the newest non-PR run on main, including a workflow_run event", () => {
  const old = run({ event: "push", head_branch: "main", head_sha: "old" });
  const newest = run({ event: "workflow_run", head_branch: "main", head_sha: "new" });
  const prRun = run({ head_branch: "main", head_sha: "pr" });
  const picked = pickSources({ repo, prs: [], runs: [old, newest, prRun] });
  expect(picked.main).toEqual({ runId: newest.id, sha: "new" });
});

test("no main run gives main undefined", () => {
  expect(pickSources({ repo, prs: [], runs: [run({})] }).main).toBeUndefined();
});

test("a fork run does not count as the branch's build", () => {
  const forkRun = run({ head_repository: { full_name: "someone/justus" } });
  const picked = pickSources({ repo, prs: [pr({})], runs: [forkRun] });
  expect(picked.previews).toEqual([]);
  expect(picked.skipped).toEqual([{ number: 1, reason: "no successful build yet" }]);
});

test("a cross-repo pull request is skipped as from a fork", () => {
  const picked = pickSources({ repo, prs: [pr({ isCrossRepository: true })], runs: [run({})] });
  expect(picked.skipped).toEqual([{ number: 1, reason: "from a fork" }]);
});

test("the newest of two same-branch runs wins", () => {
  const a = run({ head_sha: "aaaaaaa" });
  const b = run({ head_sha: "bbbbbbb" });
  const picked = pickSources({ repo, prs: [pr({})], runs: [b, a] });
  expect(picked.previews).toEqual([{ number: 1, runId: b.id, sha: "bbbbbbb", latest: false }]);
});

test("21 pull requests give 20 previews and skip the lowest number", () => {
  const prs = Array.from({ length: 21 }, (_, i) => pr({ number: i + 1, headRefName: `b${i + 1}` }));
  const runs = prs.map((p) => run({ head_branch: p.headRefName }));
  const picked = pickSources({ repo, prs, runs });
  expect(picked.previews).toHaveLength(20);
  expect(picked.previews[0].number).toBe(2);
  expect(picked.skipped).toEqual([{ number: 1, reason: "more than 20 open pull requests" }]);
});

test("commentBody uses a 7-character sha and the pr folder", () => {
  expect(
    commentBody({ number: 12, sha: "1a2b3c4d5e6f" }, "https://anderscan.github.io/justus/"),
  ).toBe(
    "<!-- site-preview -->\nSite preview of 1a2b3c4: https://anderscan.github.io/justus/pr/12/",
  );
  expect(
    commentBody({ number: 12, sha: "1a2b3c4d5e6f" }, "https://anderscan.github.io/justus"),
  ).toContain("justus/pr/12/");
});

test("expiredBody names the sha", () => {
  expect(expiredBody("1a2b3c4d5e6f")).toBe(
    "<!-- site-preview -->\nNo site preview: the build of 1a2b3c4 expired. Push a commit to rebuild it.",
  );
});

test("commentAction creates, updates, skips equal and skips expired without a comment", () => {
  const live = { body: "new", expired: false };
  expect(commentAction(undefined, live)).toBe("create");
  expect(commentAction("old", live)).toBe("update");
  expect(commentAction("new", live)).toBe("none");
  expect(commentAction(undefined, { body: "gone", expired: true })).toBe("none");
  expect(commentAction("old", { body: "gone", expired: true })).toBe("update");
});

test("main is found among older runs, newest first, and every main run is a candidate", () => {
  const m1 = run({ event: "push", head_branch: "main", head_sha: "m1" });
  const m2 = run({ event: "push", head_branch: "main", head_sha: "m2" });
  const picked = pickSources({ repo, prs: [], runs: [m1, m2] });
  expect(picked.main).toEqual({ runId: m2.id, sha: "m2" });
  expect(picked.mains.map((m: { sha: string }) => m.sha)).toEqual(["m2", "m1"]);
});

test("a preview of an older commit is marked not latest", () => {
  const stale = run({ head_sha: "oldsha1" });
  const fresh = run({ head_branch: "b2", head_sha: "newsha2" });
  const picked = pickSources({
    repo,
    prs: [
      pr({ headRefOid: "newer00" }),
      pr({ number: 2, headRefName: "b2", headRefOid: "newsha2" }),
    ],
    runs: [stale, fresh],
  });
  expect(picked.previews.map((p: { latest: boolean }) => p.latest)).toEqual([false, true]);
});

test("commentBody flags a preview that is not the newest commit", () => {
  expect(commentBody({ number: 3, sha: "1a2b3c4d5e6f", latest: false }, "https://x.io/")).toBe(
    "<!-- site-preview -->\nSite preview of 1a2b3c4 (the newest commit is still building or failed): https://x.io/pr/3/",
  );
});

describe("assemble and comment with a stubbed gh", () => {
  const script = fileURLToPath(new URL("./site-previews.mjs", import.meta.url));
  const stub = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
const cfg = JSON.parse(process.env.STUB_CFG);
const line = args.join(" ");
if (args[0] === "pr") console.log(JSON.stringify(cfg.prs));
else if (args[0] === "run") {
  const id = args[2];
  if (cfg.expired.includes(Number(id))) process.exit(1);
  const dir = args[args.indexOf("--dir") + 1];
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/index.html", "x");
} else if (line.includes("/runs?")) {
  const q = line.slice(line.indexOf("?") + 1);
  console.log(JSON.stringify({ workflow_runs: cfg.runs.filter((r) => q.includes("branch=" + r.head_branch + "&")) }));
} else if (line.includes("/comments")) console.log(JSON.stringify([cfg.comments ?? []]));
`;
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function setup(cfg: object) {
    const dir = mkdtempSync(join(tmpdir(), "sp-"));
    dirs.push(dir);
    writeFileSync(join(dir, "gh"), stub, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: repo,
      STUB_LOG: join(dir, "log"),
      STUB_CFG: JSON.stringify(cfg),
      GITHUB_STEP_SUMMARY: "",
    };
    writeFileSync(join(dir, "log"), "");
    const exec = (...args: string[]) =>
      spawnSync("node", [script, ...args], { cwd: dir, env, encoding: "utf8" });
    const calls = () =>
      readFileSync(join(dir, "log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[]);
    return { dir, exec, calls };
  }
  const mainRun = (id: number, sha: string) => ({
    id,
    event: "push",
    head_branch: "main",
    head_sha: sha,
    created_at: `2026-11-08T00:00:${String(id).padStart(2, "0")}Z`,
    head_repository: { full_name: repo },
  });

  test("falls back to an older main build when the newest artifact expired", () => {
    const { dir, exec } = setup({
      prs: [],
      expired: [20],
      runs: [mainRun(10, "aaaaaaa1"), mainRun(20, "bbbbbbb2")],
    });
    const result = exec("assemble", "out");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("main: build of bbbbbbb expired");
    expect(result.stdout).toContain("main: aaaaaaa");
    expect(readFileSync(join(dir, "out/index.html"), "utf8")).toBe("x");
  });

  test("fails clearly when every main build expired", () => {
    const { exec } = setup({ prs: [], expired: [10], runs: [mainRun(10, "aaaaaaa1")] });
    const result = exec("assemble", "out");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("every recent site-pages build of main has expired");
  });

  test("queries main and each pull request branch on its own and records previews", () => {
    const prRun = {
      ...mainRun(30, "ccccccc3"),
      event: "pull_request",
      head_branch: "feat",
    };
    const { dir, exec, calls } = setup({
      prs: [
        { number: 7, headRefName: "feat", headRefOid: "ddddddd4", isCrossRepository: false },
        { number: 8, headRefName: "fork", headRefOid: "e", isCrossRepository: true },
      ],
      expired: [],
      runs: [mainRun(10, "aaaaaaa1"), prRun],
    });
    expect(exec("assemble", "out").status).toBe(0);
    const urls = calls()
      .filter((c) => c[0] === "api")
      .map((c) => c[1]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("branch=main&status=success");
    expect(urls[1]).toContain("branch=feat&event=pull_request&status=success");
    const json = JSON.parse(readFileSync(join(dir, "site-previews.json"), "utf8"));
    expect(json).toEqual({
      previews: [{ number: 7, sha: "ccccccc3", latest: false }],
      expired: [],
    });
  });

  test("comment creates, updates and leaves matching comments alone", () => {
    const body = commentBody({ number: 7, sha: "ccccccc3", latest: true }, "https://x.io/");
    const file = (dir: string) => {
      writeFileSync(
        join(dir, "p.json"),
        JSON.stringify({ previews: [{ number: 7, sha: "ccccccc3", latest: true }], expired: [] }),
      );
    };
    const created = setup({ comments: [] });
    file(created.dir);
    expect(created.exec("comment", "p.json", "https://x.io/").stdout).toContain("#7: create");
    expect(created.calls().some((c) => c.includes("POST"))).toBe(true);

    const updated = setup({ comments: [{ id: 5, body: `${MARKER}\nold` }] });
    file(updated.dir);
    expect(updated.exec("comment", "p.json", "https://x.io/").stdout).toContain("#7: update");
    expect(updated.calls().some((c) => c.includes("PATCH"))).toBe(true);

    const same = setup({ comments: [{ id: 5, body }] });
    file(same.dir);
    const out = same.exec("comment", "p.json", "https://x.io/");
    expect(out.stdout).toContain("#7: none");
    expect(same.calls().some((c) => c.includes("POST") || c.includes("PATCH"))).toBe(false);
  });
});
