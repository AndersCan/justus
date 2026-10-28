import { context } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workletBuildOptions } from "./build.mjs";
import { ensurePortFree } from "./port-utils.mjs";

const require = createRequire(import.meta.url);
const bareExecutable = require("bare-runtime")();

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const devDir = join(root, ".dev");
const storageDir = join(devDir, "storage");
const cacheDir = join(devDir, "cache");
const inboxDir = join(devDir, "inbox");

const BASE_PORT = 8080;
const DHT_PORT = 49737;
// `JUSTUS_PEERS=2 pnpm run dev` boots N independent worklets (ports 8080+i,
// storage .dev/peer-i) joined to one local DHT, so two browser tabs
// (`?peer=0`, `?peer=1`) behave as two separate users. Peer 0 keeps the
// original single-peer paths.
const PEERS = Math.max(1, Number(process.env.JUSTUS_PEERS) || 1);

const peers = Array.from({ length: PEERS }, (_, i) => {
  const base = i === 0 ? devDir : join(devDir, `peer-${i}`);
  return {
    index: i,
    port: BASE_PORT + i,
    storage: i === 0 ? storageDir : join(base, "storage"),
    cache: i === 0 ? cacheDir : join(base, "cache"),
    inbox: i === 0 ? inboxDir : join(base, "inbox"),
  };
});
for (const peer of peers) {
  for (const dir of [peer.storage, peer.cache, peer.inbox]) mkdirSync(dir, { recursive: true });
}

const outFile = join(devDir, "main.core.gen.js");
/** `mode=dev` selects ekrooh's dev backend (auth off); without it the worklet
 * keeps the device defaults. The dev backend still refuses page origins it was
 * not told about, so allow the Vite dev server (pinned in apps/web). */
const DEV_ARGS = ["mode=dev", "origin=http://localhost:5173", "origin=http://127.0.0.1:5173"];

let bareProcesses = [];
let dhtProcess = null;
let restartTimer = null;
let shuttingDown = false;
let restartChain = Promise.resolve();

function log(message) {
  console.log(`[justus:backend] ${message}`);
}

function stopProcess(child) {
  return new Promise((resolveStop) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveStop();
    };
    child.once("exit", () => finish());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (finished) return;
      child.kill("SIGKILL");
      setTimeout(() => finish(), 500);
    }, 1200);
  });
}

async function stopBare() {
  const running = bareProcesses;
  bareProcesses = [];
  await Promise.all(running.map(stopProcess));
}

function startDht() {
  if (PEERS < 2 || dhtProcess) return;
  dhtProcess = spawn(process.execPath, [join(root, "scripts", "local-dht.mjs"), String(DHT_PORT)], {
    stdio: "inherit",
  });
  log(`Started local DHT on 127.0.0.1:${DHT_PORT} for ${PEERS} peers.`);
}

async function startBare() {
  await stopBare();
  if (shuttingDown) return;
  startDht();
  for (const peer of peers) {
    const args = [
      outFile,
      ...DEV_ARGS,
      `storage=${peer.storage}`,
      `cache=${peer.cache}`,
      `inbox=${peer.inbox}`,
      `port=${peer.port}`,
    ];
    if (PEERS > 1) args.push(`bootstrap=127.0.0.1:${DHT_PORT}`);
    const child = spawn(bareExecutable, args, { stdio: "inherit" });
    bareProcesses.push(child);
    log(
      `Started Bare worklet peer ${peer.index} on :${peer.port} (pid=${child.pid ?? "unknown"}).`,
    );
    child.on("error", (error) => {
      if (shuttingDown) return;
      log(`Failed to spawn Bare peer ${peer.index}: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (bareProcesses.includes(child) && code !== 0 && !shuttingDown) {
        log(
          `Bare peer ${peer.index} exited unexpectedly (code=${code}, signal=${signal ?? "none"})`,
        );
      }
    });
  }
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartChain = restartChain
      .then(() => startBare())
      .catch((error) => {
        log(`Bare restart failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, 50);
}

async function main() {
  rmSync(outFile, { force: true });
  for (const peer of peers) {
    await ensurePortFree({
      port: peer.port,
      bundlePattern: /\/apps\/backend\/\.dev\/main\.core\.gen\.js/,
      log,
    });
  }
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
  log(`Watching and restarting Bare on rebuild (peers=${PEERS}, storage=${storageDir}).`);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    if (restartTimer) clearTimeout(restartTimer);
    await stopBare();
    if (dhtProcess) await stopProcess(dhtProcess);
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
