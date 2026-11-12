import { describe, it, expect } from "vite-plus/test";
import { dropDeleted, type DropInput } from "../../src/photos/drop.ts";
import type { Drive } from "../../src/ports/drive-store.ts";
import { spoolNameFor } from "../../src/spool-name.ts";

function stubDrive(opts: {
  paths?: string[];
  fail?: boolean;
  live?: string[];
}): Drive & { cleared: string[]; swept: number } {
  const state = { cleared: [] as string[], swept: 0 };
  return {
    ...state,
    get cleared() {
      return state.cleared;
    },
    get swept() {
      return state.swept;
    },
    async clearDeleted() {
      state.swept += 1;
      if (opts.fail) return [new Error("index not here"), null];
      return [null, { paths: new Set(opts.paths ?? []) }];
    },
    async *list() {
      for (const path of opts.live ?? []) yield { path, size: 1, metadata: {} };
    },
    async clear(path: string) {
      state.cleared.push(path);
    },
  } as unknown as Drive & { cleared: string[]; swept: number };
}

function run(overrides: Partial<DropInput>) {
  const forgotten: string[] = [];
  const removedSpool: string[] = [];
  const logs: string[] = [];
  const input: DropInput = {
    others: [],
    selfKey: "self",
    selfDrive: stubDrive({}),
    removed: {},
    spoolNames: [],
    forget: (k, id, ext) => void forgotten.push(`${k}:${id}${ext}`),
    removeSpool: (n) => void removedSpool.push(n),
    log: (e) => void logs.push(e),
    timeoutMs: 100,
    ...overrides,
  };
  return { result: dropDeleted(input), forgotten, removedSpool, logs };
}

describe("dropDeleted", () => {
  it("forgets a spooled photo its drive no longer has, and keeps one it still has", async () => {
    const a = stubDrive({ paths: ["/photos/keep.jpg"] });
    const r = run({
      others: [{ key: "a", drive: a }],
      spoolNames: [
        spoolNameFor("a", "gone", ".jpg"),
        spoolNameFor("a", "gone", "thumb.jpg"),
        spoolNameFor("a", "keep", ".jpg"),
      ],
    });
    expect(await r.result).toEqual({ dropped: 2 });
    expect(r.forgotten).toEqual(["a:gone.jpg", "a:gone"]);
  });

  it("a drive whose sweep failed leaves its spool untouched", async () => {
    const r = run({
      others: [{ key: "a", drive: stubDrive({ fail: true }) }],
      spoolNames: [spoolNameFor("a", "x", ".jpg")],
    });
    expect(await r.result).toEqual({ dropped: 0 });
    expect(r.forgotten).toEqual([]);
    expect(r.logs).toContain("error");
  });

  it("a drive that throws is logged and does not stop the others", async () => {
    const boom = { clearDeleted: () => Promise.reject(new Error("closed")) } as unknown as Drive;
    const r = run({
      others: [
        { key: "a", drive: boom },
        { key: "b", drive: stubDrive({ paths: [] }) },
      ],
      spoolNames: [spoolNameFor("b", "x", ".jpg")],
    });
    expect(await r.result).toEqual({ dropped: 1 });
    expect(r.logs).toContain("error");
  });

  it("never touches this phone's own spool files", async () => {
    const own = stubDrive({ paths: [] });
    const r = run({
      others: [{ key: "self", drive: own }],
      removed: { "self:x": {} },
      spoolNames: [spoolNameFor("self", "x", ".jpg")],
    });
    expect(await r.result).toEqual({ dropped: 0 });
    expect(own.cleared).toEqual([]);
  });

  it("clears the live entry of a photo the Admin removed, and its cached copy", async () => {
    const cara = stubDrive({
      paths: ["/photos/p1.jpg", "/photos/p2.jpg"],
      live: ["/photos/p1.jpg", "/photos/p2.jpg"],
    });
    const r = run({
      others: [{ key: "cara", drive: cara }],
      removed: { "cara:p1": { removedAt: 1 } },
      spoolNames: [spoolNameFor("cara", "p1", ".jpg"), spoolNameFor("cara", "p2", ".jpg")],
    });
    expect(await r.result).toEqual({ dropped: 1 });
    expect(cara.cleared).toEqual(["/photos/p1.jpg", "/thumbs/p1.jpg"]);
    expect(r.forgotten).toEqual(["cara:p1.jpg"]);
  });

  it("removes a leftover .tmp of a deleted photo and ignores foreign names", async () => {
    const r = run({
      others: [{ key: "a", drive: stubDrive({ paths: [] }) }],
      spoolNames: [`${spoolNameFor("a", "x", ".jpg")}.1.ab.tmp`, "notes.txt"],
    });
    expect(await r.result).toEqual({ dropped: 1 });
    expect(r.removedSpool).toHaveLength(1);
    expect(r.forgotten).toEqual([]);
  });
});
