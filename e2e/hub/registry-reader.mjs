/**
 * Playwright-free reader for the justus multi-instance e2e hub registry
 * (issue #18 — "each browser tab is its own bare instance").
 *
 * `scripts/e2e-hub.mjs` (live mode) writes `.dev-e2e-hub/registry.json` after
 * it boots the DHT + N worklets. Both the Playwright `globalSetup` (to confirm
 * the hub is up) and the test fixtures (to map each tab → its own instance URL)
 * read that file through this module.
 *
 * Kept free of any Playwright import so the resolution logic is unit-testable
 * under plain vitest (see registry-reader.test.mjs) — no browsers, no DHT, no
 * peers required to exercise it.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// e2e/hub -> repo root
export const REPO_ROOT = resolve(here, "..", "..");

/** Default registry location, matching `scripts/e2e-hub.mjs` DEFAULTS. */
export const DEFAULT_REGISTRY_FILE = resolve(REPO_ROOT, ".dev-e2e-hub", "registry.json");
/** Where `globalSetup` records the spawned hub parent pid for `globalTeardown`. */
export const HUB_PID_FILE = resolve(REPO_ROOT, ".dev-e2e-hub", "hub.pid");

/** Resolve the registry path: explicit env override, else the default. */
export function registryPath() {
  return process.env.JUSTUS_HUB_REGISTRY || DEFAULT_REGISTRY_FILE;
}

/**
 * Load and validate the hub registry.
 * @param {string} [path]
 * @returns {{ dht: { port:number, bootstrap:string }, instances: Array<{id:string,port:number,url:string,storageDir:string}> }}
 * @throws if the file is missing, unreadable, invalid JSON, or malformed.
 */
export function loadRegistry(path = registryPath()) {
  if (!existsSync(path)) {
    throw new Error(
      `justus e2e hub registry not found at ${path}. Did the hub boot? ` +
        `Run \`node scripts/e2e-hub.mjs\` (or \`npm run test:e2e-p2p\`).`,
    );
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`justus e2e hub registry unreadable at ${path}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`justus e2e hub registry at ${path} is not valid JSON: ${e.message}`);
  }
  validateRegistry(data, path);
  return data;
}

function validateRegistry(data, path) {
  if (typeof data !== "object" || data === null) {
    throw new TypeError(`registry ${path} must be a JSON object`);
  }
  if (!data.dht || typeof data.dht.bootstrap !== "string" || typeof data.dht.port !== "number") {
    throw new TypeError(`registry ${path} missing dht.bootstrap (string) / dht.port (number)`);
  }
  if (!Array.isArray(data.instances) || data.instances.length === 0) {
    throw new TypeError(`registry ${path} must have a non-empty instances array`);
  }
  for (const inst of data.instances) {
    if (
      typeof inst.id !== "string" ||
      typeof inst.url !== "string" ||
      typeof inst.port !== "number" ||
      typeof inst.storageDir !== "string"
    ) {
      throw new TypeError(`registry ${path} instance missing id/url/port/storageDir`);
    }
  }
}

/**
 * Resolve an instance by 0-based index.
 * @param {{ instances: Array<*> }} registry
 * @param {number} index
 */
export function resolveInstance(registry, index) {
  if (!Number.isInteger(index) || index < 0 || index >= registry.instances.length) {
    throw new RangeError(
      `instance index ${index} out of range (have ${registry.instances.length} instances)`,
    );
  }
  return registry.instances[index];
}

/** Resolve an instance by its stable id (e.g. `tab-1`). */
export function resolveInstanceById(registry, id) {
  const inst = registry.instances.find((i) => i.id === id);
  if (!inst) {
    throw new Error(`no instance with id ${id} in registry`);
  }
  return inst;
}

/**
 * Poll until the registry file exists AND parses/validates (so a half-written
 * file never fools the caller). Used by `globalSetup` to confirm the hub booted.
 * @param {string} [path]
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
export async function waitForRegistry(path = registryPath(), timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return loadRegistry(path);
      } catch (e) {
        // Present but not yet valid (mid-write) — keep waiting.
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `justus e2e hub registry did not become ready at ${path} within ${timeoutMs}ms: ` +
      `${lastErr?.message ?? "file never appeared"}`,
  );
}
