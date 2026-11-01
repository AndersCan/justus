import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cases } from "./contracts/files.contract.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("node fs", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "justus-files-"));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const c of cases) {
    it(c.name, () => {
      const dir = fs.mkdtempSync(path.join(root, "case-"));
      return c.run(
        { fs: fs as never, path, dir, symlink: (target, link) => fs.symlinkSync(target, link) },
        makeCheck(),
      );
    });
  }
});
