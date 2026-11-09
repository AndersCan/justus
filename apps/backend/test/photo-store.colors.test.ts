/** The Admin's phone gives each person one colour seat and every phone reports the same one. */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  return { node, deps, store: createPhotoStore(deps) };
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

  it("does not hand a Viewer's seat to the next Collaborator", async () => {
    const s = await album();
    expect((await s.admin.store.makeViewer(s.folderId, s.keys.ben))[0]).toBeNull();
    const dee = phone(s.hub, "Dee");
    await dee.store.ready();
    const deeKey = await joinAsMember(s.admin.store, s.folderId, dee.store, s.shareKey);
    expect((await seats(s.admin))[deeKey]).toBe(4);
    await dee.store.close();
    await s.close();
  });

  it("frees a seat when a person leaves: the next accept takes it and the others keep theirs", async () => {
    const s = await album();
    const benFolder = (await s.ben.store.folders()).folders[0]!;
    expect((await s.ben.store.leaveAlbum(benFolder.id))[0]).toBeNull();
    await until(
      async () => !((await seats(s.admin)) as object as Record<string, unknown>)[s.keys.ben],
    );
    const dee = phone(s.hub, "Dee");
    await dee.store.ready();
    const deeKey = await joinAsMember(s.admin.store, s.folderId, dee.store, s.shareKey);
    expect(await seats(s.admin)).toEqual({
      admin: 0,
      [s.keys.nils]: 1,
      [deeKey]: 2,
      [s.keys.vera]: 3,
    });
    await dee.store.close();
    await s.close();
  });

  it("fills a Viewer's seat on boot, writes /viewers.json and tells the screen", async () => {
    const s = await album();
    expect((await s.admin.store.makeViewer(s.folderId, s.keys.ben))[0]).toBeNull();
    const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    let [, drive] = await s.admin.deps.drives.open(folder.driveKey, { timeoutMs: 1_000 });
    const read = async (path: string) =>
      JSON.parse(Buffer.from((await drive!.readSmall(path, 1 << 20))!).toString());
    const viewers = await read("/viewers.json");
    delete viewers.viewers[s.keys.ben].color;
    await drive!.put("/viewers.json", Buffer.from(JSON.stringify(viewers)));
    await s.admin.store.close();

    const deps2 = restarted(s.admin.deps);
    const pushed: unknown[] = [];
    deps2.onChanged = (e: unknown) => void pushed.push(e);
    const again = createPhotoStore(deps2);
    await again.ready();
    [, drive] = await deps2.drives.open(folder.driveKey, { timeoutMs: 1_000 });
    await until(async () => (await read("/viewers.json")).viewers[s.keys.ben].color === 2);
    expect((await read("/viewers.json")).viewers[s.keys.ben].color).toBe(2);
    await sleep(300);
    const filledPushes = pushed.length;
    expect((await seats({ store: again } as P))[s.keys.ben]).toBe(2);
    // The filled seat is the one the next person is kept away from.
    const key = "ab".repeat(32);
    expect((await again.enroll(key, "Dee"))[0]).toBeNull();
    expect((await seats({ store: again } as P))[key]).toBe(4);
    await again.close();

    // A boot with nothing to fill pushes fewer changes: the fill told the screen.
    const deps3 = restarted(deps2);
    let quietPushes = 0;
    deps3.onChanged = () => void quietPushes++;
    const quiet = createPhotoStore(deps3);
    await quiet.ready();
    await sleep(300);
    // The fill pushes twice: once from the refresh after the write, once of its own.
    expect(filledPushes).toBeGreaterThanOrEqual(quietPushes + 2);
    await quiet.close();
    await s.nils.store.close();
    await s.ben.store.close();
    await s.vera.store.close();
  });

  it("does not give a person added by key a Viewer's seat", async () => {
    const s = await album();
    expect((await s.admin.store.makeViewer(s.folderId, s.keys.ben))[0]).toBeNull();
    const key = "ab".repeat(32);
    expect((await s.admin.store.enroll(key, "Dee"))[0]).toBeNull();
    expect((await seats(s.admin))[key]).toBe(4);
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
    // Joins can land in the same millisecond: give them a fixed order.
    const order = [s.keys.nils, s.keys.ben, s.keys.vera];
    for (const m of Object.values(members.members) as {
      key: string;
      addedAt: number;
      color?: number;
    }[]) {
      delete m.color;
      m.addedAt = 1000 + order.indexOf(m.key);
    }
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

const identityOf = (p: P) => (p.store.debugState() as { identityDrive: string }).identityDrive;

/** Their phone asks through the new invite code, then restarts, as after a Remove. */
async function follow(s: Awaited<ReturnType<typeof album>>, who: P) {
  const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
  const asked = await who.store.ask({
    code: folder.invite!.code,
    owner: identityOf(s.admin),
    albumName: "Trip",
    ownerName: "Anna",
  });
  expect(asked[0]).toBeNull();
  await who.store.close();
  const again = createPhotoStore(restarted(who.deps));
  await again.ready();
  return again;
}

const savedRecord = (s: Awaited<ReturnType<typeof album>>) =>
  JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8")).folders.find(
    (f: { id: string }) => f.id === s.folderId,
  );

describe("colour seats through a Remove", () => {
  it("lists the people who stay with their seats before and after they follow", async () => {
    const s = await album();
    const nilsId = identityOf(s.nils);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(await seats(s.admin)).toEqual({ admin: 0, [s.keys.nils]: 1, [s.keys.vera]: 3 });
    const again = await follow(s, s.nils);
    await until(() => !savedRecord(s).moving?.[nilsId]);
    expect(savedRecord(s).moving?.[nilsId]).toBeUndefined();
    const after = await seats(s.admin);
    expect(Object.values(after).sort()).toEqual([0, 1, 3]);
    const nilsNow = (await s.admin.store.status()).members.find(
      (m: { name: string }) => m.name === "Nils",
    );
    expect(nilsNow.color).toBe(1);
    // Vera follows after Nils holds seat 1 in the new list, so her own seat is not "lowest free".
    const veraId = identityOf(s.vera);
    const veraAgain = await follow(s, s.vera);
    await until(() => !savedRecord(s).moving?.[veraId]);
    const veraNow = (await s.admin.store.status()).members.find(
      (m: { name: string }) => m.name === "Vera",
    );
    expect(veraNow.color).toBe(3);
    await again.close();
    await veraAgain.close();
    await s.admin.store.close();
    await s.ben.store.close();
  }, 20_000);

  it("keeps a moving person's seat away from a newcomer", async () => {
    const s = await album();
    const nilsId = identityOf(s.nils);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(savedRecord(s).moving[nilsId].color).toBe(1);
    const dee = phone(s.hub, "Dee");
    await dee.store.ready();
    const deeKey = await joinAsMember(s.admin.store, s.folderId, dee.store, s.shareKey);
    expect((await seats(s.admin))[deeKey]).toBe(2);
    await dee.store.close();
    await s.close();
  }, 20_000);

  it("keeps a seat when the Admin's phone restarts while the person is still moving", async () => {
    const s = await album();
    const veraId = identityOf(s.vera);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    await s.admin.store.close();
    const deps2 = restarted(s.admin.deps);
    const admin2 = createPhotoStore(deps2);
    await admin2.ready();
    const listed = (await admin2.status()).members as { key: string; color?: number }[];
    expect(listed.find((m) => m.key === s.keys.vera)?.color).toBe(3);
    const vera2 = await follow({ ...s, admin: { ...s.admin, store: admin2, deps: deps2 } }, s.vera);
    await until(() => !savedRecord(s).moving?.[veraId]);
    const veraNow = (await admin2.status()).members.find(
      (m: { name: string }) => m.name === "Vera",
    );
    expect(veraNow.color).toBe(3);
    await vera2.close();
    await admin2.close();
    for (const p of [s.nils, s.ben]) await p.store.close();
  }, 20_000);

  it("keeps a Viewer's seat through the follow", async () => {
    const s = await album();
    const veraId = identityOf(s.vera);
    expect((await s.admin.store.makeViewer(s.folderId, s.keys.vera))[0]).toBeNull();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(savedRecord(s).moving[veraId]).toMatchObject({ role: "reader", color: 3 });
    const again = await follow(s, s.vera);
    await until(() => !savedRecord(s).moving?.[veraId]);
    const veraNow = (await s.admin.store.status()).members.find(
      (m: { name: string }) => m.name === "Vera",
    );
    expect(veraNow.color).toBe(3);
    await again.close();
    for (const p of [s.admin, s.nils, s.ben]) await p.store.close();
  }, 20_000);

  it("parses a bad saved seat as absent", async () => {
    const s = await album();
    const nilsId = identityOf(s.nils);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    await s.admin.store.close();
    const path = join(s.admin.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const folder = saved.folders.find((f: { id: string }) => f.id === s.folderId);
    folder.moving[nilsId].color = 1.5;
    writeFileSync(path, JSON.stringify(saved));
    const admin2 = createPhotoStore(restarted(s.admin.deps));
    await admin2.ready();
    const nilsNow = (await admin2.status()).members.find(
      (m: { key: string }) => m.key === s.keys.nils,
    );
    expect(nilsNow.color).toBeUndefined();
    await admin2.close();
    for (const p of [s.nils, s.ben, s.vera]) await p.store.close();
  }, 20_000);
});

describe("colour seats of someone not known at the Remove", () => {
  it("keeps their seat in the waiting list and when the Admin's phone learns who they are", async () => {
    const hub = createFakeHub();
    const admin = phone(hub, "Anna");
    const nils = phone(hub, "Nils");
    const ben = phone(hub, "Ben");
    for (const p of [admin, nils, ben]) await p.store.ready();
    const target = identityOf(nils);
    let blocked = true;
    const block = (deps: typeof admin.deps) => {
      const real = deps.drives.verifyIdentity.bind(deps.drives);
      deps.drives.verifyIdentity = (proof: Parameters<typeof real>[0]) =>
        blocked && proof.identityKey === target ? false : real(proof);
    };
    block(admin.deps);
    const created = await admin.store.createFolder("Trip");
    const folderId = created[1]!.folder.id;
    const shareKey = created[1]!.folder.shareKey;
    const nilsKey = await joinAsMember(admin.store, folderId, nils.store, shareKey);
    const benKey = await joinAsMember(admin.store, folderId, ben.store, shareKey);
    await until(async () => (await admin.store.status()).members.length === 3);
    await admin.store.removeMember(folderId, benKey);
    const record = () =>
      JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8")).folders.find(
        (f: { id: string }) => f.id === folderId,
      );
    expect(record().movingUnknown[nilsKey].color).toBe(1);
    expect(
      ((await admin.store.status()).members as { key: string; color?: number }[]).find(
        (m) => m.key === nilsKey,
      )?.color,
    ).toBe(1);
    // The waiting entry's seat survives a restart of the Admin's phone.
    await admin.store.close();
    const deps2 = restarted(admin.deps);
    block(deps2);
    const admin2 = createPhotoStore(deps2);
    await admin2.ready();
    expect(
      ((await admin2.status()).members as { key: string; color?: number }[]).find(
        (m) => m.key === nilsKey,
      )?.color,
    ).toBe(1);
    // A newcomer is kept away from the waiting person's seat.
    const dee = phone(hub, "Dee");
    await dee.store.ready();
    const deeKey = await joinAsMember(admin2, folderId, dee.store, shareKey);
    expect(
      ((await admin2.status()).members as { key: string; color?: number }[]).find(
        (m) => m.key === deeKey,
      )?.color,
    ).toBe(2);
    await dee.store.close();
    blocked = false;
    setFakeNodeConnected({ hub, node: nils.node, connected: false });
    await sleep(50);
    setFakeNodeConnected({ hub, node: nils.node, connected: true });
    await until(() => record().moving?.[target] !== undefined, 6_000);
    expect(record().moving[target].color).toBe(1);
    for (const p of [nils, ben]) await p.store.close();
    await admin2.close();
  }, 20_000);
});
