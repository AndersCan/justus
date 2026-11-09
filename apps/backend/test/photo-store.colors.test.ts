/** The Admin's phone gives each person one colour seat and every phone reports the same one. */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(done: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const server = new FakeLoopbackServer();
  const deps = fakeStoreDeps({ hub, node, deviceName, server });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, store: createPhotoStore(deps) };
}

type P = ReturnType<typeof phone>;
/** Seat by person: "admin" or the joiner's drive key. */
const seats = async (p: P) =>
  Object.fromEntries(
    (await p.store.status()).members.map((m: { key: string; admin: boolean; color?: number }) => [
      m.admin ? "admin" : m.key,
      m.color,
    ]),
  );

async function album() {
  const hub = createFakeHub();
  const admin = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  const ben = phone(hub, "Ben");
  const vera = phone(hub, "Vera");
  for (const p of [admin, nils, ben, vera]) await p.store.ready();
  const created = await admin.store.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const keys: Record<string, string> = {};
  for (const [name, p] of [
    ["nils", nils],
    ["ben", ben],
    ["vera", vera],
  ] as const) {
    keys[name] = await joinAsMember(admin.store, folderId, p.store, shareKey);
  }
  // Names reach the Admin's phone with each person's device record.
  await until(async () => {
    const m = (await admin.store.status()).members;
    return m.length === 4 && m.every((x: { identity?: string }) => x.identity !== undefined);
  });
  const close = async () => {
    for (const p of [admin, nils, ben, vera]) await p.store.close();
  };
  return { hub, admin, nils, ben, vera, folderId, shareKey, keys, close };
}

describe("colour seats", () => {
  it("gives the Admin 0 and each person the lowest free seat in the order they joined", async () => {
    const s = await album();
    expect(await seats(s.admin)).toEqual({
      admin: 0,
      [s.keys.nils]: 1,
      [s.keys.ben]: 2,
      [s.keys.vera]: 3,
    });
    await s.close();
  });

  it("shows the same seats on a Collaborator's phone", async () => {
    const s = await album();
    const want = { admin: 0, [s.keys.nils]: 1, [s.keys.ben]: 2, [s.keys.vera]: 3 };
    await until(async () => JSON.stringify(await seats(s.ben)) === JSON.stringify(want));
    expect(await seats(s.ben)).toMatchObject({ admin: 0, [s.keys.nils]: 1, [s.keys.vera]: 3 });
    expect((await seats(s.ben))[s.keys.ben]).toBe(2);
    await s.close();
  });

  it("keeps a seat through Make Viewer and Make Collaborator, and a newcomer gets the next one", async () => {
    const s = await album();
    expect((await s.admin.store.makeViewer(s.folderId, s.keys.ben))[0]).toBeNull();
    expect((await seats(s.admin))[s.keys.ben]).toBe(2);
    expect((await s.admin.store.makeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    expect((await seats(s.admin))[s.keys.ben]).toBe(2);
    const dee = phone(s.hub, "Dee");
    await dee.store.ready();
    const deeKey = await joinAsMember(s.admin.store, s.folderId, dee.store, s.shareKey);
    expect((await seats(s.admin))[deeKey]).toBe(4);
    await dee.store.close();
    await s.close();
  });

  it("gives a person added by key the lowest free seat", async () => {
    const s = await album();
    const key = "ab".repeat(32);
    expect((await s.admin.store.enroll(key, "Dee"))[0]).toBeNull();
    expect((await seats(s.admin))[key]).toBe(4);
    await s.close();
  });

  it("fills seats once for an album from before seats, and writes nothing the second time", async () => {
    const s = await album();
    const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const [, drive] = await s.admin.deps.drives.open(folder.driveKey, { timeoutMs: 1_000 });
    const read = async (d: Drive) =>
      JSON.parse(Buffer.from((await d.readSmall("/members.json", 1 << 20))!).toString());
    const members = await read(drive!);
    for (const m of Object.values(members.members) as { color?: number }[]) delete m.color;
    await drive!.put("/members.json", Buffer.from(JSON.stringify(members)));
    await s.admin.store.close();

    const deps2 = restarted(s.admin.deps);
    const again = createPhotoStore(deps2);
    await again.ready();
    const [, drive2] = await deps2.drives.open(folder.driveKey, { timeoutMs: 1_000 });
    await until(async () => (await read(drive2!)).members[s.keys.vera].color === 3);
    const filled = await read(drive2!);
    expect(
      Object.fromEntries(
        Object.values(filled.members as Record<string, { key: string; color: number }>).map((m) => [
          m.key,
          m.color,
        ]),
      ),
    ).toEqual({ [s.keys.nils]: 1, [s.keys.ben]: 2, [s.keys.vera]: 3 });
    await again.close();

    // A restart with every seat filled writes neither list.
    const deps3 = restarted(deps2);
    const writes: string[] = [];
    const watch = (drive: Drive) => {
      const put = drive.put.bind(drive);
      drive.put = async (path: string, bytes: Uint8Array) => {
        writes.push(path);
        return put(path, bytes);
      };
      return drive;
    };
    const realOpen = deps3.drives.open.bind(deps3.drives);
    deps3.drives.open = async (key: string, opts: { timeoutMs: number }) => {
      const [openErr, drive] = await realOpen(key, opts);
      return openErr ? [openErr, null] : [null, watch(drive)];
    };
    const realOwn = deps3.drives.openOwn.bind(deps3.drives);
    deps3.drives.openOwn = async (namespace?: string) => watch(await realOwn(namespace));
    const third = createPhotoStore(deps3);
    await third.ready();
    await sleep(300);
    expect(writes).toContain("/device.json");
    expect(writes.filter((p) => p === "/members.json" || p === "/viewers.json")).toEqual([]);
    await third.close();
    await s.nils.store.close();
    await s.ben.store.close();
    await s.vera.store.close();
  });
});
