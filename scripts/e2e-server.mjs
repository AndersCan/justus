import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePortFree, isPortInUse, portHeldBy } from "../apps/backend/scripts/port-utils.mjs";

/**
 * Boots the REAL Justus stack for Playwright, exactly like on-device:
 * the Bare worklet serves the built web app from its loopback server
 * (same-origin, auth off in dev) and answers the protocol on the same origin.
 * Fresh storage each run → the gallery seeds 3 real photos.
 *
 * Usage: node scripts/e2e-server.mjs   (keeps running; SIGTERM cleans up)
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(root, "apps/backend/package.json"));
const bareExecutable = require("bare-runtime")();
const e2eDir = join(root, ".dev-e2e");
const storageDir = join(e2eDir, "storage");
const cacheDir = join(e2eDir, "cache");
const inboxDir = join(e2eDir, "inbox");
const webDist = join(root, "apps/web/dist");
const workletBundle = join(root, "apps/backend/dist/main.core.gen.js");
const PORT = 8080;

function log(message) {
  console.log(`[justus:e2e] ${message}`);
}

function build(what, command, cwd) {
  log(`building ${what}...`);
  execSync(command, { cwd, stdio: "inherit" });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  rmSync(e2eDir, { recursive: true, force: true });
  mkdirSync(e2eDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });

  await ensurePortFree({
    port: PORT,
    bundlePattern: /\/apps\/backend\/dist\/main\.core\.gen\.js/,
    log,
  });

  build("web app", "pnpm --filter @justus/web run build", root);
  build("backend worklet", "pnpm --filter @justus/backend run build", root);

  const bare = spawn(
    bareExecutable,
    [
      workletBundle,
      `webassets=${webDist}`,
      `storage=${storageDir}`,
      `cache=${cacheDir}`,
      `inbox=${inboxDir}`,
      `port=${PORT}`,
    ],
    { stdio: "inherit" },
  );
  bare.on("exit", (code) => {
    log(`worklet exited (code=${code}); shutting down.`);
    process.exit(code ?? 0);
  });

  if (!(await waitForPort(PORT, 30_000))) {
    log(`ERROR: worklet did not bind port ${PORT} within 30s.`);
    try {
      bare.kill("SIGKILL");
    } catch {
      // already gone
    }
    process.exit(1);
  }
  // The port could have been grabbed by a foreign process while we were
  // building/spawning — refuse to run against anything but our own worklet.
  if (!(await portHeldBy(PORT, /\/apps\/backend\/dist\/main\.core\.gen\.js/))) {
    log(`ERROR: port ${PORT} is bound by a foreign process — aborting.`);
    try {
      bare.kill("SIGKILL");
    } catch {
      // already gone
    }
    process.exit(1);
  }
  log(`worklet up on http://127.0.0.1:${PORT}/index.html`);

  const shutdown = () => {
    log("shutting down...");
    bare.kill("SIGKILL");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Hold the process (bare is a child; parent must not exit).
  process.stdin.resume();
}

void main().catch((error) => {
  console.error("[justus:e2e] Fatal error:", error);
  process.exit(1);
});
