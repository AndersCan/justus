/** A phone that follows a Remove clears only the old drives the new album stops reading. */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { FakeLoopbackServer, fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(done: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}
type Log = { event: string; fields: Record<string, unknown> };
function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string, logs: Log[] = []) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  deps.log = (e: Log) => logs.push(e);
  return { deps, node, logs, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;
const identityOf = (p: Phone) => (p.store.debugState() as { identityDrive: string }).identityDrive;

/** Nils's new drive (the ask drive) gets none of his photos, so the Admin keeps his old drive. */
function copyNothing(p: Phone) {
  const drives = p.deps.drives;
  const real = drives.openOwn.bind(drives);
  drives.openOwn = (async (ns: string) => {
    const drive = await real(ns);
    if (!ns.startsWith("ask/")) return drive;
    return new Proxy(drive, {
      get(target, prop, receiver) {
        if (prop !== "put") return Reflect.get(target, prop, receiver);
        return (path: string, ...rest: unknown[]) =>
          path.startsWith("/photos/")
            ? Promise.resolve()
            : (target.put as (...a: unknown[]) => unknown)(path, ...rest);
      },
    });
  }) as typeof drives.openOwn;
}

describe("following a second Remove", () => {
  it("keeps a drive the new album still lists", async () => {
    const hub = createFakeHub();
    const admin = phone(hub, "Anna");
    let vera = phone(hub, "Vera");
    const people = {
      nils: phone(hub, "Nils"),
      vera,
      ben: phone(hub, "Ben"),
      dan: phone(hub, "Dan"),
    };
    for (const p of [admin, ...Object.values(people)]) await p.store.ready();
    const created = await admin.store.createFolder("Trip");
    const { id: folderId, invite } = created[1]!.folder;
    const keys: Record<string, string> = {};
    const ids: Record<string, string> = {};
    for (const [name, role] of [
      ["nils", "member"],
      ["vera", "member"],
      ["ben", "reader"],
      ["dan", "reader"],
    ] as const) {
      const who = people[name];
      await who.store.ask({ code: invite!.code, owner: identityOf(admin) });
      let requesterKey = "";
      await until(async () => {
        requesterKey = (await admin.store.requests()).requests[0]?.requesterKey ?? "";
        return requesterKey !== "";
      });
      keys[name] = requesterKey;
      expect((await admin.store.respond(folderId, requesterKey, true, role))[0]).toBeNull();
      await until(async () => (await who.store.folders()).folders.length === 1);
      ids[name] = (await who.store.folders()).folders[0]!.id;
    }
    const record = () =>
      JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8")).folders.find(
        (f: { id: string }) => f.id === folderId,
      );
    const shareOn = async (p: Phone, id: string) =>
      (await p.store.folders()).folders.find((f) => f.id === id)?.shareKey;
    copyNothing(people.nils);
    await people.nils.store.addBytes("mine.jpg", new Uint8Array([5, 5, 5]), ids.nils);
    await until(async () => (await admin.store.list({ all: true })).length === 1);
    expect((await admin.store.removeMember(folderId, keys.ben))[0]).toBeNull();
    const first = record().shareKey;
    await until(async () => (await shareOn(vera, ids.vera)) === first, 15_000);
    await until(async () => (await shareOn(people.dan, ids.dan)) === first, 15_000);
    // Vera reads Nils's old drive as an earlier one: the album still shows mine.jpg from it.
    await until(() => JSON.stringify(record().earlier ?? []).includes(keys.nils), 15_000);
    await sleep(2_000);
    expect(JSON.stringify(record().earlier ?? [])).toContain(keys.nils);

    // Vera's saved list also names her own old drive and a drive she keeps at a fixed version:
    // neither is hers to clear.
    await vera.store.close();
    const file = join(vera.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const mine = saved.folders[0];
    expect(mine.formerSelf).toHaveLength(1);
    mine.earlier = [
      ...(mine.earlier ?? []),
      { key: mine.formerSelf[0], name: "Vera" },
      { key: keys.ben, name: "Ben", keptVersion: 0 },
    ];
    writeFileSync(file, JSON.stringify(saved));
    const logs: Log[] = [];
    vera = { ...vera, logs, deps: restarted(vera.deps) };
    vera.deps.log = (e: Log) => logs.push(e);
    vera.store = createPhotoStore(vera.deps);
    await vera.store.ready();
    const veraOld = [mine.formerSelf[0] as string, keys.ben];

    let danKey = "";
    await until(async () => {
      const rows = (await admin.store.status()).members as {
        name?: string;
        key?: string;
        driveKey?: string;
        moving?: boolean;
      }[];
      const row = rows.find((m) => m.name === "Dan");
      danKey = row?.key ?? row?.driveKey ?? "";

      return danKey !== "" && danKey !== keys.dan;
    }, 15_000);
    expect((await admin.store.removeMember(folderId, danKey))[0]).toBeNull();
    const second = record().shareKey;
    expect(second).not.toBe(first);
    await until(async () => (await shareOn(vera, ids.vera)) === second, 15_000);
    expect(JSON.stringify(record().earlier ?? [])).toContain(keys.nils);
    await sleep(8_000);
    const clearedNils = vera.logs.filter(
      (e) =>
        e.event === "move.cleared" &&
        e.fields.why === "followed" &&
        e.fields.drive === keys.nils.slice(0, 8),
    );
    expect(clearedNils).toEqual([]);
    const clearedKept = vera.logs.filter(
      (e) => e.event === "move.cleared" && veraOld.some((k) => e.fields.drive === k.slice(0, 8)),
    );
    expect(clearedKept).toEqual([]);
    for (const p of [admin, ...Object.values(people), vera]) await p.store.close().catch(() => {});
  }, 90_000);
});
