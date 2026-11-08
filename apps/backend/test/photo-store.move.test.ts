/**
 * Remove moves the album on the Admin's phone: a new key, a new invite code,
 * and everyone who stays is told to follow. Phones on the checked fakes share
 * one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember, restarted } from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(done: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 20) await sleep(20);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, store: createPhotoStore(deps) };
}

const identityOf = (s: { store: { debugState(): unknown } }) =>
  (s.store.debugState() as { identityDrive: string }).identityDrive;

/** Anna's album with Nils and Ben as Collaborators and Vera as a Viewer. */
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
  expect((await admin.store.makeViewer(folderId, keys.vera))[0]).toBeNull();
  await until(async () => {
    const m = (await admin.store.status()).members;
    return m.length === 4 && m.every((x: { identity?: string }) => x.identity !== undefined);
  });
  const saved = () => JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8"));
  const record = () => saved().folders.find((f: { id: string }) => f.id === folderId);
  const close = async () => {
    for (const p of [admin, nils, ben, vera]) await p.store.close();
  };
  return { hub, admin, nils, ben, vera, folderId, shareKey, keys, saved, record, close };
}

describe("Remove moves the album", () => {
  it("removing a Collaborator gives the album a new key and a new invite code", async () => {
    const s = await album();
    const before = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const [error] = await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(error).toBeNull();
    const after = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    expect(after.shareKey).not.toBe(before.shareKey);
    expect(after.invite!.code).not.toBe(before.invite!.code);
    const record = s.record();
    expect(record.shareKey).toBe(after.shareKey);
    expect(record.pastKeys).toEqual([before.shareKey]);
    expect(record.moves).toBe(1);
    expect(record.retiredInvites).toContain(before.invite!.code);
    await s.close();
  });

  it("removing a Viewer moves the album too", async () => {
    const s = await album();
    const before = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const [error] = await s.admin.store.removeMember(s.folderId, s.keys.vera);
    expect(error).toBeNull();
    const after = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    expect(after.shareKey).not.toBe(before.shareKey);
    const members = (await s.admin.store.status()).members;
    expect(members.some((m: { key: string }) => m.key === s.keys.vera)).toBe(false);
    await s.close();
  });

  it("lists everyone who stays as moving, with their role, until they arrive", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const moving = s.record().moving as Record<string, { role: string; key: string }>;
    const rows = Object.values(moving).map((m) => [m.key, m.role]);
    expect(rows).toContainEqual([s.keys.nils, "member"]);
    expect(rows).toContainEqual([s.keys.vera, "reader"]);
    expect(rows.some(([key]) => key === s.keys.ben)).toBe(false);
    const status = (await s.admin.store.status()).members;
    expect(
      status.find((m: { key: string; viewer?: boolean }) => m.key === s.keys.nils)?.viewer,
    ).toBeUndefined();
    expect(
      status.find((m: { key: string; viewer?: boolean }) => m.key === s.keys.vera)?.viewer,
    ).toBe(true);
    expect(status.some((m: { key: string; viewer?: boolean }) => m.key === s.keys.ben)).toBe(false);
    await s.close();
  });

  it("never owes the removed person the new key", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const record = s.record();
    const answers = (record.answers ?? {}) as Record<string, string>;
    const movingIdentities = new Set(Object.keys(record.moving));
    expect(identityOf(s.ben)).not.toBe(identityOf(s.admin));
    expect(movingIdentities.has(identityOf(s.ben))).toBe(false);
    for (const [identity, answer] of Object.entries(answers)) {
      if (answer === "accepted") expect(movingIdentities.has(identity)).toBe(true);
    }
    expect(answers[identityOf(s.ben)]).toBeUndefined();
    await s.close();
  });

  it("refuses to remove yourself or a stranger", async () => {
    const s = await album();
    const own = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    expect((await s.admin.store.removeMember(s.folderId, own.driveKey))[0]!.code).toBe(
      PhotoError.INVALID_KEY,
    );
    expect((await s.admin.store.removeMember(s.folderId, "e".repeat(64)))[0]!.code).toBe(
      PhotoError.NOT_FOUND,
    );
    expect(s.record().moves).toBeUndefined();
    await s.close();
  });

  it("a second Remove keeps people who have not moved, and both old keys", async () => {
    const s = await album();
    const first = s.record().shareKey;
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const second = s.record().shareKey;
    await s.admin.store.removeMember(s.folderId, s.keys.nils);
    const record = s.record();
    expect(record.pastKeys).toEqual([second, first]);
    expect(record.moves).toBe(2);
    const keys = Object.values(record.moving as Record<string, { key: string }>).map((m) => m.key);
    expect(keys).toContain(s.keys.vera);
    expect(keys).not.toContain(s.keys.nils);
    await s.close();
  });

  it("removing someone who has not moved yet removes them from the list", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const [error] = await s.admin.store.removeMember(s.folderId, s.keys.nils);
    expect(error).toBeNull();
    expect(
      (await s.admin.store.status()).members.some((m: { key: string }) => m.key === s.keys.nils),
    ).toBe(false);
    await s.close();
  });

  it("keeps moving and the old keys across a restart", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const expected = s.record();
    await s.admin.store.close();
    const again = createPhotoStore(restarted(s.admin.deps));
    await again.ready();
    const record = s.record();
    expect(record.moving).toEqual(expected.moving);
    expect(record.pastKeys).toEqual(expected.pastKeys);
    expect((await again.folders()).folders.find((f) => f.id === s.folderId)!.shareKey).toBe(
      expected.shareKey,
    );
    expect((await again.status()).members.some((m: { key: string }) => m.key === s.keys.nils)).toBe(
      true,
    );
    await again.close();
    for (const p of [s.nils, s.ben, s.vera]) await p.store.close();
  });
});

describe("someone who is moving asks through the new code", () => {
  /** Their phone asks through the new invite code, then reconnects, as after a restart. */
  async function follow(s: Awaited<ReturnType<typeof album>>, who: typeof s.nils, name: string) {
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
    expect(name).toBeTruthy();
    return again;
  }

  it("seats a Collaborator with their role and takes them off the moving list", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const nilsIdentity = identityOf(s.nils);
    expect(s.record().moving[nilsIdentity]).toBeDefined();
    const again = await follow(s, s.nils, "Nils");
    await until(() => !s.record().moving?.[nilsIdentity]);
    expect(s.record().moving?.[nilsIdentity]).toBeUndefined();
    const registry = JSON.parse(
      (await (
        await s.admin.deps.drives.open(s.record().shareKey, { timeoutMs: 1000 })
      )[1]!.readSmall("/members.json", 1 << 20)) ?? "{}",
    );
    expect(Object.keys(registry.members)).toHaveLength(1);
    expect(s.record().answers[nilsIdentity]).toBe("accepted");
    await again.close();
    await s.close();
  });

  it("seats a Viewer as a Viewer", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const veraIdentity = identityOf(s.vera);
    const again = await follow(s, s.vera, "Vera");
    await until(() => !s.record().moving?.[veraIdentity]);
    expect(s.record().moving?.[veraIdentity]).toBeUndefined();
    const drive = (await s.admin.deps.drives.open(s.record().shareKey, { timeoutMs: 1000 }))[1]!;
    const viewers = JSON.parse((await drive.readSmall("/viewers.json", 1 << 20)) ?? "{}");
    expect(Object.keys(viewers.viewers)).toHaveLength(1);
    const members = JSON.parse((await drive.readSmall("/members.json", 1 << 20)) ?? "{}");
    expect(Object.keys(members.members)).toHaveLength(0);
    await again.close();
    await s.close();
  });
});

describe("someone who asked through the invite and is removed", () => {
  it("is no longer owed an answer, so the new key never reaches them", async () => {
    const s = await album();
    const carl = phone(s.hub, "Carl");
    await carl.store.ready();
    const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    expect(
      (
        await carl.store.ask({
          code: folder.invite!.code,
          owner: identityOf(s.admin),
          albumName: "Trip",
          ownerName: "Anna",
        })
      )[0],
    ).toBeNull();
    let requesterKey = "";
    await until(async () => {
      requesterKey = (await s.admin.store.requests()).requests[0]?.requesterKey ?? "";
      return requesterKey !== "";
    });
    expect((await s.admin.store.respond(s.folderId, requesterKey, true))[0]).toBeNull();
    expect(s.record().answers[identityOf(carl)]).toBe("accepted");

    expect((await s.admin.store.removeMember(s.folderId, requesterKey))[0]).toBeNull();
    const answers = s.record().answers as Record<string, string>;
    expect(answers[identityOf(carl)]).toBeUndefined();
    expect(s.record().moving[identityOf(carl)]).toBeUndefined();
    await carl.store.close();
    await s.close();
  });
});

describe("a Remove whose move fails", () => {
  it("can be retried and still moves the album", async () => {
    const s = await album();
    const before = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const drives = s.admin.deps.drives;
    const realOpen = drives.open.bind(drives);
    let failing = true;
    drives.open = (async (...args: Parameters<typeof realOpen>) => {
      if (failing) return [new Error("drive offline"), null];
      return realOpen(...args);
    }) as typeof drives.open;
    const [first] = await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(first).not.toBeNull();
    expect(s.record().moveOwed).toEqual([s.keys.ben]);
    expect(s.record().shareKey).toBe(before.shareKey);
    failing = false;
    const [retry] = await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(retry).toBeNull();
    const record = s.record();
    expect(record.shareKey).not.toBe(before.shareKey);
    expect(record.pastKeys).toEqual([before.shareKey]);
    expect(record.moveOwed).toBeUndefined();
    expect(Object.values(record.moving ?? {}).map((m) => (m as { key: string }).key)).not.toContain(
      s.keys.ben,
    );
    await s.close();
  });

  it("keeps the owed move across a restart", async () => {
    const s = await album();
    const drives = s.admin.deps.drives;
    drives.open = (async () => [new Error("drive offline"), null]) as unknown as typeof drives.open;
    await s.admin.store.removeMember(s.folderId, s.keys.vera);
    expect(s.record().moveOwed).toEqual([s.keys.vera]);
    await s.admin.store.close();
    const again = createPhotoStore(restarted(s.admin.deps));
    await again.ready();
    const [retry] = await again.removeMember(s.folderId, s.keys.vera);
    expect(retry).toBeNull();
    expect(s.record().moveOwed).toBeUndefined();
    expect(s.record().moves).toBe(1);
    await again.close();
    for (const p of [s.nils, s.ben, s.vera]) await p.store.close();
  });
});

describe("the other phones follow the move by themselves", () => {
  /** Anna's album that Nils (Collaborator), Vera (Viewer) and Ben (Viewer) joined through the invite. */
  async function invited() {
    const hub = createFakeHub();
    const admin = phone(hub, "Anna");
    const people = { nils: phone(hub, "Nils"), vera: phone(hub, "Vera"), ben: phone(hub, "Ben") };
    for (const p of [admin, ...Object.values(people)]) await p.store.ready();
    const created = await admin.store.createFolder("Trip");
    const { id: folderId, shareKey, invite } = created[1]!.folder;
    const keys: Record<string, string> = {};
    const ids: Record<string, string> = {};
    for (const [name, role] of [
      ["nils", "member"],
      ["vera", "reader"],
      ["ben", "reader"],
    ] as const) {
      const who = people[name];
      await who.store.ask({
        code: invite!.code,
        owner: identityOf(admin),
        albumName: "Trip",
        ownerName: "Anna",
      });
      let requesterKey = "";
      await until(async () => {
        requesterKey = (await admin.store.requests()).requests[0]?.requesterKey ?? "";
        return requesterKey !== "";
      });
      keys[name] = requesterKey;
      expect((await admin.store.respond(folderId, requesterKey, true, role))[0]).toBeNull();
      await until(async () => (await who.store.folders()).folders[0]?.shareKey === shareKey);
      ids[name] = (await who.store.folders()).folders[0]!.id;
    }
    const record = () =>
      JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8")).folders.find(
        (f: { id: string }) => f.id === folderId,
      );
    const close = async () => {
      for (const p of [admin, ...Object.values(people)]) await p.store.close();
    };
    return { admin, ...people, folderId, keys, ids, record, close };
  }
  const albumOf = async (p: ReturnType<typeof phone>, id: string) =>
    (await p.store.folders()).folders.find((f) => f.id === id);

  it("a Collaborator and a Viewer end on the new key under the same local id", async () => {
    const s = await invited();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    await until(async () => (await albumOf(s.vera, s.ids.vera))?.shareKey === next, 15_000);
    expect((await albumOf(s.nils, s.ids.nils))?.shareKey).toBe(next);
    expect((await albumOf(s.vera, s.ids.vera))?.shareKey).toBe(next);
    expect((await s.nils.store.folders()).folders).toHaveLength(1);
    await until(() => Object.keys(s.record().moving ?? {}).length === 0, 15_000);
    expect(s.record().moving).toBeUndefined();
    expect((await albumOf(s.ben, s.ids.ben))?.shareKey).not.toBe(next);
    await s.close();
  }, 40_000);

  it("a Collaborator keeps their photo once, on the new drive", async () => {
    const s = await invited();
    expect(
      (await s.nils.store.addBytes("mine.jpg", new Uint8Array([5, 5, 5]), s.ids.nils))[0],
    ).toBeNull();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    await until(async () => {
      const mine = (await s.admin.store.list({ all: true })).filter((p) => p.name === "mine.jpg");
      return mine.length === 1;
    }, 15_000);
    const mine = (await s.admin.store.list({ all: true })).filter((p) => p.name === "mine.jpg");
    expect(mine).toHaveLength(1);
    await s.close();
  }, 40_000);
  it("a move offer from someone who is not the Admin is ignored", async () => {
    const s = await invited();
    const nilsId = s.ids.nils;
    const before = (await albumOf(s.nils, s.ids.nils))!.shareKey;
    const links = (
      s.ben.store.debugState() as { connections: { conn: number; identityKey: string | null }[] }
    ).connections.filter((c) => c.identityKey === identityOf(s.nils));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      s.ben.deps.network.sendAnswer(link.conn, {
        kind: "offer",
        code: "c".repeat(64),
        albumName: "Trip",
        ownerName: "Ben",
        move: { from: [before], role: "member" },
      });
    }
    await sleep(1_500);
    const after = (await s.nils.store.folders()).folders;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(nilsId);
    expect(after[0]!.shareKey).toBe(before);
    expect((await s.nils.store.folders()).asks).toHaveLength(0);
    expect((await s.nils.store.folders()).offers).toHaveLength(0);
    await s.close();
  });
});
