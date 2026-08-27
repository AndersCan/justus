/**
 * Unit tests for the grant ledger's backend surface (issue #30): the durable
 * file store and the `justus.grants` plugin. Both are exercised without a Bare
 * runtime — the store gets an in-memory fake fs, the plugin gets a fake ledger.
 */
import { describe, it, expect } from "vite-plus/test";
import type { GrantRecord } from "../src/grant-ledger.ts";
import { createFileLedgerStore, type LedgerFs, type LedgerPath } from "../src/ledger-store.ts";
import { createGrantsPlugin, type GrantLedgerLike } from "../src/grants-plugin.ts";

class MemFs implements LedgerFs {
  private files = new Map<string, string>();
  readFileSync(p: string): string {
    const found = this.files.get(p);
    if (found === undefined) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return found;
  }
  writeFileSync(p: string, data: string): void {
    this.files.set(p, data);
  }
  mkdirSync(): void {}
}

const memPath: LedgerPath = {
  join: (...parts) => parts.join("/"),
  dirname: (p) => p.split("/").slice(0, -1).join("/"),
};

describe("createFileLedgerStore", () => {
  it("reads back what was written", async () => {
    const store = createFileLedgerStore({ dir: "/data", fs: new MemFs(), path: memPath });
    const records: GrantRecord[] = [{ peerId: "peer-a", serveTo: "granted", lastChangedAt: 1 }];
    await store.write(records);
    expect(await store.read()).toEqual(records);
  });

  it("reads an empty ledger when the file is missing", async () => {
    const store = createFileLedgerStore({ dir: "/data", fs: new MemFs(), path: memPath });
    expect(await store.read()).toEqual([]);
  });

  it("falls back to an empty ledger when the file is corrupt", async () => {
    const fs = new MemFs();
    fs.writeFileSync("/data/grant-ledger.json", "{ not json");
    const store = createFileLedgerStore({ dir: "/data", fs, path: memPath });
    expect(await store.read()).toEqual([]);
  });
});

class FakeLedger implements GrantLedgerLike {
  records: GrantRecord[] = [{ peerId: "peer-a", serveTo: "undecided", lastChangedAt: 1 }];
  duePeers: string[] = ["peer-a", "peer-b"];
  granted: string[] = [];
  declined: string[] = [];
  snoozed = 0;

  list(): GrantRecord[] {
    return this.records;
  }
  dueUnknownHolderPrompts(): GrantRecord[] {
    return this.duePeers.map((peerId) => ({ peerId, serveTo: "undecided", lastChangedAt: 0 }));
  }
  async grant(peerId: string): Promise<GrantRecord> {
    this.granted.push(peerId);
    return { peerId, serveTo: "granted", lastChangedAt: 0 };
  }
  async decline(peerId: string): Promise<GrantRecord> {
    this.declined.push(peerId);
    return { peerId, serveTo: "declined", lastChangedAt: 0 };
  }
  async snoozeUnknownHolderPrompts(): Promise<void> {
    this.snoozed += 1;
  }
}

function invoke(
  plugin: ReturnType<typeof createGrantsPlugin>,
  event: string,
  args: Record<string, unknown> = {},
): Promise<[unknown, unknown]> {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error(`plugin has no invoke adapter for ${event}`);
  return adapter.invoke(event, args, undefined as never) as Promise<[unknown, unknown]>;
}

describe("createGrantsPlugin", () => {
  it("exposes the four grant events", () => {
    const plugin = createGrantsPlugin({ ledger: new FakeLedger() });
    expect((plugin.events ?? []).sort()).toEqual(
      ["grants.decline", "grants.grant", "grants.snooze", "grants.view"].sort(),
    );
  });

  it("view returns records plus the due peer ids", async () => {
    const plugin = createGrantsPlugin({ ledger: new FakeLedger() });
    const [err, res] = await invoke(plugin, "grants.view", {});
    expect(err).toBeNull();
    expect((res as { records: GrantRecord[]; due: string[] }).records).toHaveLength(1);
    expect((res as { records: GrantRecord[]; due: string[] }).due).toEqual(["peer-a", "peer-b"]);
  });

  it("grant delegates to the ledger and returns the record", async () => {
    const ledger = new FakeLedger();
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.grant", { peerId: "peer-c" });
    expect(err).toBeNull();
    expect((res as { record: GrantRecord }).record.serveTo).toBe("granted");
    expect(ledger.granted).toEqual(["peer-c"]);
  });

  it("decline delegates to the ledger", async () => {
    const ledger = new FakeLedger();
    const plugin = createGrantsPlugin({ ledger });
    await invoke(plugin, "grants.decline", { peerId: "peer-c" });
    expect(ledger.declined).toEqual(["peer-c"]);
  });

  it("snooze reports the dismissed count and snoozes the ledger", async () => {
    const ledger = new FakeLedger();
    const plugin = createGrantsPlugin({ ledger });
    const [err, res] = await invoke(plugin, "grants.snooze", {});
    expect(err).toBeNull();
    expect((res as { snoozed: number }).snoozed).toBe(2);
    expect(ledger.snoozed).toBe(1);
  });
});
