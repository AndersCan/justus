import { invokeEvent, type EventSpec, type InvokeEnvelope } from "@ekrooh/bare/core";
import type { LogEntry, LogLevel } from "./types";

/** Hard caps keep `logs.view` payloads well under the framed header limit. */
export const LOGS_VIEW_MAX_ENTRIES = 500;
export const LOGS_VIEW_MAX_LEVELS = 4;

export const logSpecs = {
  view: {
    pluginId: "justus.logs",
    name: "logs.view",
    // `tail` bounds the window; `level` filters by minimum severity; `sources`
    // filters by origin (e.g. only `web`). All optional + capped on the
    // backend so responses stay header-size safe.
    args: {} as {
      tail?: number;
      level?: LogLevel;
      sources?: string[];
    },
    result: {} as { entries: LogEntry[] },
  },
  clear: {
    pluginId: "justus.logs",
    name: "logs.clear",
    // Admin-only diagnostic: resets the in-memory ring buffer. Not exposed as a
    // user affordance in the UI.
    args: {} as Record<string, never>,
    result: {} as { cleared: number },
  },
} as const satisfies Record<string, EventSpec<any, any>>;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const logEvents = {
  view(opts?: {
    tail?: number;
    level?: LogLevel;
    sources?: string[];
  }): InvokeEnvelope<
    "logs.view",
    { tail?: number; level?: LogLevel; sources?: string[] },
    { entries: LogEntry[] }
  > {
    return invokeEvent(logSpecs.view, opts ?? {}, null, 10_000);
  },
  clear(): InvokeEnvelope<"logs.clear", Record<string, never>, { cleared: number }> {
    return invokeEvent(logSpecs.clear, {}, null, 10_000);
  },
};

export { LEVEL_RANK };
