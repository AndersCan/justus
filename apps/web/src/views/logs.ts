import { atom, computed } from "nanostores";
import type { ReadableAtom, WritableAtom } from "nanostores";
import { html } from "lit-html";
import type { LogEntry, LogLevel } from "@justus/core";
import { LOG_LEVELS, LOGS_VIEW_MAX_ENTRIES } from "@justus/core";
import { gateway } from "../gateway";
import { useStore } from "../use-store";
import { toast } from "./toast";

/** Tailwind color classes per severity (vision: trust-colored, legible). */
export function severityClasses(level: LogLevel): string {
  switch (level) {
    case "error":
      return "border-l-brick text-brick";
    case "warn":
      return "border-l-honey text-honey";
    case "debug":
      return "border-l-line text-taupe";
    default:
      return "border-l-moss text-cocoa";
  }
}

/** Compact, copy-paste-stable text line for a log entry. */
export function formatLogLine(e: LogEntry): string {
  const t = new Date(e.ts);
  const ts = `${t.toISOString().slice(0, 19)}.${String(t.getMilliseconds()).padStart(3, "0")}`;
  const tag = e.tag ? ` [${e.tag}]` : "";
  return `${ts} ${e.level.toUpperCase()}${tag} (${e.source}) ${e.message}`;
}

/** Origin sources present in the current entries (backend / web / …). */
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

/** Render an unknown error to a human-readable string (never `[object Object]`). */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Build the loopback bulk-download URL (GET /__logs). Same-origin in the shell. */
export function buildLogDownloadUrl(opts: {
  level?: LogLevel | "all";
  sources?: ReadonlySet<string>;
  tail?: number;
}): string {
  const q = new URLSearchParams();
  q.set("format", "text");
  if (opts.level && opts.level !== "all") q.set("level", opts.level);
  if (opts.tail && opts.tail > 0) q.set("tail", String(opts.tail));
  if (opts.sources && opts.sources.size > 0) q.set("sources", [...opts.sources].join(","));
  return `/__logs?${q.toString()}`;
}

export type LogsFetch = (opts: {
  tail?: number;
  level?: LogLevel;
  sources?: string[];
}) => Promise<[unknown, { entries: LogEntry[] } | null]>;

export interface LogsControllerDeps {
  fetchLogs: LogsFetch;
  clearLogs: () => Promise<[unknown, { cleared: number } | null]>;
  intervalMs?: number;
}

export interface LogsController {
  $entries: WritableAtom<LogEntry[]>;
  $level: WritableAtom<LogLevel | "all">;
  $sources: WritableAtom<Set<string>>;
  $paused: WritableAtom<boolean>;
  $error: WritableAtom<string | null>;
  $loading: WritableAtom<boolean>;
  $updatedAt: WritableAtom<number | null>;
  $availableSources: ReadableAtom<string[]>;
  $visible: ReadableAtom<LogEntry[]>;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  setLevel(level: LogLevel | "all"): void;
  toggleSource(source: string): void;
  setPaused(paused: boolean): void;
  clear(): Promise<boolean>;
}

export function createLogsController(deps: LogsControllerDeps): LogsController {
  const intervalMs = deps.intervalMs ?? 2000;
  const $entries = atom<LogEntry[]>([]);
  const $level = atom<LogLevel | "all">("all");
  const $sources = atom<Set<string>>(new Set());
  const $paused = atom(false);
  const $error = atom<string | null>(null);
  const $loading = atom(false);
  const $updatedAt = atom<number | null>(null);

  const $availableSources = computed($entries, (entries) => collectSources(entries));
  const $visible = computed([$entries, $level, $sources], (entries, level, sources) =>
    filterLogEntries(entries, level, sources),
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = true;

  function currentOpts() {
    const level = $level.get();
    const sources = [...$sources.get()];
    return {
      tail: LOGS_VIEW_MAX_ENTRIES,
      ...(level !== "all" ? { level } : {}),
      ...(sources.length ? { sources } : {}),
    };
  }

  async function refresh() {
    if (stopped) return;
    $loading.set(true);
    const [err, res] = await deps.fetchLogs(currentOpts());
    $loading.set(false);
    if (err) {
      $error.set(errorMessage(err));
      return;
    }
    $error.set(null);
    $entries.set(res?.entries ?? []);
    $updatedAt.set(Date.now());
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void refresh();
    timer = setInterval(() => {
      if (!$paused.get()) void refresh();
    }, intervalMs);
  }

  function stop() {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function setLevel(level: LogLevel | "all") {
    $level.set(level);
    void refresh();
  }

  function toggleSource(source: string) {
    const next = new Set($sources.get());
    if (next.has(source)) next.delete(source);
    else next.add(source);
    $sources.set(next);
    void refresh();
  }

  function setPaused(paused: boolean) {
    $paused.set(paused);
  }

  async function clear(): Promise<boolean> {
    const [err] = await deps.clearLogs();
    if (err) {
      $error.set(errorMessage(err));
      return false;
    }
    $entries.set([]);
    $updatedAt.set(Date.now());
    return true;
  }

  return {
    $entries,
    $level,
    $sources,
    $paused,
    $error,
    $loading,
    $updatedAt,
    $availableSources,
    $visible,
    start,
    stop,
    refresh,
    setLevel,
    toggleSource,
    setPaused,
    clear,
  };
}

/** The live Logs controller the panel binds to (talks to the worklet backend). */
export const logsController = createLogsController({
  fetchLogs: (opts) => gateway.logs.view(opts),
  clearLogs: () => gateway.logs.clear(),
});

let started = false;
function ensureStarted() {
  if (started) return;
  started = true;
  logsController.start();
}

async function copyAll(entries: LogEntry[]) {
  const text = entries.map(formatLogLine).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Logs copied");
  } catch {
    toast("Couldn't copy — select and copy manually");
  }
}

async function downloadLogs(level: LogLevel | "all", sources: ReadonlySet<string>) {
  try {
    const res = await fetch(buildLogDownloadUrl({ level, sources }));
    if (!res.ok) {
      toast("Couldn't download logs");
      return;
    }
    const text = await res.text();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `justus-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    toast("Couldn't download logs");
  }
}

/** The Logs live-tail panel — rendered inside Settings' "Advanced" disclosure. */
export function logsPanel() {
  ensureStarted();
  const c = logsController;
  return useStore(c.$error, (error) =>
    useStore(c.$loading, (loading) =>
      useStore(c.$paused, (paused) =>
        useStore(c.$updatedAt, (updatedAt) =>
          useStore(c.$level, (level) =>
            useStore(c.$availableSources, (available) =>
              useStore(c.$sources, (sources) =>
                useStore(c.$visible, (visible) =>
                  logsBody({
                    error,
                    loading,
                    paused,
                    updatedAt,
                    level,
                    available,
                    sources,
                    visible,
                    c,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function logsBody(ctx: {
  error: string | null;
  loading: boolean;
  paused: boolean;
  updatedAt: number | null;
  level: LogLevel | "all";
  available: string[];
  sources: Set<string>;
  visible: LogEntry[];
  c: LogsController;
}) {
  const { error, loading, paused, updatedAt, level, available, sources, visible, c } = ctx;
  return html`
    <section class="warm-card p-5">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="warm-label">Live logs</h2>
        <div class="flex items-center gap-2 text-xs text-taupe">
          ${updatedAt ? html`<span>Updated ${new Date(updatedAt).toLocaleTimeString()}</span>` : null}
          ${loading ? html`<span class="h-2 w-2 animate-pulse rounded-full bg-honey"></span>` : null}
          ${
            paused
              ? html`<button class="warm-ghost" @click=${() => c.setPaused(false)}>
                  Resume live
                </button>`
              : null
          }
        </div>
      </div>
      <p class="mb-3 text-sm text-cocoa">
        Backend and web diagnostics, streamed from this device. Filter by severity or source; pause
        to read, then copy or download the visible lines.
      </p>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <label class="text-xs text-taupe" for="log-level">Severity</label>
        <select
          id="log-level"
          class="warm-input w-auto py-1"
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            c.setLevel(v as LogLevel | "all");
          }}
        >
          <option value="all" ?selected=${level === "all"}>All</option>
          <option value="debug" ?selected=${level === "debug"}>debug+</option>
          <option value="info" ?selected=${level === "info"}>info+</option>
          <option value="warn" ?selected=${level === "warn"}>warn+</option>
          <option value="error" ?selected=${level === "error"}>error</option>
        </select>

        <span class="text-xs text-taupe">Source</span>
        ${
          available.length === 0
            ? html`<span class="text-xs text-taupe">—</span>`
            : available.map(
                (s) => html`
                  <button
                    class="rounded-full px-2.5 py-1 text-xs font-semibold ${
                      sources.has(s) ? "bg-clay text-white" : "bg-butter text-cocoa"
                    }"
                    @click=${() => c.toggleSource(s)}
                    aria-pressed=${sources.has(s)}
                  >
                    ${s}
                  </button>
                `,
              )
        }

        <span class="ml-auto flex gap-2">
          <button
            class="warm-ghost"
            @click=${() => void copyAll(visible)}
            ?disabled=${visible.length === 0}
          >
            Copy
          </button>
          <button
            class="warm-ghost"
            @click=${() => void downloadLogs(level, sources)}
            ?disabled=${visible.length === 0}
          >
            Download
          </button>
          <button
            class="warm-ghost"
            @click=${() =>
              void c.clear().then((ok) => toast(ok ? "Logs cleared" : "Couldn't clear logs"))}
          >
            Clear
          </button>
        </span>
      </div>

      ${error ? html`<p class="mb-3 text-xs text-brick">Couldn't load logs — ${error}</p>` : null}

      <div
        class="max-h-80 overflow-auto rounded-2xl border border-line bg-white/60 p-3 font-mono text-[11px] leading-relaxed"
        @scroll=${() => {
          if (!c.$paused.get()) c.setPaused(true);
        }}
      >
        ${
          visible.length === 0
            ? html`<p class="text-taupe">No log entries yet.</p>`
            : visible
                .slice()
                .reverse()
                .map(
                  (e) => html`
                    <div class="border-l-2 px-2 py-0.5 ${severityClasses(e.level)}">
                      <span class="opacity-70">${new Date(e.ts).toISOString().slice(11, 23)}</span>
                      <span class="font-semibold">${e.level.toUpperCase()}</span>
                      ${e.tag ? html`<span class="opacity-70"> [${e.tag}]</span>` : null}
                      <span class="opacity-70"> (${e.source})</span>
                      ${e.message}
                    </div>
                  `,
                )
        }
      </div>
    </section>
  `;
}
