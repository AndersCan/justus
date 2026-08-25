import { describe, expect, test } from "vite-plus/test";
import { createLogCollector, type LogCollector } from "./log-collector";
import { createLogsPlugin } from "./logs-plugin";

function makeCollector(): LogCollector {
  const c = createLogCollector({ now: () => 1_000 });
  c.append({ level: "debug", source: "backend", message: "boot" });
  c.append({ level: "info", source: "backend", message: "ready" });
  c.append({ level: "warn", source: "web", message: "slow render" });
  c.append({ level: "error", source: "web", message: "oops" });
  return c;
}

function invoke(
  plugin: ReturnType<typeof createLogsPlugin>,
  event: string,
  args: Record<string, unknown>,
) {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error("no invoke adapter");
  return adapter.invoke(event, args, { runtime: "bare", payload: new Uint8Array() });
}

describe("logs-plugin", () => {
  test("view returns all entries by default", async () => {
    const collector = makeCollector();
    const plugin = createLogsPlugin({ collector });
    const [err, res] = await invoke(plugin, "logs.view", {});
    expect(err).toBeNull();
    expect(res).not.toBeNull();
    expect((res as { entries: unknown[] }).entries).toHaveLength(4);
  });

  test("view filters by minimum level", async () => {
    const collector = makeCollector();
    const plugin = createLogsPlugin({ collector });
    const [err, res] = await invoke(plugin, "logs.view", { level: "warn" });
    expect(err).toBeNull();
    const entries = (res as { entries: { level: string }[] }).entries;
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.level === "warn" || e.level === "error")).toBe(true);
  });

  test("view filters by source", async () => {
    const collector = makeCollector();
    const plugin = createLogsPlugin({ collector });
    const [err, res] = await invoke(plugin, "logs.view", { sources: ["web"] });
    expect(err).toBeNull();
    const entries = (res as { entries: { source: string }[] }).entries;
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.source === "web")).toBe(true);
  });

  test("view honors tail", async () => {
    const collector = makeCollector();
    const plugin = createLogsPlugin({ collector });
    const [err, res] = await invoke(plugin, "logs.view", { tail: 1 });
    expect(err).toBeNull();
    const entries = (res as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(1);
  });

  test("clear empties the ring buffer and reports the count", async () => {
    const collector = makeCollector();
    const plugin = createLogsPlugin({ collector });
    const [err, res] = await invoke(plugin, "logs.clear", {});
    expect(err).toBeNull();
    expect((res as { cleared: number }).cleared).toBe(4);
    const [, after] = await invoke(plugin, "logs.view", {});
    expect((after as { entries: unknown[] }).entries).toHaveLength(0);
  });

  test("manifest advertises the logs capability and events", () => {
    const plugin = createLogsPlugin({ collector: makeCollector() });
    expect(plugin.id).toBe("justus.logs");
    expect(plugin.capabilities).toContain("logs");
    expect(plugin.events).toContain("logs.view");
    expect(plugin.events).toContain("logs.clear");
  });
});
