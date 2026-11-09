import { describe, expect, it } from "vite-plus/test";
import type { Drive } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import {
  HELD_DIR,
  HOLDING_PATH,
  MAX_HELD,
  PREVIEWED_DIR,
  FORMER_PATH,
  MAX_FORMER_IDS,
  MAX_FORMER_PEOPLE,
  addFormer,
  copyFormer,
  copyHeld,
  dropFormer,
  ensureHoldingMarker,
  heldPath,
  holdersFor,
  markFormerLeft,
  markHeld,
  markPreviewed,
  readFormer,
  readHeld,
  type HeldReport,
} from "../../src/photos/holders.ts";

function phone() {
  const hub = createFakeHub();
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  return createFakeDriveStore({ hub, node });
}

async function twoDrives() {
  const drives = phone();
  return [await drives.openOwn("folder/a"), await drives.openOwn("folder/b")] as const;
}

function logger() {
  const events: string[] = [];
  return { events, log: (event: string) => void events.push(event) };
}

describe("ensureHoldingMarker", () => {
  it("writes the marker once", async () => {
    const [drive] = await twoDrives();
    expect(await ensureHoldingMarker(drive)).toEqual([null, true]);
    expect(await drive.readSmall(HOLDING_PATH, 100)).toBe('{"version":1}');
    expect(await ensureHoldingMarker(drive)).toEqual([null, false]);
  });

  it("returns an error value when the write fails", async () => {
    const [drive] = await twoDrives();
    const broken: Drive = {
      ...drive,
      put: async () => {
        throw new Error("disk full");
      },
    };
    const [error, value] = await ensureHoldingMarker(broken);
    expect(error).toEqual({ kind: "write-failed", message: "disk full" });
    expect(value).toBeNull();
  });
});

describe("markHeld", () => {
  it("writes the entry", async () => {
    const [drive] = await twoDrives();
    expect(await markHeld(drive, "abc-1_x")).toEqual([null, true]);
    expect(await drive.readSmall(`${HELD_DIR}/abc-1_x`, 10)).toBe("1");
  });

  it("refuses unsafe ids", async () => {
    const [drive] = await twoDrives();
    for (const id of ["../x", "", "a".repeat(81), "a/b"]) {
      expect(heldPath(id)).toBeUndefined();
      expect(await markHeld(drive, id)).toEqual([null, false]);
    }
    expect(await markHeld(drive, "a".repeat(80))).toEqual([null, true]);
  });

  it("returns an error value when the write fails", async () => {
    const [drive] = await twoDrives();
    const broken: Drive = {
      ...drive,
      put: async () => {
        throw new Error("nope");
      },
    };
    expect((await markHeld(broken, "a"))[0]).toEqual({ kind: "write-failed", message: "nope" });
  });
});

describe("markPreviewed", () => {
  it("writes the entry under /previewed", async () => {
    const [drive] = await twoDrives();
    expect(await markPreviewed(drive, "abc-1_x")).toEqual([null, true]);
    expect(await drive.readSmall(`${PREVIEWED_DIR}/abc-1_x`, 10)).toBe("1");
    expect(await drive.readSmall(`${HELD_DIR}/abc-1_x`, 10)).toBeUndefined();
  });

  it("refuses unsafe ids and writes nothing", async () => {
    const [drive] = await twoDrives();
    for (const id of ["../x", "", "a".repeat(81), "a/b"]) {
      expect(await markPreviewed(drive, id)).toEqual([null, false]);
    }
    expect(await markPreviewed(drive, "a".repeat(80))).toEqual([null, true]);
  });

  it("returns an error value when the write fails", async () => {
    const [drive] = await twoDrives();
    const broken: Drive = {
      ...drive,
      put: async () => {
        throw new Error("nope");
      },
    };
    expect((await markPreviewed(broken, "a"))[0]).toEqual({
      kind: "write-failed",
      message: "nope",
    });
  });
});

describe("readHeld", () => {
  it("is silent without a marker", async () => {
    const [drive] = await twoDrives();
    await drive.put(`${HELD_DIR}/a`, Buffer.from("1"));
    const { log, events } = logger();
    expect(await readHeld(drive, { timeoutMs: 100, log })).toEqual({ kind: "silent" });
    expect(events).toEqual([]);
  });

  it("is silent for an unparsable marker", async () => {
    const [drive] = await twoDrives();
    await drive.put(HOLDING_PATH, Buffer.from("{nope"));
    expect(await readHeld(drive, { timeoutMs: 100, log: () => {} })).toEqual({ kind: "silent" });
  });

  it("is silent and logs for another version", async () => {
    const [drive] = await twoDrives();
    await drive.put(HOLDING_PATH, Buffer.from('{"version":2}'));
    const { log, events } = logger();
    expect(await readHeld(drive, { timeoutMs: 100, log })).toEqual({ kind: "silent" });
    expect(events).toEqual(["holding.unsupported"]);
  });

  it("reads the ids and skips junk names", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    await markHeld(drive, "a1");
    await markHeld(drive, "b2");
    await drive.put(`${HELD_DIR}/bad name`, Buffer.from("1"));
    await drive.put(`${HELD_DIR}/sub/x`, Buffer.from("1"));
    expect(await readHeld(drive, { timeoutMs: 100, log: () => {} })).toEqual({
      kind: "reports",
      ids: new Set(["a1", "b2"]),
      previews: new Set(),
    });
  });

  it("reads the previews and skips junk names", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    await markHeld(drive, "a1");
    await markPreviewed(drive, "p1");
    await drive.put(`${PREVIEWED_DIR}/bad name`, Buffer.from("1"));
    await drive.put(`${PREVIEWED_DIR}/sub/x`, Buffer.from("1"));
    expect(await readHeld(drive, { timeoutMs: 100, log: () => {} })).toEqual({
      kind: "reports",
      ids: new Set(["a1"]),
      previews: new Set(["p1"]),
    });
  });

  it("keeps the held ids and logs when the previews list is slow", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    await markHeld(drive, "a1");
    const slow: Drive = {
      ...drive,
      list: (dir) =>
        dir === PREVIEWED_DIR
          ? { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
          : drive.list(dir),
    };
    const lines: Array<[string, unknown]> = [];
    const log = (event: string, data?: unknown) => void lines.push([event, data]);
    expect(await readHeld(slow, { timeoutMs: 60, log })).toEqual({
      kind: "reports",
      ids: new Set(["a1"]),
      previews: new Set(),
    });
    expect(lines.map(([e, d]) => [e, (d as { err: string }).err])).toEqual([
      ["holding.read", "previews-timeout"],
    ]);
  });

  it("keeps the held ids and logs when the previews list throws", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    await markHeld(drive, "a1");
    const broken: Drive = {
      ...drive,
      list: (dir) => {
        if (dir === PREVIEWED_DIR) throw new Error("gone");
        return drive.list(dir);
      },
    };
    const lines: Array<[string, unknown]> = [];
    const log = (event: string, data?: unknown) => void lines.push([event, data]);
    expect(await readHeld(broken, { timeoutMs: 100, log })).toEqual({
      kind: "reports",
      ids: new Set(["a1"]),
      previews: new Set(),
    });
    expect(lines.map(([e, d]) => [e, (d as { err: string }).err])).toEqual([
      ["holding.read", "gone"],
    ]);
  });

  it("reports an empty list when the marker has no entries", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    expect(await readHeld(drive, { timeoutMs: 100, log: () => {} })).toEqual({
      kind: "reports",
      ids: new Set(),
      previews: new Set(),
    });
  });

  it("cuts the list at MAX_HELD", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    const many: Drive = {
      ...drive,
      async *list(dir) {
        if (dir !== HELD_DIR) return;
        for (let i = 0; i < MAX_HELD + 5; i++) {
          yield { path: `${HELD_DIR}/p${i}`, size: 1, metadata: {} };
        }
      },
    };
    const report = await readHeld(many, { timeoutMs: 20_000, log: () => {} });
    expect(report.kind === "reports" && report.ids.size).toBe(MAX_HELD);
  });

  it("is silent and logs when the list is slow", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    const slow: Drive = {
      ...drive,
      list: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
    };
    const { log, events } = logger();
    expect(await readHeld(slow, { timeoutMs: 30, log })).toEqual({ kind: "silent" });
    expect(events).toEqual(["holding.read"]);
  });

  it("is silent and logs when the drive throws", async () => {
    const [drive] = await twoDrives();
    const broken: Drive = {
      ...drive,
      readSmall: async () => {
        throw new Error("gone");
      },
    };
    const { log, events } = logger();
    expect(await readHeld(broken, { timeoutMs: 30, log })).toEqual({ kind: "silent" });
    expect(events).toEqual(["holding.read"]);
  });
});

describe("copyHeld", () => {
  it("copies the marker and entries, once", async () => {
    const [from, to] = await twoDrives();
    await ensureHoldingMarker(from);
    await markHeld(from, "a");
    await markHeld(from, "b");
    expect(await copyHeld(from, to)).toBe(2);
    expect(await to.readSmall(HOLDING_PATH, 100)).toBe('{"version":1}');
    expect(await readHeld(to, { timeoutMs: 100, log: () => {} })).toEqual({
      kind: "reports",
      ids: new Set(["a", "b"]),
      previews: new Set(),
    });
    expect(await copyHeld(from, to)).toBe(0);
  });

  it("copies the previews too, once", async () => {
    const [from, to] = await twoDrives();
    await ensureHoldingMarker(from);
    await markHeld(from, "a");
    await markPreviewed(from, "p");
    expect(await copyHeld(from, to)).toBe(2);
    expect(await readHeld(to, { timeoutMs: 100, log: () => {} })).toEqual({
      kind: "reports",
      ids: new Set(["a"]),
      previews: new Set(["p"]),
    });
    expect(await copyHeld(from, to)).toBe(0);
  });

  it("stops at MAX_HELD entries", async () => {
    const [from, to] = await twoDrives();
    await ensureHoldingMarker(from);
    const many: Drive = {
      ...from,
      async *list(dir) {
        if (dir !== HELD_DIR) return;
        for (let i = 0; i < MAX_HELD + 5; i++) {
          yield { path: `${HELD_DIR}/p${i}`, size: 1, metadata: {} };
        }
      },
    };
    let puts = 0;
    const counting: Drive = {
      ...to,
      put: async () => {
        puts++;
      },
    };
    expect(await copyHeld(many, counting)).toBe(MAX_HELD);
    expect(puts).toBe(MAX_HELD + 1);
  });

  it("copies nothing from a silent drive", async () => {
    const [from, to] = await twoDrives();
    await from.put(`${HELD_DIR}/a`, Buffer.from("1"));
    expect(await copyHeld(from, to)).toBe(0);
    expect(await to.readSmall(HOLDING_PATH, 100)).toBeUndefined();
  });
});

describe("holdersFor", () => {
  const SELF = "s".repeat(64);
  const ADDER = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);
  const person = (key: string, name: string) => ({ key, name });
  const self = person(SELF, "Me");
  const adder = person(ADDER, "Ada");
  const ben = person(B, "Ben");
  const cy = person(C, "Cy");
  const report = (ids: string[], previews: string[]): HeldReport => ({
    kind: "reports",
    ids: new Set(ids),
    previews: new Set(previews),
  });
  const has = (...ids: string[]): HeldReport => ({
    kind: "reports",
    ids: new Set(ids),
    previews: new Set(),
  });
  const silent: HeldReport = { kind: "silent" };
  const photo = { id: "p1", driveKey: ADDER, memberName: "Ada" };

  function run(over: {
    photo?: typeof photo;
    people?: ReturnType<typeof person>[];
    held?: [string, HeldReport][];
    former?: { name: string; ids: ReadonlySet<string>; left?: true }[];
  }) {
    return holdersFor({
      photo: over.photo ?? photo,
      selfKey: SELF,
      people: over.people ?? [self, adder],
      held: new Map(over.held ?? []),
      former: over.former ?? [],
    });
  }

  it("adder only", () => {
    expect(run({ held: [[ADDER, has("p1")]] })).toEqual({
      here: false,
      others: [adder],
      unsure: [],
      waiting: [],
      previews: [],
      former: [],
      left: [],
    });
  });

  it("includes the adder even when not in people", () => {
    expect(run({ people: [self] }).others).toEqual([adder]);
  });

  it("self is the adder", () => {
    const own = { id: "p1", driveKey: SELF, memberName: "Me" };
    expect(run({ photo: own, people: [self, ben], held: [[B, has()]] })).toEqual({
      here: true,
      others: [],
      unsure: [],
      waiting: [ben],
      previews: [],
      former: [],
      left: [],
    });
  });

  it("self holds", () => {
    expect(run({ held: [[SELF, has("p1")]] }).here).toBe(true);
    expect(run({ held: [[SELF, has("other")]] }).here).toBe(false);
    expect(run({ held: [[SELF, silent]] }).here).toBe(false);
  });

  it("a person reports", () => {
    const result = run({ people: [self, adder, ben], held: [[B, has("p1")]] });
    expect(result.others).toEqual([adder, ben]);
    expect(result.unsure).toEqual([]);
  });

  it("a person who reports without the photo is waiting", () => {
    const result = run({ people: [self, adder, ben], held: [[B, has("p2")]] });
    expect(result.others).toEqual([adder]);
    expect(result.unsure).toEqual([]);
    expect(result.waiting).toEqual([ben]);
  });

  it("a person who reports only a preview is in previews, not waiting", () => {
    const result = run({ people: [self, adder, ben], held: [[B, report([], ["p1"])]] });
    expect(result.previews).toEqual([ben]);
    expect(result.waiting).toEqual([]);
    expect(result.others).toEqual([adder]);
  });

  it("a person with the full photo and its preview is only in others", () => {
    const result = run({ people: [self, adder, ben], held: [[B, report(["p1"], ["p1"])]] });
    expect(result.others).toEqual([adder, ben]);
    expect(result.previews).toEqual([]);
  });

  it("a preview of another photo does not count", () => {
    const result = run({ people: [self, adder, ben], held: [[B, report([], ["p2"])]] });
    expect(result.previews).toEqual([]);
    expect(result.waiting).toEqual([ben]);
  });

  it("a silent person is unsure, not waiting", () => {
    const result = run({ people: [self, adder, ben], held: [[B, silent]] });
    expect(result.unsure).toEqual([ben]);
    expect(result.waiting).toEqual([]);
  });

  it("the adder and self are never waiting", () => {
    const own = { id: "p1", driveKey: SELF, memberName: "Me" };
    const result = run({
      photo: own,
      people: [self, ben],
      held: [
        [SELF, has()],
        [B, has()],
      ],
    });
    expect(result.waiting).toEqual([ben]);
    const byAdder = run({
      people: [self, adder],
      held: [
        [SELF, has()],
        [ADDER, has()],
      ],
    });
    expect(byAdder.waiting).toEqual([]);
  });

  it("waiting is sorted by name then key", () => {
    const result = run({
      people: [self, adder, cy, ben],
      held: [
        [C, has()],
        [B, has()],
      ],
    });
    expect(result.waiting).toEqual([ben, cy]);
  });

  it("a silent person is unsure", () => {
    const result = run({ people: [self, adder, ben], held: [[B, silent]] });
    expect(result.others).toEqual([adder]);
    expect(result.unsure).toEqual([ben]);
  });

  it("a person with no report is unsure", () => {
    expect(run({ people: [self, adder, ben] }).unsure).toEqual([ben]);
  });

  it("the adder is never unsure", () => {
    expect(run({ held: [[ADDER, silent]] }).unsure).toEqual([]);
    expect(run({}).unsure).toEqual([]);
  });

  it("sorts by name, then key", () => {
    const ben2 = person("0".repeat(64), "Ben");
    const result = run({
      people: [self, adder, cy, ben, ben2],
      held: [
        [C, has("p1")],
        [B, has("p1")],
        ["0".repeat(64), has("p1")],
      ],
    });
    expect(result.others).toEqual([adder, ben2, ben, cy]);
    const unsure = run({ people: [self, adder, cy, ben, ben2] }).unsure;
    expect(unsure).toEqual([ben2, ben, cy]);
  });

  it("ignores a holder who is not in people", () => {
    expect(run({ held: [[B, has("p1")]] }).others).toEqual([adder]);
  });

  it("lists former names that had the photo", () => {
    const result = run({
      former: [
        { name: "Zed", ids: new Set(["p1"]) },
        { name: "Abe", ids: new Set(["p1", "p2"]) },
        { name: "Abe", ids: new Set(["p1"]) },
        { name: "Nope", ids: new Set(["p2"]) },
      ],
    });
    expect(result.former).toEqual(["Abe", "Zed"]);
    expect(result.left).toEqual([]);
  });

  it("lists a leaver apart from a removed person", () => {
    const result = run({
      former: [
        { name: "Zed", ids: new Set(["p1"]) },
        { name: "Abe", ids: new Set(["p1"]), left: true },
        { name: "Abe", ids: new Set(["p2"]) },
        { name: "Cleo", ids: new Set(["p2"]), left: true },
      ],
    });
    expect(result.former).toEqual(["Zed"]);
    expect(result.left).toEqual(["Abe"]);
  });

  it("lists the same name in both when two people share it", () => {
    const result = run({
      former: [
        { name: "Abe", ids: new Set(["p1"]) },
        { name: "Abe", ids: new Set(["p1"]), left: true },
      ],
    });
    expect(result.former).toEqual(["Abe"]);
    expect(result.left).toEqual(["Abe"]);
  });
});

describe("former people", () => {
  const ids = (...list: string[]) => new Set(list);

  it("addFormer notes a person and readFormer gives them back", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    expect(
      await addFormer(drive, { name: "Cleo", identity: "aa", ids: ids("p1", "p2") }, log),
    ).toEqual([null, true]);
    expect(await readFormer(drive, log)).toEqual([
      { name: "Cleo", identity: "aa", ids: ids("p1", "p2") },
    ]);
  });

  it("addFormer writes left only when set, and readFormer keeps only left: true", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    await addFormer(drive, { name: "Cleo", identity: "aa", ids: ids("p1"), left: true }, log);
    await addFormer(drive, { name: "Maya", identity: "bb", ids: ids("p1") }, log);
    const text = (await drive.readSmall(FORMER_PATH, 10_000))!;
    expect(text).toContain('"left":true');
    expect(text.match(/"left"/g)).toHaveLength(1);
    expect(await readFormer(drive, log)).toEqual([
      { name: "Cleo", identity: "aa", ids: ids("p1"), left: true },
      { name: "Maya", identity: "bb", ids: ids("p1") },
    ]);
    const junk = {
      version: 1,
      former: [
        { name: "A", ids: ["x"], left: "yes" },
        { name: "B", ids: ["x"], left: false },
        { name: "C", ids: ["x"], left: true },
      ],
    };
    await drive.put(FORMER_PATH, Buffer.from(JSON.stringify(junk)));
    expect((await readFormer(drive, log)).map((p) => p.left)).toEqual([undefined, undefined, true]);
  });

  it("addFormer notes nobody who had nothing", async () => {
    const [drive] = await twoDrives();
    expect(await addFormer(drive, { name: "Cleo", ids: ids() }, logger().log)).toEqual([
      null,
      false,
    ]);
    expect(await drive.readSmall(FORMER_PATH, 100)).toBeUndefined();
  });

  it("addFormer merges the same identity", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    await addFormer(drive, { name: "Cleo", identity: "aa", ids: ids("p1") }, log);
    await addFormer(drive, { name: "Cleo", identity: "aa", ids: ids("p2") }, log);
    expect(await readFormer(drive, log)).toEqual([
      { name: "Cleo", identity: "aa", ids: ids("p1", "p2") },
    ]);
  });

  it("addFormer keeps 50 people and drops the oldest first", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    for (let i = 0; i < MAX_FORMER_PEOPLE + 3; i++) {
      await addFormer(drive, { name: `P${i}`, ids: ids("p1") }, log);
    }
    const people = await readFormer(drive, log);
    expect(people).toHaveLength(MAX_FORMER_PEOPLE);
    expect(people[0].name).toBe("P3");
    expect(people.at(-1)!.name).toBe(`P${MAX_FORMER_PEOPLE + 2}`);
  });

  it("addFormer keeps at most 5,000 ids a person", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    const many = Array.from({ length: MAX_FORMER_IDS + 10 }, (_, i) => `p${i}`);
    await addFormer(drive, { name: "Cleo", ids: new Set(many) }, log);
    expect((await readFormer(drive, log))[0].ids.size).toBe(MAX_FORMER_IDS);
  });

  it("readFormer ignores version 2 and logs it", async () => {
    const [drive] = await twoDrives();
    const { events, log } = logger();
    await drive.put(
      FORMER_PATH,
      Buffer.from(JSON.stringify({ version: 2, former: [{ name: "A", ids: ["x"] }] })),
    );
    expect(await readFormer(drive, log)).toEqual([]);
    expect(events).toContain("holding.unsupported");
  });

  it("readFormer skips junk entries and unsafe ids", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    const body = {
      version: 1,
      former: [
        7,
        { name: "", ids: ["x"] },
        { name: "A", ids: "x" },
        { name: "B", ids: ["ok", "../x", 3] },
      ],
    };
    await drive.put(FORMER_PATH, Buffer.from(JSON.stringify(body)));
    expect(await readFormer(drive, log)).toEqual([{ name: "B", ids: ids("ok") }]);
    await drive.put(FORMER_PATH, Buffer.from("not json"));
    expect(await readFormer(drive, log)).toEqual([]);
  });

  it("dropFormer removes the person with that identity only", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    await addFormer(drive, { name: "Cleo", identity: "aa", ids: ids("p1") }, log);
    await addFormer(drive, { name: "Ben", identity: "bb", ids: ids("p1") }, log);
    expect(await dropFormer(drive, "aa", log)).toEqual([null, true]);
    expect((await readFormer(drive, log)).map((p) => p.name)).toEqual(["Ben"]);
    expect(await dropFormer(drive, "aa", log)).toEqual([null, false]);
  });

  it("copyFormer copies the list to the new drive", async () => {
    const [from, to] = await twoDrives();
    const { log } = logger();
    await copyFormer(from, to);
    expect(await readFormer(to, log)).toEqual([]);
    await addFormer(from, { name: "Cleo", ids: ids("p1") }, log);
    await copyFormer(from, to);
    expect(await readFormer(to, log)).toEqual([{ name: "Cleo", ids: ids("p1") }]);
  });
});

describe("markFormerLeft", () => {
  const ids = (...list: string[]) => new Set(list);
  const A1 = "a".repeat(64);
  const A0 = "b".repeat(64);
  const none: ReadonlySet<string> = new Set();

  async function seeded() {
    const [drive] = await twoDrives();
    const { log } = logger();
    await addFormer(drive, { name: "Ben", identity: "bb", ids: ids("p2"), album: A1 }, log);
    await addFormer(drive, { name: "Maya", identity: "mm", ids: ids("p1"), album: A1 }, log);
    await addFormer(drive, { name: "Old", identity: "oo", ids: ids("p3") }, log);
    return { drive, log };
  }

  it("album round-trips, and a non-hex album is dropped on read", async () => {
    const { drive, log } = await seeded();
    expect((await readFormer(drive, log)).map((p) => p.album)).toEqual([A1, A1, undefined]);
    await drive.put(
      FORMER_PATH,
      Buffer.from(
        JSON.stringify({ version: 1, former: [{ name: "X", ids: ["p1"], album: "nope" }] }),
      ),
    );
    expect(await readFormer(drive, log)).toEqual([{ name: "X", ids: ids("p1") }]);
  });

  it("marks only the matching entry and leaves the others as they were", async () => {
    const { drive, log } = await seeded();
    const before = JSON.parse((await drive.readSmall(FORMER_PATH, 1_000_000))!);
    expect(await markFormerLeft(drive, { identity: "mm", album: A1, current: none }, log)).toEqual([
      null,
      "marked",
    ]);
    const after = JSON.parse((await drive.readSmall(FORMER_PATH, 1_000_000))!);
    expect(after.former[1]).toEqual({ ...before.former[1], left: true });
    expect([after.former[0], after.former[2]]).toEqual([before.former[0], before.former[2]]);
  });

  it("finds no entry for a wrong album, a wrong identity or an entry without album", async () => {
    const { drive, log } = await seeded();
    const text = await drive.readSmall(FORMER_PATH, 1_000_000);
    for (const input of [
      { identity: "mm", album: A0 },
      { identity: "zz", album: A1 },
      { identity: "oo", album: A1 },
    ]) {
      expect(await markFormerLeft(drive, { ...input, current: none }, log)).toEqual([
        null,
        "no-entry",
      ]);
    }
    expect(await drive.readSmall(FORMER_PATH, 1_000_000)).toBe(text);
  });

  it("says already-left the second time and writes nothing", async () => {
    const { drive, log } = await seeded();
    await markFormerLeft(drive, { identity: "mm", album: A1, current: none }, log);
    const text = await drive.readSmall(FORMER_PATH, 1_000_000);
    expect(await markFormerLeft(drive, { identity: "mm", album: A1, current: none }, log)).toEqual([
      null,
      "already-left",
    ]);
    expect(await drive.readSmall(FORMER_PATH, 1_000_000)).toBe(text);
  });

  it("says in-album for someone back in the album and writes nothing", async () => {
    const { drive, log } = await seeded();
    const text = await drive.readSmall(FORMER_PATH, 1_000_000);
    const current = new Set(["mm"]);
    expect(await markFormerLeft(drive, { identity: "mm", album: A1, current }, log)).toEqual([
      null,
      "in-album",
    ]);
    expect(await drive.readSmall(FORMER_PATH, 1_000_000)).toBe(text);
  });

  it("returns the error and writes nothing when the list cannot be read", async () => {
    const { drive, log } = await seeded();
    const text = await drive.readSmall(FORMER_PATH, 1_000_000);
    const read = drive.readSmall.bind(drive);
    drive.readSmall = async () => {
      throw new Error("timeout");
    };
    const [err] = await markFormerLeft(drive, { identity: "mm", album: A1, current: none }, log);
    expect(err?.kind).toBe("write-failed");
    drive.readSmall = read;
    expect(await drive.readSmall(FORMER_PATH, 1_000_000)).toBe(text);
  });
});

describe("former people when the list cannot be read", () => {
  const ids = (...list: string[]) => new Set(list);

  async function unreadable() {
    const [drive] = await twoDrives();
    const { log } = logger();
    await addFormer(drive, { name: "Cleo", identity: "aa", ids: ids("p1") }, log);
    await addFormer(drive, { name: "Ben", identity: "bb", ids: ids("p2") }, log);
    const read = drive.readSmall.bind(drive);
    return { drive, log, read };
  }

  it("addFormer keeps the earlier people when the read fails", async () => {
    const { drive, log, read } = await unreadable();
    drive.readSmall = async () => {
      throw new Error("timeout");
    };
    const [err] = await addFormer(drive, { name: "Dan", identity: "dd", ids: ids("p3") }, log);
    expect(err?.kind).toBe("write-failed");
    drive.readSmall = read;
    expect((await readFormer(drive, log)).map((p) => p.name)).toEqual(["Cleo", "Ben"]);
  });

  it("dropFormer keeps the earlier people when the read fails", async () => {
    const { drive, log, read } = await unreadable();
    drive.readSmall = async () => {
      throw new Error("timeout");
    };
    const [err] = await dropFormer(drive, "aa", log);
    expect(err?.kind).toBe("write-failed");
    drive.readSmall = read;
    expect((await readFormer(drive, log)).map((p) => p.name)).toEqual(["Cleo", "Ben"]);
  });

  it("addFormer leaves a list of a newer version alone", async () => {
    const [drive] = await twoDrives();
    const { log } = logger();
    const newer = JSON.stringify({ version: 2, former: [{ name: "A", ids: ["x"] }] });
    await drive.put(FORMER_PATH, Buffer.from(newer));
    const [err] = await addFormer(drive, { name: "Dan", ids: ids("p3") }, log);
    expect(err?.kind).toBe("write-failed");
    expect(await drive.readSmall(FORMER_PATH, 1_000_000)).toBe(newer);
  });
});
