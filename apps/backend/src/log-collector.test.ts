import { describe, expect, test, vi } from "vite-plus/test";
import { createLogCollector, type ConsoleLike, type FsLike, type LogEntry } from "./log-collector";

/** In-memory fs implementing the FsLike surface, for fast persistence tests. */
function memFs(): FsLike & { files: Map<string, string>; writes: number } {
  const files = new Map<string, string>();
  let writes = 0;
  const api = {
    files,
    get writes() {
      return writes;
    },
    mkdirSync() {},
    appendFileSync(p: string, data: string | Uint8Array) {
      writes += 1;
      const s = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      files.set(p, (files.get(p) ?? "") + s);
    },
    readFileSync(p: string) {
      return files.get(p) ?? "";
    },
    readdirSync() {
      return [...files.keys()].map((k) => k.slice(k.lastIndexOf("/") + 1)).sort();
    },
    statSync(p: string) {
      return { size: (files.get(p) ?? "").length };
    },
    unlinkSync(p: string) {
      files.delete(p);
    },
  };
  return api as FsLike & { files: Map<string, string>; writes: number };
}

function memPath() {
  return { join: (...parts: string[]) => parts.join("/") };
}

describe("log-collector", () => {
  test("ring buffer caps at maxEntries and drops the oldest", () => {
    const c = createLogCollector({ maxEntries: 3, now: () => 1000 });
    c.append({ source: "backend", message: "a" });
    c.append({ source: "backend", message: "b" });
    c.append({ source: "backend", message: "c" });
    c.append({ source: "backend", message: "d" });
    const rows = c.entries();
    expect(rows.map((e) => e.message)).toEqual(["b", "c", "d"]);
    expect(rows[0].seq).toBe(2);
  });

  test("query defaults to jsonl and supports text/tail/level", () => {
    const c = createLogCollector({ now: () => 1000 });
    c.append({ level: "info", source: "backend", message: "one" });
    c.append({ level: "error", source: "backend", message: "two" });
    c.append({ level: "warn", source: "web", message: "three" });

    const jsonl = c.query();
    expect(jsonl.contentType).toBe("application/x-ndjson");
    expect(jsonl.body.split("\n")).toHaveLength(3);
    expect(JSON.parse(jsonl.body.split("\n")[1]).message).toBe("two");

    const text = c.query({ format: "text" });
    expect(text.contentType).toBe("text/plain; charset=utf-8");
    expect(text.body).toContain("ERROR (backend) two");

    const tail = c.query({ tail: 1 });
    expect(tail.body.split("\n")).toHaveLength(1);
    expect(tail.body).toContain("three");

    const onlyError = c.query({ level: "error" });
    expect(onlyError.body.split("\n")).toHaveLength(1);
    expect(onlyError.body).toContain("two");
  });

  test("ingestBatch accepts valid entries, drops invalid ones", () => {
    const c = createLogCollector({ now: () => 1000 });
    const res = c.ingestBatch([
      { source: "web", message: "hello" },
      { level: "warn", message: "careful" },
      { notMessage: true },
      "garbage",
    ]);
    expect(res.accepted).toBe(2);
    expect(res.dropped).toBe(2);
    const rows = c.entries();
    expect(rows.map((e) => e.message)).toEqual(["hello", "careful"]);
    expect(rows[1].level).toBe("warn");
  });

  test("ingestBatch rejects non-array, empty, and oversized batches", () => {
    const c = createLogCollector({ maxBatchBytes: 50, now: () => 1000 });
    expect(c.ingestBatch({ message: "x" }).error).toMatch(/array/);
    expect(c.ingestBatch([]).error).toMatch(/empty/);
    const big = c.ingestBatch([{ message: "x".repeat(60) }, { message: "y" }]);
    expect(big.error).toMatch(/size limit/);
    expect(big.dropped).toBe(2);
    expect(c.entries()).toHaveLength(0);
  });

  test("installConsoleCapture forwards to the real console and captures the line", () => {
    const calls: string[] = [];
    const mockConsole: ConsoleLike = {
      log: (...a: unknown[]) => calls.push(`log:${a.join(" ")}`),
      info: (...a: unknown[]) => calls.push(`info:${a.join(" ")}`),
      warn: (...a: unknown[]) => calls.push(`warn:${a.join(" ")}`),
      error: (...a: unknown[]) => calls.push(`error:${a.join(" ")}`),
      debug: (...a: unknown[]) => calls.push(`debug:${a.join(" ")}`),
    };
    const c = createLogCollector({ targetConsole: mockConsole, now: () => 1000 });
    expect(c.installConsoleCapture()).toBe(true);
    mockConsole.log("booted", { port: 8080 });
    mockConsole.error("oops", new Error("boom"));
    expect(calls[0]).toBe("log:booted [object Object]");
    expect(calls[1]).toBe("error:oops Error: boom");
    const rows = c.entries();
    expect(rows[0]).toMatchObject({
      level: "info",
      source: "backend",
      message: 'booted {"port":8080}',
    });
    expect(rows[1].level).toBe("error");
    expect(rows[1].message).toContain("boom");
  });

  test("console capture reports failure when the target console is unusable", () => {
    // A console whose methods can't be bound (e.g. a frozen/partial global)
    // must make install downgrade to passthrough rather than throw during boot.
    const broken = {} as unknown as ConsoleLike;
    const c = createLogCollector({ targetConsole: broken, now: () => 1000 });
    expect(c.installConsoleCapture()).toBe(false);
    expect(c.captureInstalled).toBe(false);
  });

  test("persists entries to a rotating JSONL and reloads them on start", () => {
    const fs = memFs();
    const dir = "/logs";
    const first = createLogCollector({
      dir,
      fs,
      path: memPath(),
      maxFileBytes: 40,
      now: () => 1000,
    });
    first.start();
    first.append({ source: "backend", message: "alpha" });
    first.append({ source: "backend", message: "beta" });
    first.append({ source: "backend", message: "gamma" });
    expect(fs.writes).toBeGreaterThan(1); // rotation kicked in under the cap

    // A fresh collector pointed at the same dir reloads history.
    const reloaded = createLogCollector({ dir, fs, path: memPath(), now: () => 2000 });
    reloaded.start();
    const rows = reloaded.entries().map((e: LogEntry) => e.message);
    expect(rows).toContain("alpha");
    expect(rows).toContain("gamma");
  });
});
