import { context } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workletBuildOptions } from "./build.mjs";

const require = createRequire(import.meta.url);
const bareExecutable = require("bare-runtime")();

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const devDir = join(root, ".dev");
const storageDir = join(devDir, "storage");
const cacheDir = join(devDir, "cache");
const inboxDir = join(devDir, "inbox");

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
