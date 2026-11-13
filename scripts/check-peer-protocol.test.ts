// @ts-expect-error check-peer-protocol.mjs is a plain script without type declarations
import { firstSection, latestRelease, problems, protocolOf } from "./check-peer-protocol.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";

const md = (heading: string, body: string) =>
  `# Breaking changes\n\nintro\n\n${heading}\n\n${body}\n\n## old · peer protocol 1\n\n- x\n`;

test("protocolOf reads the number, and a missing file is 1", () => {
  expect(protocolOf("export const PEER_PROTOCOL = 7;")).toBe(7);
  expect(protocolOf(undefined)).toBe(1);
});

test("firstSection takes the first section only, trimmed", () => {
  const top = firstSection(md("## Unreleased · peer protocol 4", "- a  \n\n\n"));
  expect(top).toEqual({ protocol: 4, body: "\n- a" });
  expect(firstSection("# Breaking changes\n\nno sections")).toBeUndefined();
  expect(firstSection("## Unreleased\n\n- a")).toBeUndefined();
});

test("latestRelease orders by number and ignores other tags", () => {
  expect(latestRelease(["v0.2.9", "v0.2.10", "store-screenshots", "v0.10.0", "v0.9.9"])).toBe(
    "v0.10.0",
  );
  expect(latestRelease(["v0.2.9", "v0.2.10"])).toBe("v0.2.10");
  expect(latestRelease(["v1.0.0", "v0.9.9"])).toBe("v1.0.0");
  expect(latestRelease(["store-screenshots", "v1.0"])).toBeUndefined();
});

const released = { tag: "v0.3.0", protocol: 4, top: { protocol: 4, body: "- a" } };

test("passes when the protocol is new, or the released section is untouched", () => {
  expect(problems({ protocol: 5, top: { protocol: 5, body: "- b" }, released })).toEqual([]);
  expect(problems({ protocol: 4, top: { protocol: 4, body: "- a" }, released })).toEqual([]);
  expect(
    problems({
      protocol: 4,
      top: { protocol: 4, body: "- b" },
      released: { ...released, protocol: 2 },
    }),
  ).toEqual([]);
});

test("fails when a shipped protocol's section changed, naming the next number", () => {
  const found = problems({ protocol: 4, top: { protocol: 4, body: "- a\n- b" }, released });
  expect(found).toEqual([
    `Peer protocol 4 already shipped in v0.3.0. A change to a file on a drive needs a new one: set PEER_PROTOCOL = 5 in apps/backend/src/versions.ts and add "## Unreleased · peer protocol 5" above the first section in BREAKING.md.`,
  ]);
});

test("fails when the first section and PEER_PROTOCOL disagree", () => {
  const found = problems({ protocol: 5, top: { protocol: 4, body: "- a" }, released });
  expect(found).toEqual([
    "BREAKING.md's first section says peer protocol 4, but apps/backend/src/versions.ts has PEER_PROTOCOL = 5. Make them the same.",
  ]);
});

test("fails when BREAKING.md has no section", () => {
  expect(problems({ protocol: 4, top: undefined, released })).toEqual([
    'BREAKING.md must start with a section "## Unreleased · peer protocol 4".',
  ]);
});

test("fails when BREAKING.md names a newer protocol than PEER_PROTOCOL (versions.ts forgotten)", () => {
  const found = problems({ protocol: 4, top: { protocol: 5, body: "- b" }, released });
  expect(found).toEqual([
    "BREAKING.md's first section says peer protocol 5, but apps/backend/src/versions.ts has PEER_PROTOCOL = 4. Make them the same.",
  ]);
});

test("a release whose BREAKING.md has no parsable first section still fails a changed body", () => {
  const found = problems({
    protocol: 4,
    top: { protocol: 4, body: "- b" },
    released: { ...released, top: undefined },
  });
  expect(found).toHaveLength(1);
});

test("latestRelease ignores tags with a prefix or suffix", () => {
  expect(latestRelease(["v0.2.5", "v0.9.0-rc1", "xv0.9.0"])).toBe("v0.2.5");
});

const breaking = (bullets: string) =>
  `# Breaking changes\n\nintro\n\n## Unreleased · peer protocol 4\n\n${bullets}\n\n## old · peer protocol 1\n\n- x\n`;

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-protocol-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "apps/backend/src"), { recursive: true });
  fs.copyFileSync(
    "scripts/check-peer-protocol.mjs",
    path.join(dir, "scripts/check-peer-protocol.mjs"),
  );
  fs.writeFileSync(
    path.join(dir, "apps/backend/src/versions.ts"),
    "export const PEER_PROTOCOL = 4;\n",
  );
  fs.writeFileSync(path.join(dir, "BREAKING.md"), breaking("- a"));
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "x");
  const run = () =>
    spawnSync("node", ["scripts/check-peer-protocol.mjs"], { cwd: dir, encoding: "utf8" });
  return { dir, git, run };
}

test("CLI: no release tag exits 1", () => {
  const { run } = repo();
  const r = run();
  expect({ status: r.status, stderr: r.stderr }).toEqual({
    status: 1,
    stderr:
      "check-peer-protocol: No release tags found. Fetch them (git fetch --tags) and run again.\n",
  });
});

test("CLI: a bullet added to the section a tag shipped fails, naming PEER_PROTOCOL = 5", () => {
  const { dir, git, run } = repo();
  git("tag", "v0.3.0");
  expect(run().status).toBe(0);
  fs.writeFileSync(path.join(dir, "BREAKING.md"), breaking("- a\n- b"));
  const r = run();
  expect({ status: r.status, stderr: r.stderr }).toEqual({
    status: 1,
    stderr: `check-peer-protocol: Peer protocol 4 already shipped in v0.3.0. A change to a file on a drive needs a new one: set PEER_PROTOCOL = 5 in apps/backend/src/versions.ts and add "## Unreleased · peer protocol 5" above the first section in BREAKING.md.\n`,
  });
});
