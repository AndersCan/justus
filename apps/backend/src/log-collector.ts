/**
 * Debug-log collector for the justus worklet backend (issue #13).
 *
 * Captures the backend's own console output from the first line of startup into
 * a bounded in-memory ring buffer, persists a rotating JSONL to an app-private
 * directory, and serves it back over HTTP (`/__logs`). The log entry shape is
 * the decision-rich part every later observability slice consumes, so it is
 * committed here first.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  source: string;
  tag?: string;
  message: string;
}

export interface LogQuery {
  format?: "jsonl" | "text";
  tail?: number;
  level?: LogLevel;
}

/** Minimal fs surface the collector needs — node:fs and bare-fs both satisfy it. */
export interface FsLike {
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  appendFileSync(p: string, data: string | Uint8Array): void;
  readFileSync(p: string, enc?: "utf8"): string;
  readdirSync(p: string): string[];
  statSync(p: string): { size: number };
  unlinkSync(p: string): void;
}

export interface PathLike {
  join(...parts: string[]): string;
}

export interface ConsoleLike {
  log: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

export interface LogCollectorOptions {
  /** Ring-buffer cap (default 1000). */
  maxEntries?: number;
  /** Reject a POST `/__logs` batch larger than this many bytes (default 256KB). */
  maxBatchBytes?: number;
  /** Rotate the on-disk JSONL once it exceeds this many bytes (default 1MB). */
  maxFileBytes?: number;
  /** Directory for the rotating JSONL. Empty = capture-only (no persistence). */
  dir?: string;
  /**
   * fs/path implementations. Required for on-disk persistence (the production
   * runtime passes the real `bare-fs`/`bare-path`); omitted for capture-only
   * use or tests. The module deliberately does NOT import bare at the top so
   * it loads under Node/vitest without a Bare runtime (see photo-store.ts's DI
   * seam).
   */
  fs?: FsLike;
  path?: PathLike;
  now?: () => number;
  targetConsole?: ConsoleLike;
}

export interface IngestResult {
  accepted: number;
  dropped: number;
  error?: string;
}

export interface LogCollector {
  append(partial: {
    level?: LogLevel;
    source: string;
    tag?: string;
    message: string;
    ts?: number;
  }): LogEntry;
  entries(): LogEntry[];
  /** Bounded, filterable snapshot for the `logs.view` plugin surface. */
  view(opts?: { tail?: number; level?: LogLevel; sources?: string[] }): LogEntry[];
  query(opts?: LogQuery): { contentType: string; body: string };
  ingestBatch(raw: unknown): IngestResult;
  /** Admin diagnostic: reset the in-memory ring buffer. Returns entries cleared. */
  clear(): number;
  installConsoleCapture(): boolean;
  setDir(dir: string): void;
  start(): void;
  stop(): void;
  readonly dropped: number;
  readonly captureInstalled: boolean;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogCollector(options: LogCollectorOptions = {}): LogCollector {
  const maxEntries = options.maxEntries ?? 1000;
  const maxBatchBytes = options.maxBatchBytes ?? 256 * 1024;
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const fs = options.fs;
  const pathMod = options.path;
  const now = options.now ?? (() => Date.now());
  const target = options.targetConsole ?? (globalThis.console as unknown as ConsoleLike);

  const buffer: LogEntry[] = [];
  let seq = 0;
  let dropped = 0;
  let captureInstalled = false;
  let dir: string | undefined = options.dir;
  let currentFile: string | undefined;
  let currentSize = 0;
  let stopped = false;

  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  function formatText(e: LogEntry): string {
    const t = new Date(e.ts).toISOString();
    const tag = e.tag ? ` [${e.tag}]` : "";
    return `${t} ${e.level.toUpperCase()}${tag} (${e.source}) ${e.message}`;
  }

  function persist(entry: LogEntry): void {
    if (!dir || !fs || !pathMod || stopped) return;
    try {
      const line = JSON.stringify(entry) + "\n";
      const lineBytes = line.length;
      if (currentFile && currentSize + lineBytes > maxFileBytes) rotate();
      if (!currentFile) {
        currentFile = pathMod.join(dir, `justus-log-${Date.now()}.jsonl`);
        currentSize = 0;
      }
      fs.appendFileSync(currentFile, line);
      currentSize += lineBytes;
    } catch {
      // Persistence is best-effort; never break the caller.
    }
  }

  function rotate(): void {
    if (!dir || !pathMod) return;
    currentFile = pathMod.join(dir, `justus-log-${Date.now()}.jsonl`);
    currentSize = 0;
  }

  function append(partial: {
    level?: LogLevel;
    source: string;
    tag?: string;
    message: string;
    ts?: number;
  }): LogEntry {
    const entry: LogEntry = {
      seq: nextSeq(),
      ts: partial.ts ?? now(),
      level: partial.level ?? "info",
      source: partial.source,
      message: partial.message,
      ...(partial.tag !== undefined ? { tag: partial.tag } : {}),
    };
    buffer.push(entry);
    if (buffer.length > maxEntries) buffer.shift();
    persist(entry);
    return entry;
  }

  function entries(): LogEntry[] {
    return buffer.slice();
  }

  function view(opts: { tail?: number; level?: LogLevel; sources?: string[] } = {}): LogEntry[] {
    let rows = buffer;
    if (opts.level) {
      const min = LEVEL_RANK[opts.level];
      rows = rows.filter((e) => LEVEL_RANK[e.level] >= min);
    }
    if (opts.sources && opts.sources.length > 0) {
      const set = new Set(opts.sources);
      rows = rows.filter((e) => set.has(e.source));
    }
    if (typeof opts.tail === "number" && opts.tail >= 0) {
      rows = rows.slice(Math.max(0, rows.length - opts.tail));
    }
    return rows.slice();
  }

  function clear(): number {
    const cleared = buffer.length;
    buffer.length = 0;
    // A diagnostic reset also truncates the active on-disk file so a fresh
    // capture starts clean; best-effort, never breaks the caller.
    if (dir && fs && currentFile) {
      try {
        fs.unlinkSync(currentFile);
      } catch {
        // ignore — persistence is optional
      }
      currentFile = undefined;
      currentSize = 0;
    }
    return cleared;
  }

  function query(opts: LogQuery = {}): { contentType: string; body: string } {
    let rows = buffer;
    if (opts.level) rows = rows.filter((e) => e.level === opts.level);
    if (typeof opts.tail === "number" && opts.tail >= 0) {
      rows = rows.slice(Math.max(0, rows.length - opts.tail));
    }
    const format = opts.format ?? "jsonl";
    if (format === "text") {
      return {
        contentType: "text/plain; charset=utf-8",
        body: rows.map(formatText).join("\n"),
      };
    }
    return {
      contentType: "application/x-ndjson",
      body: rows.map((e) => JSON.stringify(e)).join("\n"),
    };
  }

  function coerceLevel(v: unknown): LogLevel {
    return LOG_LEVELS.includes(v as LogLevel) ? (v as LogLevel) : "info";
  }

  function ingestBatch(raw: unknown): IngestResult {
    if (!Array.isArray(raw)) {
      return { accepted: 0, dropped: 0, error: "expected an array of log entries" };
    }
    if (raw.length === 0) {
      return { accepted: 0, dropped: 0, error: "empty batch" };
    }
    if (JSON.stringify(raw).length > maxBatchBytes) {
      dropped += raw.length;
      return { accepted: 0, dropped: raw.length, error: "batch exceeds size limit" };
    }
    let accepted = 0;
    let droppedInBatch = 0;
    for (const item of raw) {
      if (typeof item !== "object" || item === null) {
        droppedInBatch += 1;
        continue;
      }
      const o = item as Record<string, unknown>;
      if (typeof o.message !== "string") {
        droppedInBatch += 1;
        continue;
      }
      const source = typeof o.source === "string" && o.source ? o.source : "web";
      append({
        level: coerceLevel(o.level),
        source,
        tag: typeof o.tag === "string" ? o.tag : undefined,
        message: o.message,
      });
      accepted += 1;
    }
    dropped += droppedInBatch;
    return { accepted, dropped: droppedInBatch };
  }

  function installConsoleCapture(): boolean {
    if (captureInstalled) return true;
    try {
      const real: ConsoleLike = {
        log: target.log.bind(target),
        info: target.info.bind(target),
        warn: target.warn.bind(target),
        error: target.error.bind(target),
        debug: target.debug.bind(target),
      };
      const methodLevel: Record<keyof ConsoleLike, LogLevel> = {
        log: "info",
        info: "info",
        warn: "warn",
        error: "error",
        debug: "debug",
      };
      const wrap =
        (method: keyof ConsoleLike) =>
        (...args: unknown[]): void => {
          try {
            const message = args
              .map((a) => (typeof a === "string" ? a : safeStringify(a)))
              .join(" ");
            append({ level: methodLevel[method], source: "backend", message });
          } catch {
            // A collector failure must never break console output.
          }
          try {
            // Forward to the real console (dev terminal / e2e assertions stay
            // intact). Wrapped so a misbehaving console can't break boot.
            real[method].apply(target, args);
          } catch {
            // ignore
          }
        };
      target.log = wrap("log");
      target.info = wrap("info");
      target.warn = wrap("warn");
      target.error = wrap("error");
      target.debug = wrap("debug");
      captureInstalled = true;
      return true;
    } catch {
      // Downgrade to passthrough: leave the real console untouched.
      return false;
    }
  }

  function loadPersisted(): void {
    if (!dir || !fs || !pathMod) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
      if (files.length === 0) return;
      // A rotation produces multiple files; reseed the ring buffer from all of
      // them (oldest first) so history across rotations survives a restart.
      for (const f of files) {
        let text: string;
        try {
          text = fs.readFileSync(pathMod.join(dir, f), "utf8");
        } catch {
          continue;
        }
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const e = JSON.parse(line) as LogEntry;
            if (typeof e.seq === "number") {
              buffer.push(e);
              if (e.seq > seq) seq = e.seq;
            }
          } catch {
            // Skip a corrupt line rather than fail the whole load.
          }
        }
      }
      if (buffer.length > maxEntries) buffer.splice(0, buffer.length - maxEntries);
      const last = files[files.length - 1];
      currentFile = pathMod.join(dir, last);
      try {
        currentSize = fs.statSync(currentFile).size;
      } catch {
        currentSize = 0;
      }
    } catch {
      // Best-effort: a missing/unreadable log dir just means no history.
    }
  }

  function setDir(d: string): void {
    dir = d;
    if (captureInstalled) loadPersisted();
  }

  function start(): void {
    if (stopped) return;
    installConsoleCapture();
    if (dir) loadPersisted();
  }

  function stop(): void {
    stopped = true;
  }

  return {
    append,
    entries,
    view,
    query,
    ingestBatch,
    clear,
    installConsoleCapture,
    setDir,
    start,
    stop,
    get dropped() {
      return dropped;
    },
    get captureInstalled() {
      return captureInstalled;
    },
  };
}

function safeStringify(a: unknown): string {
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
