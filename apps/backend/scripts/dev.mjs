import { context } from "esbuild";
import { spawn, exec } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { workletBuildOptions } from "./build.mjs";

const require = createRequire(import.meta.url);
const bareExecutable = require("bare-runtime")();

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const devDir = join(root, ".dev");
const storageDir = join(devDir, "storage");
const cacheDir = join(devDir, "cache");
const inboxDir = join(devDir, "inbox");

const WORKLET_PORT = 8080;

mkdirSync(storageDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
mkdirSync(inboxDir, { recursive: true });

const outFile = join(devDir, "main.core.gen.js");

let bareProcess = null;
let restartTimer = null;
let shuttingDown = false;
let restartChain = Promise.resolve();
let lastRestartAt = 0;

function log(message) {
  console.log(`[justus:backend] ${message}`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** True if something is listening on 127.0.0.1:port. */
function isPortInUse(port) {
  return new Promise((resolveProbe) => {
    const server = net.createServer();
    server.once("error", () => resolveProbe(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveProbe(false));
    });
  });
}

/** PIDs of processes listening on `port` (via lsof; [] when unavailable). */
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

/**
 * Makes sure the worklet's port is free before spawning. A stale Justus
 * worklet (left over from an aborted run) is killed with a warning; anything
 * else on the port fails the dev loop loudly instead of silently failing the
 * WebSocket connection the web layer expects.
 */
async function ensurePortFree() {
  if (!(await isPortInUse(WORKLET_PORT))) return;
  const stale = [];
  for (const pid of await listenerPids(WORKLET_PORT)) {
    const cmd = await commandOf(pid);
    if (/main\.core\.gen\.js|bare-runtime/.test(cmd)) stale.push(Number(pid));
  }
  if (stale.length > 0) {
    log(
      `Port ${WORKLET_PORT} is held by a stale Justus worklet (pid ${stale.join(", ")}) — killing it.`,
    );
    for (const pid of stale) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await sleep(600);
    if (!(await isPortInUse(WORKLET_PORT))) return;
    log(`ERROR: port ${WORKLET_PORT} is still in use after killing the stale worklet.`);
    process.exit(1);
  }
  log(
    `ERROR: port ${WORKLET_PORT} is already in use by another process. The web layer connects to ws://localhost:${WORKLET_PORT} — free the port first.`,
  );
  log(`Run: lsof -nP -iTCP:${WORKLET_PORT} -sTCP:LISTEN`);
  process.exit(1);
}

function stopBare() {
  return new Promise((resolveStop) => {
    if (!bareProcess) return resolveStop();
    const processToStop = bareProcess;
    bareProcess = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveStop();
    };
    processToStop.once("exit", () => finish());
    processToStop.kill("SIGTERM");
    setTimeout(() => {
      if (finished) return;
      processToStop.kill("SIGKILL");
      setTimeout(() => finish(), 500);
    }, 1200);
  });
}

async function startBare() {
  await stopBare();
  if (shuttingDown) return;
  bareProcess = spawn(bareExecutable, [outFile, storageDir, cacheDir, inboxDir], {
    stdio: "inherit",
  });
  log(`Started Bare worklet (pid=${bareProcess.pid ?? "unknown"}).`);
  bareProcess.on("exit", (code, signal) => {
    if (bareProcess && code !== 0 && !shuttingDown) {
      log(`Bare exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
    }
  });
}

function scheduleRestart() {
  const now = Date.now();
  if (now - lastRestartAt < 1000) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    lastRestartAt = Date.now();
    restartChain = restartChain.then(() => startBare());
  }, 50);
}

async function main() {
  rmSync(outFile, { force: true });
  await ensurePortFree();
  const buildContext = await context({
    ...workletBuildOptions(undefined, outFile),
    plugins: [
      {
        name: "restart-bare-on-build",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length === 0) scheduleRestart();
            else log("Build failed; skipping Bare restart.");
          });
        },
      },
    ],
  });
  await buildContext.watch();
  log(`Watching and restarting Bare on rebuild (storage=${storageDir}).`);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    if (restartTimer) clearTimeout(restartTimer);
    await stopBare();
    await buildContext.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch(async (error) => {
  console.error("[justus:backend] Fatal error:", error);
  await stopBare();
  process.exit(1);
});
