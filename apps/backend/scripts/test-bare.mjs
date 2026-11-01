// Runs the shared p2p scenarios (test/p2p-scenarios.ts) inside the Bare
// runtime with the real bare-fs/bare-path/bare-crypto deps, the way the worklet
// runs in production. Catches "works in Node, breaks in Bare" (#200).
//
//   node scripts/test-bare.mjs [only=<substring of scenario name>]
//
// Bundles with the same externals as the worklet build, so the p2p stack and
// bare-* modules resolve from node_modules under Bare. Exits non-zero on any
// failure. Everything (bundle, scratch dir, child) is torn down before exit.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workletBuildOptions } from "./build.mjs";

const require = createRequire(import.meta.url);
const bareExecutable = require("bare-runtime")();
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const scratch = mkdtempSync(join(tmpdir(), "justus-bare-test-"));
const bundle = join(root, "dist", "test-bare.gen.js");
const base = workletBuildOptions("test/bare/entry.ts", bundle);

let exitCode = 1;
let child;
try {
  await build({
    ...base,
    // hyperdht/testnet and the bare-http1 client are test-only, so they are not in the worklet's list.
    external: [...base.external, "hyperdht", "bare-http1"],
    logLevel: "warning",
  });
  const extra = process.argv.slice(2);
  child = spawn(bareExecutable, [bundle, `dir=${scratch}`, ...extra], { stdio: "inherit" });
  const killer = setTimeout(() => child.kill("SIGKILL"), 8 * 60_000);
  exitCode = await new Promise((done) => {
    child.on("error", (e) => {
      console.error(`test-bare: failed to spawn bare: ${e.message}`);
      done(1);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  clearTimeout(killer);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
  rmSync(bundle, { force: true });
}
process.exit(exitCode);
