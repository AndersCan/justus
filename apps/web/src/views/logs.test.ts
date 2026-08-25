import { describe, it, expect, vi } from "vite-plus/test";
import {
  severityClasses,
  formatLogLine,
  collectSources,
  filterLogEntries,
  buildLogDownloadUrl,
  createLogsController,
  type LogsFetch,
} from "./logs";
import type { LogEntry } from "@justus/core";

function entry(p: Partial<LogEntry> & { source: string; message: string }): LogEntry {
  return {
    seq: 1,
    ts: 1_700_000_000_000,
    level: "info",
    ...p,
  };
}

describe("severityClasses", () => {
  it("maps each level to a distinct color class", () => {
    expect(severityClasses("error")).toContain("brick");
    expect(severityClasses("warn")).toContain("honey");
    expect(severityClasses("debug")).toContain("taupe");
    expect(severityClasses("info")).toContain("moss");
  });
});

describe("formatLogLine", () => {
  it("renders level, source, optional tag and message", () => {
    const line = formatLogLine(entry({ level: "warn", source: "web", tag: "x", message: "hi" }));
    expect(line).toContain("WARN");
    expect(line).toContain("(web)");
    expect(line).toContain("[x]");
    expect(line).toContain("hi");
  });
});

describe("collectSources", () => {
  it("returns sorted unique sources", () => {
    const srcs = collectSources([
      entry({ source: "web", message: "a" }),
      entry({ source: "backend", message: "b" }),
      entry({ source: "web", message: "c" }),
    ]);
    expect(srcs).toEqual(["backend", "web"]);
  });
});

describe("filterLogEntries", () => {
  const entries: LogEntry[] = [
    entry({ seq: 1, level: "debug", source: "backend", message: "d" }),
    entry({ seq: 2, level: "info", source: "web", message: "i" }),
    entry({ seq: 3, level: "warn", source: "backend", message: "w" }),
    entry({ seq: 4, level: "error", source: "web", message: "e" }),
  ];
  it("filters by minimum severity", () => {
    expect(filterLogEntries(entries, "warn", new Set()).map((e) => e.level)).toEqual([
      "warn",
      "error",
    ]);
  });
  it("filters to a selected source only", () => {
    expect(filterLogEntries(entries, "all", new Set(["web"])).map((e) => e.source)).toEqual([
      "web",
      "web",
    ]);
  });
  it("empty source set keeps all sources", () => {
    expect(filterLogEntries(entries, "all", new Set()).length).toBe(4);
  });
});

describe("buildLogDownloadUrl", () => {
  it("encodes format, level and sources", () => {
    const url = buildLogDownloadUrl({ level: "warn", sources: new Set(["web"]) });
    expect(url).toContain("format=text");
    expect(url).toContain("level=warn");
    expect(url).toContain("sources=web");
  });
});

describe("LogsController", () => {
  const backend = entry({ seq: 1, level: "info", source: "backend", message: "b" });
  const web = entry({ seq: 2, level: "warn", source: "web", message: "w" });

  it("polls, surfaces backend + web, filters by source and pauses", async () => {
    const fetchLogs = vi.fn<LogsFetch>(async () => [null, { entries: [backend, web] }]);
    const clearLogs = vi.fn<() => Promise<[unknown, { cleared: number } | null]>>(async () => [
      null,
      { cleared: 2 },
    ]);
    const c = createLogsController({ fetchLogs, clearLogs, intervalMs: 10 });
    c.start();

    // initial refresh is async
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchLogs).toHaveBeenCalled();
    expect(
      c.$entries
        .get()
        .map((e) => e.source)
        .sort(),
    ).toEqual(["backend", "web"]);
    expect(c.$availableSources.get()).toEqual(["backend", "web"]);
    expect(
      c.$visible
        .get()
        .map((e) => e.source)
        .sort(),
    ).toEqual(["backend", "web"]);

    // filter to backend only
    c.toggleSource("backend");
    expect(c.$visible.get().map((e) => e.source)).toEqual(["backend"]);

    // pausing stops the polling refresh
    c.setPaused(true);
    const callsBefore = fetchLogs.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchLogs.mock.calls.length).toBe(callsBefore);

    // clear empties the buffer
    const ok = await c.clear();
    expect(ok).toBe(true);
    expect(clearLogs).toHaveBeenCalled();
    expect(c.$entries.get()).toEqual([]);

    c.stop();
  });
});
