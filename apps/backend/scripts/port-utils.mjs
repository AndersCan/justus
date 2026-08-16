import { exec } from "node:child_process";
import net from "node:net";

/** True if something is listening on 127.0.0.1:port. */
export function isPortInUse(port) {
  return new Promise((resolveProbe) => {
    const server = net.createServer();
    server.once("error", () => resolveProbe(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveProbe(false));
    });
  });
}

/** PIDs of processes listening on `port` (via lsof; [] when unavailable). */
export function listenerPids(port) {
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

/** True if the process listening on `port` has a command matching `pattern`. */
export async function portHeldBy(port, pattern) {
  for (const pid of await listenerPids(port)) {
    if (pattern.test(await commandOf(pid))) return true;
  }
  return false;
}

/**
 * Makes sure the worklet's port is free before spawning. Only THIS script's
 * own stale worklet (identified by its bundle path) is killed — another dev /
 * e2e loop holding the port fails loudly instead of being silently murdered.
 */
export async function ensurePortFree({ port, bundlePattern, log }) {
  if (!(await isPortInUse(port))) return;
  const stale = [];
  for (const pid of await listenerPids(port)) {
    const cmd = await commandOf(pid);
    if (bundlePattern.test(cmd)) stale.push(Number(pid));
  }
  if (stale.length > 0) {
    log(`Port ${port} is held by a stale Justus worklet (pid ${stale.join(", ")}) — killing it.`);
    for (const pid of stale) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 600));
    if (!(await isPortInUse(port))) return;
    log(`ERROR: port ${port} is still in use after killing the stale worklet.`);
    process.exit(1);
  }
  log(
    `ERROR: port ${port} is already in use by another process. The web layer connects to ws://127.0.0.1:${port} — free the port first.`,
  );
  log(`Run: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  process.exit(1);
}
