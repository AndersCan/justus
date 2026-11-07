import { describe, it, expect, vi } from "vite-plus/test";
import {
  severityClasses,
  formatLogLine,
  buildLogDownloadUrl,
  createLogsController,
  type LogsFetch,
} from "./logs";
import { VirtualClock } from "@mantaq/core";
import type { LogEntry } from "@justus/core";
import {
  availableSources,
  collectSources,
  filterLogEntries,
  keepSeenEntries,
  createLogsActor,
  logsEvents,
  visibleEntries,
} from "../machines/logs-machine";

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
    expect(severityClasses("error")).toContain("danger");
    expect(severityClasses("warn")).toContain("warn");
    expect(severityClasses("debug")).toContain("muted");
    expect(severityClasses("info")).toContain("ok");
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
    const snap = () => c.actor.snapshot();
    expect(
      snap()
        .context.entries.map((e) => e.source)
        .sort(),
    ).toEqual(["backend", "web"]);
    expect(availableSources(snap())).toEqual(["backend", "web"]);
    expect(
      visibleEntries(snap())
        .map((e) => e.source)
        .sort(),
    ).toEqual(["backend", "web"]);

    // filter to backend only
    c.toggleSource("backend");
    expect(visibleEntries(snap()).map((e) => e.source)).toEqual(["backend"]);

    // pausing stops the polling refresh
    c.setPaused(true);
    const callsBefore = fetchLogs.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchLogs.mock.calls.length).toBe(callsBefore);

    // clear empties the buffer
    const ok = await c.clear();
    expect(ok).toBe(true);
    expect(clearLogs).toHaveBeenCalled();
    expect(snap().context.entries).toEqual([]);

    c.stop();
  });
});

describe("LogsController failures", () => {
  it("keeps entries and records the error when a fetch fails", async () => {
    const good = entry({ source: "web", message: "ok" });
    let fail = false;
    const fetchLogs = vi.fn<LogsFetch>(async () =>
      fail ? [new Error("down"), null] : [null, { entries: [good] }],
    );
    const c = createLogsController({ fetchLogs, clearLogs: async () => [null, { cleared: 0 }] });
    c.start();
    await new Promise((r) => setTimeout(r, 5));
    fail = true;
    await c.refresh();
    const s = c.actor.snapshot().context;
    expect(s.error).toBe("down");
    expect(s.entries).toEqual([good]);
    expect(s.loading).toBe(false);
    c.stop();
  });
});

describe("keepSeenEntries", () => {
  const line = (n: number, ts = 1_700_000_000_000 + n) =>
    entry({ seq: n, ts, source: "web", message: `m${n}` });

  it("reuses held objects and takes new ones from the fetch", () => {
    const [a1, a2, a3] = [line(1), line(2), line(3)];
    const out = keepSeenEntries([a1, a2], [{ ...a1 }, { ...a2 }, a3]);
    expect(out[0]).toBe(a1);
    expect(out[1]).toBe(a2);
    expect(out[2]).toBe(a3);
  });

  it("returns the held array when nothing is new", () => {
    const held = [line(1), line(2)];
    expect(
      keepSeenEntries(
        held,
        held.map((e) => ({ ...e })),
      ),
    ).toBe(held);
  });

  it("drops lines past the cap and keeps the rest", () => {
    const [a1, a2, a3] = [line(1), line(2), line(3)];
    const a4 = line(4);
    const out = keepSeenEntries([a1, a2, a3], [{ ...a2 }, { ...a3 }, a4]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(a2);
    expect(out[1]).toBe(a3);
    expect(out[2]).toBe(a4);
  });

  it("treats the same seq with a different time as a different line", () => {
    const held = line(1, 1000);
    const fetched = line(1, 2000);
    expect(keepSeenEntries([held], [fetched])[0]).toBe(fetched);
  });

  it("keeps held objects through the actor", () => {
    const actor = createLogsActor({ clock: VirtualClock() });
    const [a1, a2, a3] = [line(1), line(2), line(3)];
    actor.send(logsEvents.loaded.create({ entries: [a1, a2], at: 1 }));
    const first = actor.snapshot().context.entries[0];
    actor.send(logsEvents.loaded.create({ entries: [{ ...a1 }, { ...a2 }, a3], at: 2 }));
    expect(actor.snapshot().context.entries[0]).toBe(first);
  });
});
