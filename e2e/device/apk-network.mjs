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
  const script = [
    `rm -f ${TRACE}`,
    `until pid=$(pidof -s ${app}); do sleep 0.05; done`,
    `echo "recorder $$ $pid"`,
    `exec strace -f -qq -ttt -yy -v -xx -s 64 -e trace=bind,connect,sendto,sendmsg,sendmmsg -e signal=none -o ${TRACE} -p $pid`,
  ].join("; ");
  const child = spawn(adb, ["-s", serial, "shell", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = [];
  let closed = false;
  const closing = new Promise((resolve) => {
    child.on("close", () => {
      closed = true;
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
    if (closed) {
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
    const trace = await adbText({ adb, serial, trim: false, args: ["exec-out", "cat", TRACE] });
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
