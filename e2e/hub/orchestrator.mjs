/**
 * Pure orchestrator planning for the justus multi-instance e2e hub
 * (issue #18 — "each browser tab is its own bare instance").
 *
 * Consumes `planHub` (boot order + cleanup plan from plan.mjs) and turns it
 * into concrete spawn specs the CLI (`scripts/e2e-hub.mjs`) executes: one DHT
 * process plus N worklet instances, each with its own bundle args (storage /
 * cache / inbox / port / bootstrap). It resolves repo-relative paths and
 * shapes the spawn arguments but performs NO process or network work — so it
 * is unit-testable without a DHT, browsers, or peers (see orchestrator.test.mjs).
 *
 * The CLI is responsible for the live work: probing ports, spawning the DHT +
 * worklets from these specs, waiting for readiness, writing the registry file,
 * and applying `cleanup` on SIGTERM/SIGINT. None of that lives here.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { planHub, buildCleanupPlan } from "./plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// e2e/hub -> repo root
export const REPO_ROOT = resolve(here, "..", "..");

export const DEFAULTS = {
  count: 2,
  basePort: 9000,
  dhtPort: 49737,
  storageRoot: resolve(REPO_ROOT, ".dev-e2e-hub"),
  registryFile: resolve(REPO_ROOT, ".dev-e2e-hub", "registry.json"),
};

/** Parse CLI argv into normalized options (with validation). */
export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--plan":
      case "--dry-run":
        opts.plan = true;
        break;
      case "--count":
        opts.count = Number(argv[++i]);
        break;
      case "--base-port":
        opts.basePort = Number(argv[++i]);
        break;
      case "--dht-port":
        opts.dhtPort = Number(argv[++i]);
        break;
      case "--storage-root":
        opts.storageRoot = argv[++i];
        break;
      case "--registry-file":
        opts.registryFile = argv[++i];
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(opts.count) || opts.count < 1) {
    throw new RangeError(`--count must be a positive integer, got ${opts.count}`);
  }
  if (!Number.isInteger(opts.basePort) || opts.basePort < 1 || opts.basePort > 65535) {
    throw new RangeError(`--base-port must be a TCP port (1-65535), got ${opts.basePort}`);
  }
  if (!Number.isInteger(opts.dhtPort) || opts.dhtPort < 1 || opts.dhtPort > 65535) {
    throw new RangeError(`--dht-port must be a TCP port (1-65535), got ${opts.dhtPort}`);
  }
  return opts;
}

/**
 * Build the full orchestrator plan: the registry, the boot order, the concrete
 * spawn specs for the DHT + each worklet, and the SIGTERM cleanup plan.
 *
 * @param {object} [opts]
 * @returns {{
 *   registry: object,
 *   boot: Array<object>,
 *   plan: { dht: object, worklets: Array<object> },
 *   cleanup: { order: string[], ports: number[], storageDirs: string[] },
 *   registryFile: string,
 * }}
 */
export function buildOrchestratorPlan(opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  const { registry, boot } = planHub({
    basePort: o.basePort,
    count: o.count,
    storageRoot: o.storageRoot,
    dht: { port: o.dhtPort },
  });

  const localDht = resolve(REPO_ROOT, "apps/backend/scripts/local-dht.mjs");
  const workletBundle = resolve(REPO_ROOT, "apps/backend/dist/main.core.gen.js");
  const webDist = resolve(REPO_ROOT, "apps/web/dist");
  const bootstrap = registry.dht.bootstrap;

  const dht = {
    id: "dht",
    type: "dht",
    runtime: "node",
    command: "node",
    args: [localDht, String(o.dhtPort)],
    port: o.dhtPort,
    bootstrap,
  };

  const worklets = registry.instances.map((inst) => ({
    id: inst.id,
    type: "worklet",
    runtime: "bare",
    bundle: workletBundle,
    port: inst.port,
    url: inst.url,
    storageDir: inst.storageDir,
    bootstrap,
    // Mirrors apps/backend/scripts/e2e-server.mjs: the Bare worklet takes
    // key=value args (config.ts reads `webassets=`/`storage=`/`cache=`/
    // `inbox=`/`port=`/`bootstrap=`). Each instance gets its own storage so
    // every browser tab is backed by a distinct bare instance.
    args: [
      workletBundle,
      `webassets=${webDist}`,
      `storage=${inst.storageDir}`,
      `cache=${resolve(inst.storageDir, "cache")}`,
      `inbox=${resolve(inst.storageDir, "inbox")}`,
      `port=${inst.port}`,
      `bootstrap=${bootstrap}`,
    ],
  }));

  return {
    registry,
    boot,
    plan: { dht, worklets },
    cleanup: buildCleanupPlan({ boot }),
    registryFile: o.registryFile,
  };
}
