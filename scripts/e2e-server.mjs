import { spawn, exec, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

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

function isPortInUse(port) {
  return new Promise((resolveProbe) => {
    const server = net.createServer();
    server.once("error", () => resolveProbe(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveProbe(false));
    });
  });
}

function listenerPids(port) {
  return new Promise((resolvePids) => {
    exec(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, (err, stdout) => {
      if (err) return resolvePids([]);
      resolvePids(stdout.trim().split("\n").filter(Boolean));
    });
  });
}

function commandOf(pid) {
  return new Promise((resolveCmd) => {
    exec(`ps -o command= -p ${pid}`, (err, stdout) => resolveCmd(err ? "" : stdout.trim()));
  });
}

/** Kills any stale Justus worklet squatting on the port, so a fresh e2e run
 * never collides with a leftover dev process. */
async function ensurePortFree() {
  if (!(await isPortInUse(PORT))) return;
  const stale = [];
  for (const pid of await listenerPids(PORT)) {
    const cmd = await commandOf(pid);
    if (/main\.core\.gen\.js|bare-runtime/.test(cmd)) stale.push(Number(pid));
  }
  for (const pid of stale) {
    log(`killing stale worklet pid ${pid} on port ${PORT}`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (stale.length > 0) await new Promise((r) => setTimeout(r, 600));
  if (await isPortInUse(PORT)) {
    log(`ERROR: port ${PORT} is held by a non-Justus process. Free it first.`);
    process.exit(1);
  }
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

  await ensurePortFree();

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
