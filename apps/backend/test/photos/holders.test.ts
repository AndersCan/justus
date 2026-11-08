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
  copyHeld,
  ensureHoldingMarker,
  heldPath,
  holdersFor,
  markHeld,
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
    });
  });

  it("reports an empty list when the marker has no entries", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    expect(await readHeld(drive, { timeoutMs: 100, log: () => {} })).toEqual({
      kind: "reports",
      ids: new Set(),
    });
  });

  it("cuts the list at MAX_HELD", async () => {
    const [drive] = await twoDrives();
    await ensureHoldingMarker(drive);
    const many: Drive = {
      ...drive,
      async *list() {
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
    });
    expect(await copyHeld(from, to)).toBe(0);
  });

  it("stops at MAX_HELD entries", async () => {
    const [from, to] = await twoDrives();
    await ensureHoldingMarker(from);
    const many: Drive = {
      ...from,
      async *list() {
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
  const has = (...ids: string[]): HeldReport => ({ kind: "reports", ids: new Set(ids) });
  const silent: HeldReport = { kind: "silent" };
  const photo = { id: "p1", driveKey: ADDER, memberName: "Ada" };

  function run(over: {
    photo?: typeof photo;
    people?: ReturnType<typeof person>[];
    held?: [string, HeldReport][];
    former?: { name: string; ids: ReadonlySet<string> }[];
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
      former: [],
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
      former: [],
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

  it("a reporting person without the photo is neither", () => {
    const result = run({ people: [self, adder, ben], held: [[B, has("p2")]] });
    expect(result.others).toEqual([adder]);
    expect(result.unsure).toEqual([]);
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
  });
});
