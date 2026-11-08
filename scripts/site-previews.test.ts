import { expect, test } from "vite-plus/test";
// @ts-expect-error plain .mjs script
import { commentAction, commentBody, expiredBody, pickSources } from "./site-previews.mjs";

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
  expect(picked.previews).toEqual([{ number: 1, runId: b.id, sha: "bbbbbbb" }]);
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
