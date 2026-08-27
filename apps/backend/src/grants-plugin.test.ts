import { describe, expect, test, vi } from "vite-plus/test";
import { createGrantsPlugin, type GrantLedgerLike } from "./grants-plugin";
import type { GrantRecord } from "@justus/core";

const record = (peerId: string, over: Record<string, unknown> = {}): GrantRecord => ({
  peerId,
  serveTo: "undecided",
  lastChangedAt: 0,
  ...over,
});

function makeLedger(): GrantLedgerLike {
  return {
    list: vi.fn().mockReturnValue([record("p1", { serveTo: "granted" })]),
    dueUnknownHolderPrompts: vi.fn().mockReturnValue([]),
    grant: vi.fn().mockResolvedValue(record("p1", { serveTo: "granted" })),
    decline: vi.fn().mockResolvedValue(record("p1", { serveTo: "declined" })),
    revoke: vi.fn().mockResolvedValue(record("p1", { serveTo: "revoked" })),
    snoozeUnknownHolderPrompts: vi.fn().mockResolvedValue(undefined),
  };
}

function invoke(
  plugin: ReturnType<typeof createGrantsPlugin>,
  event: string,
  args: Record<string, unknown>,
) {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error("no invoke adapter");
  return adapter.invoke(event, args, { runtime: "bare", payload: new Uint8Array() });
}

describe("grants-plugin", () => {
  test("view returns the ledger records and due prompts", async () => {
    const ledger = makeLedger();
    (ledger.dueUnknownHolderPrompts as any).mockReturnValue([
      record("p2", { unknownHolderSince: 1 }),
    ]);
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.view", {});
    expect(err).toBeNull();
    const view = res as { records: GrantRecord[]; due: string[] };
    expect(view.records).toHaveLength(1);
    expect(view.due).toEqual(["p2"]);
  });

  test("grant delegates to the ledger", async () => {
    const ledger = makeLedger();
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.grant", { peerId: "p1" });
    expect(err).toBeNull();
    expect((res as { record: GrantRecord }).record.serveTo).toBe("granted");
    expect(ledger.grant).toHaveBeenCalledWith("p1");
  });

  test("decline delegates to the ledger", async () => {
    const ledger = makeLedger();
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.decline", { peerId: "p1" });
    expect(err).toBeNull();
    expect((res as { record: GrantRecord }).record.serveTo).toBe("declined");
    expect(ledger.decline).toHaveBeenCalledWith("p1");
  });

  test("revoke delegates to the ledger", async () => {
    const ledger = makeLedger();
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.revoke", { peerId: "p1" });
    expect(err).toBeNull();
    expect((res as { record: GrantRecord }).record.serveTo).toBe("revoked");
    expect(ledger.revoke).toHaveBeenCalledWith("p1");
  });

  test("snooze reports the dismissed count", async () => {
    const ledger = makeLedger();
    (ledger.dueUnknownHolderPrompts as any).mockReturnValue([
      record("p1", { unknownHolderSince: 1 }),
      record("p2", { unknownHolderSince: 1 }),
    ]);
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.snooze", {});
    expect(err).toBeNull();
    expect((res as { snoozed: number }).snoozed).toBe(2);
  });

  test("manifest advertises the grants capability and events", () => {
    const plugin = createGrantsPlugin({ ledger: makeLedger() });
    expect(plugin.id).toBe("justus.grants");
    expect(plugin.capabilities).toContain("grants");
    expect(plugin.events).toContain("grants.view");
    expect(plugin.events).toContain("grants.grant");
    expect(plugin.events).toContain("grants.decline");
    expect(plugin.events).toContain("grants.revoke");
    expect(plugin.events).toContain("grants.snooze");
  });
});
