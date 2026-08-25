/**
 * Playwright globalTeardown for the justus multi-instance e2e hub (issue #18).
 *
 * Sends SIGTERM to the hub parent `globalSetup` spawned (via the pid it
 * recorded). The hub's own SIGTERM handler then tears down its DHT + worklet
 * children in reverse-boot order, so no orphaned process survives. Finally it
 * removes the registry + pid files so a stale registry can't mislead the next
 * run.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { HUB_PID_FILE, DEFAULT_REGISTRY_FILE } from "./registry-reader.mjs";

export default async function globalTeardown() {
  if (existsSync(HUB_PID_FILE)) {
    const pid = Number(readFileSync(HUB_PID_FILE, "utf8").trim());
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
    rmSync(HUB_PID_FILE, { force: true });
  }
  // Always clear the registry so the next run re-probes a live hub.
  rmSync(DEFAULT_REGISTRY_FILE, { force: true });
}
