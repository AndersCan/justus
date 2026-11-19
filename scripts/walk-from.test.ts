import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const walkFrom = join(import.meta.dirname, "walk-from.sh");
const maestro = join(import.meta.dirname, "maestro-e2e.sh");

function sh(cwd: string, cmd: string) {
  const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
}

function exe(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// A repo with tags `tags` on successive commits (HEAD is the last), walk-from.sh in it, a stub
// pnpm on PATH and a stub gradlew in every commit that writes the APK (or fails).
function repo(tags: (string | undefined)[], gradle: "builds" | "fails" = "builds") {
  const dir = mkdtempSync(join(tmpdir(), "walk-from-"));
  const root = join(dir, "repo");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "apps/android"), { recursive: true });
  writeFileSync(join(root, "scripts/walk-from.sh"), readFileSync(walkFrom));
  exe(
    join(root, "apps/android/gradlew"),
    gradle === "fails"
      ? "echo 'compile error' >&2; exit 1"
      : 'mkdir -p app/build/outputs/apk/release && echo "$JUSTUS_VERSION_NAME" > app/build/outputs/apk/release/app-release.apk',
  );
  sh(root, "git init -q && git config user.email t@t && git config user.name t && git add -A");
  tags.forEach((tag, i) => {
    sh(root, `git commit -q --allow-empty -m c${i}${tag ? ` && git tag ${tag}` : ""}`);
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  exe(join(bin, "pnpm"), "exit 0");
  const env = join(dir, "github-env");
  const r = spawnSync("bash", [join(root, "scripts/walk-from.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_ENV: env,
      JUSTUS_WALK_FROM: "",
    },
  });
  return { r, dir, githubEnv: existsSync(env) ? readFileSync(env, "utf8") : "" };
}

test("on a release commit it builds the release before it, not the commit's own tag", () => {
  const { r, dir, githubEnv } = repo(["v0.4.0", undefined, "v0.5.0"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("JUSTUS_WALK_FROM_TAG=v0.4.0");
  expect(
    readFileSync(
      join(dir, "justus-walk-from/apps/android/app/build/outputs/apk/release/app-release.apk"),
      "utf8",
    ),
  ).toBe("0.4.0\n");
  // The workflow's walk step reads these, so it does not build the old release a second time.
  expect(githubEnv).toContain(`JUSTUS_WALK_FROM=${join(dir, "justus-walk-from")}\n`);
  expect(githubEnv).toContain("JUSTUS_WALK_FROM_TAG=v0.4.0\n");
});

test("with no earlier release it fails by name", () => {
  const { r } = repo([undefined, "v0.1.0"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("walk-from: no v* tag before this commit");
});

test("an earlier release that no longer builds fails by name", () => {
  const { r, githubEnv } = repo(["v0.4.0", undefined], "fails");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("walk-from: v0.4.0 no longer builds");
  expect(githubEnv).toBe("");
});

// Runs maestro-e2e.sh's walk-from block with a stub walk-from.sh in a fake repo root.
function walkBlock(from: string | undefined, apk: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-walk-from-"));
  mkdirSync(join(dir, "scripts"));
  const old = join(dir, "old");
  if (apk) {
    mkdirSync(join(old, "apps/android/app/build/outputs/apk/release"), { recursive: true });
    writeFileSync(join(old, "apps/android/app/build/outputs/apk/release/app-release.apk"), "");
  }
  writeFileSync(
    join(dir, "scripts/walk-from.sh"),
    `echo "> Task :app:assembleRelease"\necho "JUSTUS_WALK_FROM=${old}"\necho "JUSTUS_WALK_FROM_TAG=v0.4.0"\n`,
  );
  const driver = join(dir, "driver.sh");
  writeFileSync(
    driver,
    `set -uo pipefail
REPO_ROOT="${dir}"; WALK=1
eval "$(sed -n '/^if \\[\\[ "\\$WALK" == 1 \\]\\]; then/,/^fi$/{p;/^fi$/q}' "${maestro}")"
bash -c 'echo "walk env: $JUSTUS_WALK_FROM $JUSTUS_WALK_FROM_TAG"'
`,
  );
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.JUSTUS_WALK_FROM;
  delete env.JUSTUS_WALK_FROM_TAG;
  if (from !== undefined) env.JUSTUS_WALK_FROM = from === "old" ? old : from;
  return { ...spawnSync("bash", [driver], { encoding: "utf8", env }), old };
}

test("walk mode builds the old release itself and passes its folder and tag to the walk", () => {
  const r = walkBlock(undefined, true);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`walk env: ${r.old} v0.4.0`);
});

test("walk mode stops by name when the old release's APK is missing", () => {
  const r = walkBlock("old", false);
  expect(r.status).toBe(1);
  expect(r.stdout).not.toContain("walk env:");
  expect(r.stderr).toContain("✗ no earlier release APK at");
});
