import type { GrantRecord } from "@justus/core";
import type { LedgerStore } from "./grant-ledger";

/** Minimal fs surface the store needs, so tests can inject an in-memory fake
 * without pulling in the real bare-fs. Matches the bare-fs sync API used here. */
export type LedgerFs = {
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string): void;
  mkdirSync(p: string, opts?: { recursive?: boolean }): void;
};

export type LedgerPath = {
  join(...parts: string[]): string;
  dirname(p: string): string;
};

export type FileLedgerStoreOpts = {
  dir: string;
  fs: LedgerFs;
  path: LedgerPath;
};

function isGrantRecord(value: unknown): value is GrantRecord {
  if (typeof value !== "object" || value === null) return false;
  return (
    "peerId" in value &&
    typeof value.peerId === "string" &&
    "lastChangedAt" in value &&
    typeof value.lastChangedAt === "number"
  );
}

/** Durable `LedgerStore` backed by `grant-ledger.json` in `dir`. The ledger is
 * tiny and per-device, so a single JSON file is simpler and safer than a
 * hyperdrive mount (which the album content already uses). Any read failure
 * (missing or corrupt file) falls back to an empty ledger, matching how
 * `photo-store.ts` treats its state file. */
export function createFileLedgerStore(opts: FileLedgerStoreOpts): LedgerStore {
  const file = opts.path.join(opts.dir, "grant-ledger.json");
  return {
    async read(): Promise<GrantRecord[]> {
      try {
        const parsed = JSON.parse(opts.fs.readFileSync(file, "utf8"));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isGrantRecord);
      } catch {
        return [];
      }
    },
    async write(records: GrantRecord[]): Promise<void> {
      opts.fs.mkdirSync(opts.path.dirname(file), { recursive: true });
      opts.fs.writeFileSync(file, JSON.stringify(records));
    },
  };
}
