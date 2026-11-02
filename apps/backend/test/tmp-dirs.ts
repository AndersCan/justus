import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";

const paths: string[] = [];

afterAll(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Removes `path` (dir or symlink) when the importing test file finishes. */
export function trackTmpPath(path: string): string {
  paths.push(path);
  return path;
}

/** Creates a temp dir that is removed when the importing test file finishes. */
export function makeTmpDir(prefix: string): string {
  return trackTmpPath(mkdtempSync(join(tmpdir(), prefix)));
}
