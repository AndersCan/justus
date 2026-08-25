/**
 * Playwright globalSetup for the justus multi-instance e2e hub (issue #18).
 *
 * Boots the hub (`scripts/e2e-hub.mjs` live mode) which spawns one local DHT +
 * N Bare worklet instances, then waits for `.dev-e2e-hub/registry.json` to
 * become ready. Records the spawned hub parent pid so `globalTeardown` can kill
 * it (and, via the hub's own SIGTERM handler, its DHT + worklet children).
 *
 * Requires: the bare build + `node` + (for the actual run) Playwright browsers
 * and peers. Not exercised by the fast `vp` checks — it is the e2e-p2p harness.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registryPath, waitForRegistry, HUB_PID_FILE } from "./registry-reader.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const HUB_SCRIPT = resolve(repoRoot, "scripts", "e2e-hub.mjs");

export default async function globalSetup() {
  const count = Number(process.env.JUSTUS_HUB_COUNT || 2);
  const child = spawn("node", [HUB_SCRIPT, "--count", String(count)], { stdio: "inherit" });

  const path = registryPath();
  try {
    await waitForRegistry(path, 120_000);
  } catch (e) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    throw e;
  }

  if (child.pid != null) {
    writeFileSync(HUB_PID_FILE, String(child.pid));
  }
}
