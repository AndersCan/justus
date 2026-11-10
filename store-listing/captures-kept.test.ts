// Repro for PR #655: running flow-photo.test.ts must not overwrite a capture
// the developer already has when some of the five are missing.
// Place in store-listing/. Run: pnpm exec vp test run store-listing/captures-kept.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

const repo = join(import.meta.dirname, "..");
const captures = join(repo, "store-listing/captures/android");
const names = ["album", "invite", "photo", "settings", "help"];

it("keeps an existing capture when flow-photo.test.ts fills in missing ones", () => {
  const saved = names.map((n) => {
    const file = join(captures, `${n}.png`);
    return existsSync(file) ? readFileSync(file) : undefined;
  });
  try {
    mkdirSync(captures, { recursive: true });
    for (const n of names) rmSync(join(captures, `${n}.png`), { force: true });
    const real = readFileSync(join(repo, "assets/brand/justus-wordmark-dark.png"));
    writeFileSync(join(captures, "album.png"), real);
    spawnSync("pnpm", ["exec", "vp", "test", "run", "store-listing/flow-photo.test.ts"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(readFileSync(join(captures, "album.png")).equals(real)).toBe(true);
  } finally {
    names.forEach((n, at) => {
      const file = join(captures, `${n}.png`);
      if (saved[at]) writeFileSync(file, saved[at]);
      else rmSync(file, { force: true });
    });
  }
}, 180_000);
