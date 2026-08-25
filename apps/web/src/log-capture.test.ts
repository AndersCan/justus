import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  FLUSH_INTERVAL_MS,
  installWebLogCapture,
  MAX_BATCH_ENTRIES,
  startWebLogCapture,
  type ConsoleLike,
  type LogCaptureHandle,
  type WebLogEntry,
} from "./log-capture";

/** A plain recording fake console (no vi.fn — this vitest build types
 * `Mock` as not directly callable, and a real object keeps the test DOM-free
 * and fully type-checked against `ConsoleLike`). */
function makeConsole() {
  const calls: Record<keyof ConsoleLike, unknown[][]> = {
    log: [],
    info: [],
    warn: [],
    error: [],
    debug: [],
  };
  const c: ConsoleLike = {
    log: (...a: unknown[]) => void calls.log.push(a),
    info: (...a: unknown[]) => void calls.info.push(a),
    warn: (...a: unknown[]) => void calls.warn.push(a),
    error: (...a: unknown[]) => void calls.error.push(a),
    debug: (...a: unknown[]) => void calls.debug.push(a),
  };
  return { c, calls };
}

function makeFetch(impl: (body: WebLogEntry[]) => boolean) {
  return async (_path: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as WebLogEntry[]) : [];
    const ok = impl(body);
    return { ok, status: ok ? 200 : 500, json: async () => ({ ok }) } as Response;
  };
}

function makeWindow() {
  const listeners: Record<string, ((e: unknown) => void) | undefined> = {};
  return {
    listeners,
    win: {
      addEventListener(type: "error" | "unhandledrejection", cb: (e: unknown) => void) {
        listeners[type] = cb;
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("installWebLogCapture", () => {
  test("captures console calls as web-sourced entries and forwards them", () => {
    const { c, calls } = makeConsole();
    const handle = installWebLogCapture({ console: c });
    c.warn("disk low", 3);
    c.error("boom");
    expect(handle.pendingCount()).toBe(2);
    // The genuine console still received the calls.
    expect(calls.warn).toContainEqual(["disk low", 3]);
    expect(calls.error).toContainEqual(["boom"]);
    handle.stop();
  });

  test("page error + unhandledrejection surface as error-level entries", () => {
    const { c } = makeConsole();
    const { win, listeners } = makeWindow();
    const handle = installWebLogCapture({ console: c, win: win as never });
    listeners["error"]?.({
      message: "script died",
      error: new Error("x"),
      filename: "a.ts",
      lineno: 12,
    });
    listeners["unhandledrejection"]?.({ reason: new Error("promise rejected") });
    expect(handle.pendingCount()).toBe(2);
    handle.stop();
  });

  test("flush posts a bounded batch and clears the buffer", async () => {
    const { c } = makeConsole();
    const posted: WebLogEntry[][] = [];
    const fetchImpl = makeFetch((body) => {
      posted.push(body);
      return true;
    });
    const handle = installWebLogCapture({ console: c, fetchImpl: fetchImpl as never });
    for (let i = 0; i < 10; i++) c.info(`line ${i}`);
    await handle.flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(10);
    expect(posted[0][0].level).toBe("info");
    expect(posted[0][0].source).toBe("web");
    expect(handle.pendingCount()).toBe(0);
    handle.stop();
  });

  test("caps a single flush at MAX_BATCH_ENTRIES and emits follow-ups next flush", async () => {
    const { c } = makeConsole();
    const batches: WebLogEntry[][] = [];
    const fetchImpl = makeFetch((body) => {
      batches.push(body);
      return true;
    });
    const handle = installWebLogCapture({ console: c, fetchImpl: fetchImpl as never });
    // 70 entries -> first auto-flush at 64, remaining 6 on explicit flush.
    for (let i = 0; i < 70; i++) c.log(`m${i}`);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(MAX_BATCH_ENTRIES);
    await handle.flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(6);
    handle.stop();
  });

  test("never re-captures its own forwarded output (no recursion)", () => {
    const { c } = makeConsole();
    const fetchImpl = makeFetch(() => true);
    const handle = installWebLogCapture({ console: c, fetchImpl: fetchImpl as never });
    c.log("user message");
    // One user call => one buffered entry, regardless of the forward to real.
    expect(handle.pendingCount()).toBe(1);
    handle.stop();
  });

  test("retries once then drops on repeated failure (bounded queue)", async () => {
    const { c } = makeConsole();
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      return false; // always fail
    });
    const handle = installWebLogCapture({ console: c, fetchImpl: fetchImpl as never });
    for (let i = 0; i < 5; i++) c.warn(`w${i}`);
    await handle.flush();
    // 1 initial attempt + 1 retry = 2 calls, then drop.
    expect(calls).toBe(2);
    expect(handle.pendingCount()).toBe(0);
    handle.stop();
  });

  test("does not throw when no fetch implementation exists (mock-like)", async () => {
    const { c } = makeConsole();
    const handle = installWebLogCapture({ console: c, fetchImpl: undefined });
    c.log("orphan");
    await expect(handle.flush()).resolves.toBeUndefined();
    expect(handle.pendingCount()).toBe(0);
    handle.stop();
  });

  test("installs a timer when a scheduler is provided", () => {
    const { c } = makeConsole();
    const intervals: Array<() => void> = [];
    const scheduler = {
      setInterval(cb: () => void) {
        intervals.push(cb);
        return intervals.length;
      },
      clearInterval() {},
    };
    const handle = installWebLogCapture({
      console: c,
      scheduler: scheduler as never,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    });
    expect(intervals).toHaveLength(1);
    handle.stop();
  });
});

describe("startWebLogCapture", () => {
  test("returns null on the mock transport and never posts", () => {
    vi.stubEnv("VITE_TRANSPORT_MODE", "mock");
    expect(startWebLogCapture()).toBeNull();
  });

  test("installs on a real transport", () => {
    vi.stubEnv("VITE_TRANSPORT_MODE", "real");
    const handle: LogCaptureHandle | null = startWebLogCapture();
    expect(handle).not.toBeNull();
    handle?.stop();
  });
});
