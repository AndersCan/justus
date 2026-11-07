import { Actor, event, state, type Clock, type Snapshot } from "@mantaq/core";
import type { LogEntry, LogLevel } from "@justus/core";
import { LOG_LEVELS } from "@justus/core";

/** The live log tail: what was fetched and which filters are on. */

export type LogsContext = {
  entries: LogEntry[];
  level: LogLevel | "all";
  sources: string[];
  paused: boolean;
  error: string | undefined;
  loading: boolean;
  updatedAt: number | undefined;
};

/** A fetch started. */
const loadingStarted = event("LOGS_FETCH_STARTED")();
/** A fetch returned these entries. */
const loaded = event("LOGS_FETCHED")<{ entries: LogEntry[]; at: number }>();
/** A fetch failed. */
const loadFailed = event("LOAD_FAILED")<{ message: string }>();
/** The minimum severity was changed. */
const levelChosen = event("LEVEL_CHOSEN")<{ level: LogLevel | "all" }>();
/** A source was switched on or off. */
const sourceToggled = event("SOURCE_TOGGLED")<{ source: string }>();
/** Live updates were paused or resumed. */
const paused = event("PAUSED")<{ paused: boolean }>();
/** The log buffer was cleared. */
const cleared = event("CLEARED")<{ at: number }>();

/** The tail is shown and can be filtered at any time. */
const holdingLogs = state("holdingLogs")();

export function createLogsActor(options: { clock: Clock }) {
  return Actor({
    inputs: [loadingStarted, loaded, loadFailed, levelChosen, sourceToggled, paused, cleared],
    internal: [],
    outputs: [],
    states: [holdingLogs],
    initial: holdingLogs,
    clock: options.clock,
    context: {
      entries: [],
      level: "all",
      sources: [],
      paused: false,
      error: undefined,
      loading: false,
      updatedAt: undefined,
    } as LogsContext,
    setup: (m) => {
      /** A fetch is in flight. */
      m.onAny({
        event: loadingStarted,
        handler: (_e, opts) => {
          opts.context.set({ ...opts.context.get(), loading: true });
          return {};
        },
      });
      /** Fresh entries replace the old ones and any error is cleared. */
      m.onAny({
        event: loaded,
        handler: (e, opts) => {
          opts.context.set({
            ...opts.context.get(),
            loading: false,
            error: undefined,
            entries: e.payload.entries,
            updatedAt: e.payload.at,
          });
          return {};
        },
      });
      /** The fetch failed: the old entries stay and the error is shown. */
      m.onAny({
        event: loadFailed,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), loading: false, error: e.payload.message });
          return {};
        },
      });
      /** The severity filter changes. */
      m.onAny({
        event: levelChosen,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), level: e.payload.level });
          return {};
        },
      });
      /** A source filter is added or removed. */
      m.onAny({
        event: sourceToggled,
        handler: (e, opts) => {
          const c = opts.context.get();
          const { source } = e.payload;
          const next = c.sources.includes(source)
            ? c.sources.filter((s) => s !== source)
            : [...c.sources, source];
          opts.context.set({ ...c, sources: next });
          return {};
        },
      });
      /** Polling pauses or resumes. */
      m.onAny({
        event: paused,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), paused: e.payload.paused });
          return {};
        },
      });
      /** The buffer was cleared on the device. */
      m.onAny({
        event: cleared,
        handler: (e, opts) => {
          opts.context.set({ ...opts.context.get(), entries: [], updatedAt: e.payload.at });
          return {};
        },
      });
    },
  });
}

export type LogsActor = ReturnType<typeof createLogsActor>;

export const logsEvents = {
  loadingStarted,
  loaded,
  loadFailed,
  levelChosen,
  sourceToggled,
  paused,
  cleared,
};

/** Origin sources present in the entries (backend / web / …). */
export function collectSources(entries: LogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) set.add(e.source);
  return [...set].sort();
}

/** Filter by minimum severity + selected sources. Empty source set = all sources. */
export function filterLogEntries(
  entries: LogEntry[],
  level: LogLevel | "all",
  sources: ReadonlySet<string>,
): LogEntry[] {
  const min = level === "all" ? -1 : LOG_LEVELS.indexOf(level);
  return entries.filter((e) => {
    if (min >= 0 && LOG_LEVELS.indexOf(e.level) < min) return false;
    if (sources.size > 0 && !sources.has(e.source)) return false;
    return true;
  });
}

/** The entries that pass the current filters. */
export function visibleEntries(s: Snapshot<LogsContext>): LogEntry[] {
  return filterLogEntries(s.context.entries, s.context.level, new Set(s.context.sources));
}

/** The sources to offer as filters. */
export function availableSources(s: Snapshot<LogsContext>): string[] {
  return collectSources(s.context.entries);
}
