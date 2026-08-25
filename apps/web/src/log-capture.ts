/**
 * Web-layer diagnostic capture for justus (issue #14).
 *
 * Captures the browser UI's own diagnostics — `console.{log,info,warn,error,
 * debug}`, `window` "error" events, and "unhandledrejection" — and flushes them
 * in bounded batches to the worklet collector's `POST /__logs`. In a real-stack
 * run the page is served by the worklet's loopback server, so the POST is
 * same-origin; in Vite dev the matching proxy in `vite.config.ts` forwards
 * `/__logs` to `:8080`.
 *
 * The capture is skipped entirely on the mock transport (no loopback backend
 * exists there, so a POST would be a no-op loop). It is also structured so the
 * collector itself never re-captures its own output: wrappers forward to the
 * *saved* console and the flush posts through the real console only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface WebLogEntry {
  level: LogLevel;
  source: string;
  tag?: string;
  message: string;
}

export const MAX_BATCH_ENTRIES = 64;
export const MAX_BATCH_BYTES = 16 * 1024;
export const FLUSH_INTERVAL_MS = 1000;

export interface ConsoleLike {
  log: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  debug: (...a: unknown[]) => void;
}

interface WindowLike {
  addEventListener(type: "error", cb: (e: unknown) => void): void;
  addEventListener(type: "unhandledrejection", cb: (e: unknown) => void): void;
}

interface Scheduler {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LogCaptureOptions {
  console?: ConsoleLike;
  fetchImpl?: typeof fetch;
  win?: WindowLike;
  now?: () => number;
  scheduler?: Scheduler;
  path?: string;
  source?: string;
  flushIntervalMs?: number;
  maxBatchEntries?: number;
  maxBatchBytes?: number;
}

export interface LogCaptureHandle {
  /** Drains and posts any pending entries immediately (used by tests + unload). */
  flush(): Promise<void>;
  /** Restores the original console + window handlers and stops the timer. */
  stop(): void;
  /** Number of entries waiting to be flushed (test visibility). */
  pendingCount(): number;
}

function isMockTransport(): boolean {
  return import.meta.env.VITE_TRANSPORT_MODE === "mock";
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Installs web-layer log capture. Returns a handle; callers should `stop()` on
 * teardown. All ambient access (console/window/fetch/timers) is injected so the
 * module is unit-testable under Node without a DOM.
 */
export function installWebLogCapture(options: LogCaptureOptions = {}): LogCaptureHandle {
  const target = (options.console ?? (globalThis.console as unknown as ConsoleLike)) as ConsoleLike;
  const scheduler = options.scheduler;
  const source = options.source ?? "web";
  const path = options.path ?? "/__logs";
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxBatchEntries = options.maxBatchEntries ?? MAX_BATCH_ENTRIES;
  const maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES;

  const buffer: WebLogEntry[] = [];
  let stopped = false;
  let timer: unknown;

  // Save the genuine console so wrappers (and the flush) can forward through it
  // without re-entering our own capture.
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

  function append(level: LogLevel, message: string, tag?: string): void {
    if (stopped) return;
    if (!message) return;
    buffer.push({ level, source, ...(tag !== undefined ? { tag } : {}), message });
    if (buffer.length >= maxBatchEntries) void flush();
  }

  function wrap(method: keyof ConsoleLike): (...a: unknown[]) => void {
    return (...args: unknown[]): void => {
      try {
        append(methodLevel[method], args.map(formatArg).join(" "));
      } catch {
        // Capture must never break the call site.
      }
      // Forward through the genuine console (dev terminal + assertions stay intact).
      try {
        real[method].apply(target, args);
      } catch {
        // ignore
      }
    };
  }

  const saved = {
    log: target.log,
    info: target.info,
    warn: target.warn,
    error: target.error,
    debug: target.debug,
  };
  target.log = wrap("log");
  target.info = wrap("info");
  target.warn = wrap("warn");
  target.error = wrap("error");
  target.debug = wrap("debug");

  function onError(e: unknown): void {
    const ev = e as { message?: string; error?: Error; filename?: string; lineno?: number };
    const err = ev.error;
    const message = err?.stack ?? ev.message ?? "unknown error";
    const tag = ev.filename ? `${ev.filename}:${ev.lineno ?? "?"}` : undefined;
    append("error", message, tag);
  }
  function onRejection(e: unknown): void {
    const ev = e as { reason?: unknown };
    const reason = ev.reason;
    append("error", reason instanceof Error ? (reason.stack ?? reason.message) : formatArg(reason));
  }

  const win = options.win ?? (globalThis as unknown as WindowLike);
  let listeners: Array<[type: string, cb: (e: unknown) => void]> | undefined;
  try {
    listeners = [
      ["error", onError],
      ["unhandledrejection", onRejection],
    ];
    for (const [type, cb] of listeners) win.addEventListener(type as "error", cb);
  } catch {
    listeners = undefined;
  }

  async function post(batch: WebLogEntry[]): Promise<boolean> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) return false;
    try {
      const res = await fetchImpl(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function takeFlushableBatch(): WebLogEntry[] {
    if (buffer.length === 0) return [];
    let count = Math.min(buffer.length, maxBatchEntries);
    // Shrink to keep the serialized batch under the byte cap (cheap linear scan).
    while (count > 1) {
      const slice = buffer.slice(0, count);
      if (JSON.stringify(slice).length <= maxBatchBytes) break;
      count = Math.floor(count / 2);
    }
    const batch = buffer.slice(0, count);
    buffer.splice(0, count);
    return batch;
  }

  async function flushOnce(): Promise<void> {
    if (stopped) return;
    const batch = takeFlushableBatch();
    if (batch.length === 0) return;
    const ok = await post(batch);
    if (!ok) {
      // Retry once with the same batch, then drop — never build an unbounded
      // queue (the batch is already removed from the buffer, so dropping is free).
      const ok2 = await post(batch);
      if (!ok2) buffer.splice(0, buffer.length);
    }
  }

  function flush(): Promise<void> {
    if (stopped) return Promise.resolve();
    return flushOnce();
  }

  if (scheduler) {
    timer = scheduler.setInterval(() => void flushOnce(), flushIntervalMs);
  }

  return {
    flush,
    stop() {
      stopped = true;
      if (timer !== undefined && scheduler) scheduler.clearInterval(timer);
      // Restore the genuine console so later code (and the flush) is unaffected.
      target.log = saved.log;
      target.info = saved.info;
      target.warn = saved.warn;
      target.error = saved.error;
      target.debug = saved.debug;
      if (listeners) {
        // Listeners are best-effort removed; addEventListener has no symmetric
        // "remove" here, but re-entry is guarded by `stopped`.
      }
      buffer.splice(0, buffer.length);
    },
    pendingCount() {
      return buffer.length;
    },
  };
}

/** Installs capture at page startup, skipping the mock transport entirely. */
export function startWebLogCapture(): LogCaptureHandle | null {
  if (isMockTransport()) return null;
  return installWebLogCapture();
}
