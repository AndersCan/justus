#!/usr/bin/env node
/**
 * Multi-instance e2e hub orchestrator for justus (issue #18 — "each browser tab
 * is its own bare instance").
 *
 * Boots one local DHT bootstrap node plus N Bare worklet instances, each with
 * its own port + storage dir, all pointed at the DHT. Prints the registry JSON
 * (also written to `.dev-e2e-hub/registry.json`) for Playwright globalSetup to
 * map each worker → its own instance.
 *
 * Two modes:
 *   --plan   Print the plan (registry + spawn specs + cleanup) as JSON and exit.
 *            Pure: no ports opened, no processes spawned. Use it to inspect / CI.
 *   (default) Live mode — spawns the DHT + worklets. Requires the bare build,
 *            node, and (for the actual e2e run) Playwright browsers + peers.
 *
 * Usage:
 *   node scripts/e2e-hub.mjs --plan --count 3
 *   node scripts/e2e-hub.mjs --count 3        # then run `playwright test`
 *
 * SIGTERM/SIGINT tears every child down in reverse-boot order (instances first,
 * then the DHT) so no orphaned process survives.
 */

import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOrchestratorPlan, parseArgs, REPO_ROOT } from "../e2e/hub/orchestrator.mjs";
import { isPortInUse, portHeldBy, ensurePortFree } from "../apps/backend/scripts/port-utils.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const WORKLET_BUNDLE_PATTERN = /\/apps\/backend\/dist\/main\.core\.gen\.js/;
const DHT_SCRIPT_PATTERN = /\/apps\/backend\/scripts\/local-dht\.mjs/;

function log(message) {
  console.log(`[justus:e2e-hub] ${message}`);
}

function printHelp() {
  console.log(`justus e2e hub orchestrator

Boots a local DHT + N bare worklet instances (issue #18).

Options:
  --plan                 Print the plan as JSON and exit (no processes).
  --count <n>            Number of worklet instances (default 2).
  --base-port <p>        First instance port (default 9000).
  --dht-port <p>         DHT bootstrap port (default 49737).
  --storage-root <dir>   Parent dir for per-instance storage.
  --registry-file <f>    Where to write the registry JSON.
  -h, --help             Show this help.
`);
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function buildStack() {
  log("building web app + backend worklet...");
  execSync("pnpm --filter @justus/web run build", { cwd: repoRoot, stdio: "inherit" });
  execSync("pnpm --filter @justus/backend run build", { cwd: repoRoot, stdio: "inherit" });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const plan = buildOrchestratorPlan(opts);

  if (opts.plan) {
    process.stdout.write(
      JSON.stringify(
        { registry: plan.registry, boot: plan.boot, spawn: plan.plan, cleanup: plan.cleanup },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  // ---- live mode ----
  const bareExecutable = require("bare-runtime")();

  // Fresh storage each run; clean the registry file location.
  rmSync(opts.storageRoot, { recursive: true, force: true });
  mkdirSync(opts.storageRoot, { recursive: true });

  // Only THIS script's own stale worklets / DHT get killed — a foreign process
  // holding a port fails loudly instead of being silently murdered.
  await ensurePortFree({ port: opts.dhtPort, bundlePattern: DHT_SCRIPT_PATTERN, log });
  for (const w of plan.plan.worklets) {
    await ensurePortFree({ port: w.port, bundlePattern: WORKLET_BUNDLE_PATTERN, log });
    mkdirSync(resolve(w.storageDir, "cache"), { recursive: true });
    mkdirSync(resolve(w.storageDir, "inbox"), { recursive: true });
  }

  buildStack();

  // Spawn the DHT first.
  const children = new Map();
  const dht = spawn(plan.plan.dht.command, plan.plan.dht.args, { stdio: "inherit" });
  children.set("dht", dht);
  log(`launched DHT (pid=${dht.pid ?? "unknown"}) on ${plan.plan.dht.bootstrap}`);
  if (!(await waitForPort(opts.dhtPort, 15_000))) {
    log(`ERROR: DHT did not bind port ${opts.dhtPort} within 15s.`);
    await shutdown(children, plan);
    process.exit(1);
  }

  // Spawn each worklet, waiting for its port and confirming it is ours.
  for (const w of plan.plan.worklets) {
    const child = spawn(bareExecutable, w.args, { stdio: "inherit" });
    children.set(w.id, child);
    log(`launched ${w.id} (pid=${child.pid ?? "unknown"}) on ${w.url}`);
    if (!(await waitForPort(w.port, 30_000))) {
      log(`ERROR: ${w.id} did not bind port ${w.port} within 30s.`);
      await shutdown(children, plan);
      process.exit(1);
    }
    if (!(await portHeldBy(w.port, WORKLET_BUNDLE_PATTERN))) {
      log(`ERROR: port ${w.port} is bound by a foreign process — aborting.`);
      await shutdown(children, plan);
      process.exit(1);
    }
  }

  // Hand the registry to Playwright globalSetup.
  mkdirSync(resolve(plan.registryFile, ".."), { recursive: true });
  writeFileSync(plan.registryFile, JSON.stringify(plan.registry, null, 2));
  log(`hub up. registry -> ${plan.registryFile}`);
  process.stdout.write(JSON.stringify(plan.registry) + "\n");

  const shutdownHandler = () => void shutdown(children, plan);
  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  // Hold the process (children are spawned; parent must not exit).
  process.stdin.resume();
}

async function shutdown(children, plan) {
  log("shutting down...");
  // cleanup.order is reverse-boot: instances first, then the DHT.
  for (const id of plan.cleanup.order) {
    const child = children.get(id);
    if (!child) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    // Hard-kill after a grace period.
    const pid = child.pid;
    setTimeout(() => {
      try {
        if (pid != null) process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 1200);
  }
  // Give SIGTERM a moment, then exit.
  setTimeout(() => process.exit(0), 1500);
}

void main().catch((error) => {
  console.error("[justus:e2e-hub] Fatal error:", error);
  process.exit(1);
});
