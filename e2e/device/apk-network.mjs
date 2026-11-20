import { spawn } from "node:child_process";

const TRACE = "/data/local/tmp/justus-net.trace";

function adbText({ adb, serial, args, trim = true }) {
  return new Promise((resolve) => {
    const child = spawn(adb, ["-s", serial, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("close", () => resolve(trim ? text.trim() : text));
    child.on("error", () => resolve(""));
  });
}

/**
 * Records every network call Ben's app process makes on the emulator: strace, run as adb root, attached the moment
 * the process starts. Start it before the app opens. Never throws; a failure comes back in `error`.
 * @param {{ adb: string, serial: string, app: string }} opts
 * @returns {{ stop(): Promise<{ trace: string, pid: number, error: string }> }}
 */
export function recordApkNetwork({ adb, serial, app }) {
  // strace ends when the app process dies (Android may restart it mid-walk). Attach again to the next pid, one
  // trace file per process, so an early death is not a failed recording. TERM (not INT): background jobs ignore INT.
  const script = [
    `trap '' HUP`,
    `rm -f ${TRACE} ${TRACE}.*`,
    `n=0; first=1; st=; stopped=`,
    `trap 'stopped=1; [ -n "$st" ] && kill -TERM $st' INT`,
    `while [ -z "$stopped" ]; do until pid=$(pidof -s ${app}) || [ -n "$stopped" ]; do sleep 0.05; done`,
    `[ -n "$stopped" ] && break`,
    `if [ -n "$first" ]; then echo "recorder $$ $pid"; first=; fi`,
    `strace -f -qq -ttt -yy -v -xx -s 64 -e trace=bind,connect,sendto,sendmsg,sendmmsg -e signal=none -o ${TRACE}.$n -p $pid & st=$!`,
    `wait $st; code=$?; wait $st; st=`,
    `if [ $code = 127 ]; then exit 127; fi`,
    `n=$((n+1)); sleep 0.2; done; wait`,
  ].join("; ");
  const child = spawn(adb, ["-s", serial, "shell", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = [];
  let closed = false;
  let exitCode = null;
  const closing = new Promise((resolve) => {
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      resolve();
    });
    child.on("error", (error) => {
      stderr.push(String(error));
      closed = true;
      resolve();
    });
  });
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => {
    stderr = [...stderr, ...String(chunk).split("\n").filter(Boolean)].slice(-20);
  });

  async function finish() {
    const found = /recorder (\d+) (\d+)/.exec(stdout);
    // adb losing the emulator for a moment closes the shell with another code; the script ignores HUP and keeps
    // recording on the device, so only a missing strace (127) or a shell that never reported a pid is an early stop.
    if (closed && (exitCode === 127 || !found)) {
      return {
        trace: "",
        pid: 0,
        error: `the recorder stopped early: ${stderr.at(-1) ?? stdout.trim()}`,
      };
    }
    if (!found) {
      child.kill("SIGKILL");
      return { trace: "", pid: 0, error: "Ben's app never started while recording" };
    }
    const [, tracer, appPid] = found;
    await adbText({ adb, serial, args: ["shell", `kill -INT ${tracer}`] });
    const timer = setTimeout(async () => {
      await adbText({ adb, serial, args: ["shell", `kill -KILL ${tracer}`] });
      child.kill("SIGKILL");
    }, 10_000);
    await closing;
    clearTimeout(timer);
    for (let i = 0; i < 50; i++) {
      const up = await adbText({
        adb,
        serial,
        args: ["shell", `kill -0 ${tracer} 2>/dev/null && echo up`],
      });
      if (up !== "up") break;
      if (i === 49) await adbText({ adb, serial, args: ["shell", `kill -KILL ${tracer}`] });
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const trace = await adbText({
      adb,
      serial,
      trim: false,
      args: ["exec-out", "sh", "-c", `cat ${TRACE}.*`],
    });
    return { trace, pid: Number(appPid), error: "" };
  }

  let result;
  return { stop: () => (result ??= finish()) };
}

/**
 * Counts only, no addresses: the walk's summary is public and DHT nodes can be other people's devices.
 * @param {string} trace
 */
export function traceFacts(trace) {
  const lines = trace.split("\n").filter(Boolean);
  function count(pattern) {
    return lines.filter((line) => pattern.test(line)).length;
  }
  return {
    lines: lines.length,
    binds: count(/\bbind\(/),
    streamPackets: count(/iov_base="\\xff\\x01|, "\\xff\\x01/),
    dhtMessages: count(/iov_base="\\x(03|13)|, "\\x(03|13)/),
  };
}
