/**
 * Remove moves the album on the Admin's phone: a new key, a new invite code,
 * and everyone who stays is told to follow. Phones on the checked fakes share
 * one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { ErrorCode } from "@ekrooh/bare/core";
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
  return { deps, node, server, store: createPhotoStore(deps) };
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

/** Their phone asks through the new invite code, then reconnects, as after a restart. */
async function follow(
  s: Pick<Awaited<ReturnType<typeof album>>, "admin" | "folderId">,
  who: ReturnType<typeof phone>,
) {
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

/** Like `album()`, but the Admin's phone cannot yet tell who `who` is. */
async function albumWithUnknown(who: "nils" | "vera") {
  const hub = createFakeHub();
  const admin = phone(hub, "Anna");
  const nils = phone(hub, "Nils");
  const ben = phone(hub, "Ben");
  const vera = phone(hub, "Vera");
  for (const p of [admin, nils, ben, vera]) await p.store.ready();
  const target = identityOf(who === "nils" ? nils : vera);
  let blocked = true;
  const real = admin.deps.drives.verifyIdentity.bind(admin.deps.drives);
  admin.deps.drives.verifyIdentity = (proof: Parameters<typeof real>[0]) =>
    blocked && proof.identityKey === target ? false : real(proof);
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
    const m = (await admin.store.status()).members as { identity?: string }[];
    return m.length === 4 && m.filter((x) => x.identity !== undefined).length >= 3;
  });
  const saved = () => JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8"));
  const record = () => saved().folders.find((f: { id: string }) => f.id === folderId);
  const unblock = () => {
    blocked = false;
  };
  const reconnect = async (p: typeof nils) => {
    setFakeNodeConnected({ hub, node: p.node, connected: false });
    await sleep(50);
    setFakeNodeConnected({ hub, node: p.node, connected: true });
  };
  const close = async () => {
    for (const p of [admin, nils, ben, vera]) await p.store.close();
  };
  return { hub, admin, nils, ben, vera, folderId, keys, record, unblock, reconnect, close };
}

describe("someone not known at the Remove", () => {
  type Scene = Awaited<ReturnType<typeof albumWithUnknown>>;
  const listed = async (s: Scene, key: string) =>
    ((await s.admin.store.status()).members as { key: string; viewer?: boolean }[]).find(
      (m) => m.key === key,
    );

  it("is still on the Admin's people list after the Remove", async () => {
    const s = await albumWithUnknown("nils");
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    const row = await listed(s, s.keys.nils);
    expect(row).toBeDefined();
    expect(row!.viewer).toBeUndefined();
    await s.close();
  }, 20_000);

  it("gets the move once the Admin's phone learns who they are", async () => {
    const s = await albumWithUnknown("nils");
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    s.unblock();
    await s.reconnect(s.nils);
    const id = identityOf(s.nils);
    await until(() => s.record().moving?.[id] !== undefined, 6_000);
    expect(s.record().moving[id].key).toBe(s.keys.nils);
    expect(s.record().movingUnknown).toBeUndefined();
    const again = await follow(s, s.nils);
    await until(() => !s.record().moving?.[id], 6_000);
    expect(s.record().moving?.[id]).toBeUndefined();
    expect(s.record().answers[id]).toBe("accepted");
    await again.close();
    for (const p of [s.admin, s.ben, s.vera]) await p.store.close();
  }, 20_000);

  it("a Viewer not known at the Remove follows as a Viewer", async () => {
    const s = await albumWithUnknown("vera");
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect((await listed(s, s.keys.vera))?.viewer).toBe(true);
    s.unblock();
    await s.reconnect(s.vera);
    const id = identityOf(s.vera);
    await until(() => s.record().moving?.[id] !== undefined, 6_000);
    expect(s.record().moving[id].role).toBe("reader");
    const again = await follow(s, s.vera);
    await until(() => !s.record().moving?.[id], 6_000);
    expect(s.record().answers[id]).toBe("accepted");
    expect((await again.folders()).folders[0]!.role).toBe("reader");
    await again.close();
    for (const p of [s.admin, s.nils, s.ben]) await p.store.close();
  }, 20_000);

  it("is kept across a restart", async () => {
    const s = await albumWithUnknown("nils");
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const unknown = Object.values(s.record().movingUnknown ?? {}) as { key: string }[];
    expect(unknown.map((m) => m.key)).toEqual([s.keys.nils]);
    await s.admin.store.close();
    const again = createPhotoStore(restarted(s.admin.deps));
    await again.ready();
    expect(
      ((await again.status()).members as { key: string }[]).some((m) => m.key === s.keys.nils),
    ).toBe(true);
    s.unblock();
    await s.reconnect(s.nils);
    const id = identityOf(s.nils);
    const saved = () =>
      JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    await until(() => saved().folders[0].moving?.[id] !== undefined, 6_000);
    expect(saved().folders[0].moving[id].key).toBe(s.keys.nils);
    expect(saved().folders[0].movingUnknown).toBeUndefined();
    await again.close();
    for (const p of [s.nils, s.ben, s.vera]) await p.store.close();
  }, 20_000);

  it("keeps a Viewer's device drive open while their identity is unknown", async () => {
    const s = await albumWithUnknown("vera");
    const drives = s.admin.deps.drives;
    const released: string[] = [];
    const realRelease = drives.release.bind(drives);
    drives.release = async (drive: Parameters<typeof realRelease>[0]) => {
      released.push(String((drive as { key: unknown }).key));
      return realRelease(drive);
    };
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    await s.reconnect(s.nils);
    await sleep(1_000);
    expect(released).not.toContain(s.keys.vera);
    await s.close();
  }, 30_000);

  it("removing them while unknown takes them off the list", async () => {
    const s = await albumWithUnknown("nils");
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect((await s.admin.store.removeMember(s.folderId, s.keys.nils))[0]).toBeNull();
    expect(await listed(s, s.keys.nils)).toBeUndefined();
    await s.close();
  }, 20_000);
});

describe("someone who is moving asks through the new code", () => {
  it("seats a Collaborator with their role and takes them off the moving list", async () => {
    const s = await album();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const nilsIdentity = identityOf(s.nils);
    expect(s.record().moving[nilsIdentity]).toBeDefined();
    const again = await follow(s, s.nils);
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
    const again = await follow(s, s.vera);
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

describe("someone removed who asks again with the new code", () => {
  it("is accepted: the kept album becomes the live one under the same id, another kept album stays", async () => {
    const s = await album();
    const carl = phone(s.hub, "Carl");
    await carl.store.ready();
    const first = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const owner = identityOf(s.admin);
    expect(
      (
        await carl.store.ask({
          code: first.invite!.code,
          owner,
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

    // A second album of the same Admin that Carl also keeps, removed from it earlier.
    const other = await s.admin.store.createFolder("Other");
    const otherId = other[1]!.folder.id;
    const otherCode = other[1]!.folder.invite!.code;
    expect(
      (await carl.store.ask({ code: otherCode, owner, albumName: "Other", ownerName: "Anna" }))[0],
    ).toBeNull();
    let otherKey = "";
    await until(async () => {
      otherKey =
        (await s.admin.store.requests()).requests.find((r) => r.requesterKey !== requesterKey)
          ?.requesterKey ?? "";
      return otherKey !== "";
    });
    expect((await s.admin.store.respond(otherId, otherKey, true))[0]).toBeNull();

    const carlFolders = async () => (await carl.store.folders()).folders;
    await until(async () => (await carlFolders()).length === 2, 10_000);
    const kept = (await carlFolders()).find((f) => f.name === "Trip")!;
    const otherKept = (await carlFolders()).find((f) => f.name === "Other")!;

    expect((await s.admin.store.removeMember(s.folderId, requesterKey))[0]).toBeNull();
    expect((await s.admin.store.removeMember(otherId, otherKey))[0]).toBeNull();
    await until(
      async () => (await carlFolders()).every((f) => f.notice?.kind === "removed"),
      15_000,
    );

    const now = (await s.admin.store.folders()).folders.find((f) => f.id === otherId)!;
    expect(now.invite!.code).not.toBe(otherCode);
    expect(
      (
        await carl.store.ask({
          code: now.invite!.code,
          owner,
          albumName: "Other",
          ownerName: "Anna",
        })
      )[0],
    ).toBeNull();
    await until(async () => (await s.admin.store.requests()).requests.length > 0, 10_000);
    const again = (await s.admin.store.requests()).requests[0]!.requesterKey;
    expect((await s.admin.store.respond(otherId, again, true))[0]).toBeNull();

    await until(
      async () => (await carlFolders()).find((f) => f.id === otherKept.id)?.notice === undefined,
      15_000,
    );
    const after = await carlFolders();
    expect(after.length).toBe(2);
    const live = after.find((f) => f.id === otherKept.id)!;
    expect(live.shareKey).toBe(now.shareKey);
    expect(live.notice).toBeUndefined();
    const stay = after.find((f) => f.id === kept.id)!;
    expect(stay.shareKey).toBe(kept.shareKey);
    expect(stay.notice?.kind).toBe("removed");
    await carl.store.close();
    await s.close();
  });
});

/** Carl joined Anna's Trip through its invite and was then removed: he keeps a copy with a removed notice. */
async function removedCarl() {
  const s = await album();
  const carl = phone(s.hub, "Carl");
  await carl.store.ready();
  const owner = identityOf(s.admin);
  const first = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
  const oldKey = first.shareKey;
  expect(
    (
      await carl.store.ask({
        code: first.invite!.code,
        owner,
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
  const carlFolders = async () => (await carl.store.folders()).folders;
  await until(async () => (await carlFolders()).length === 1, 10_000);
  const kept = (await carlFolders())[0]!;
  expect((await s.admin.store.removeMember(s.folderId, requesterKey))[0]).toBeNull();
  await until(async () => (await carlFolders())[0]?.notice?.kind === "removed", 15_000);
  const now = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
  return { s, carl, owner, oldKey, kept, now, carlFolders };
}

describe("an answer that names a kept album", () => {
  it("from another Admin never replaces a kept album", async () => {
    const { s, carl, oldKey, kept, carlFolders } = await removedCarl();
    const mal = phone(s.hub, "Mal");
    await mal.store.ready();
    const made = await mal.store.createFolder("Mal's");
    const malId = made[1]!.folder.id;
    const movedFrom = [carl.deps.drives.discoveryKeyOf(oldKey)];
    const network = mal.deps.network;
    const sendAnswer = network.sendAnswer.bind(network);
    network.sendAnswer = ((conn: number, msg: { answer?: string }) =>
      sendAnswer(
        conn,
        (msg.answer === "accepted" ? { ...msg, movedFrom } : msg) as never,
      )) as typeof network.sendAnswer;
    expect(
      (
        await carl.store.ask({
          code: made[1]!.folder.invite!.code,
          owner: identityOf(mal),
          albumName: "Mal's",
          ownerName: "Mal",
        })
      )[0],
    ).toBeNull();
    await until(async () => (await mal.store.requests()).requests.length > 0, 10_000);
    const who = (await mal.store.requests()).requests[0]!.requesterKey;
    expect((await mal.store.respond(malId, who, true))[0]).toBeNull();
    await until(async () => (await carlFolders()).length === 2, 15_000);
    const after = await carlFolders();
    expect(after).toHaveLength(2);
    const trip = after.find((f) => f.id === kept.id)!;
    expect(trip.shareKey).toBe(kept.shareKey);
    expect(trip.notice?.kind).toBe("removed");
    expect(after.some((f) => f.name === "Mal's")).toBe(true);
    await mal.store.close();
    await carl.store.close();
    await s.close();
  }, 40_000);

  it("still replaces the kept album when the phone restarts before the join finishes", async () => {
    const { s, carl, owner, kept, now, carlFolders } = await removedCarl();
    const drives = carl.deps.drives;
    const real = drives.open.bind(drives);
    let offline = false;
    drives.open = (async (...args: Parameters<typeof drives.open>) => {
      if (offline && args[0] === now.shareKey) throw new Error("offline");
      return real(...args);
    }) as typeof drives.open;
    expect(
      (
        await carl.store.ask({
          code: now.invite!.code,
          owner,
          albumName: "Trip",
          ownerName: "Anna",
        })
      )[0],
    ).toBeNull();
    offline = true;
    await until(async () => (await s.admin.store.requests()).requests.length > 0, 10_000);
    const again = (await s.admin.store.requests()).requests[0]!.requesterKey;
    expect((await s.admin.store.respond(s.folderId, again, true))[0]).toBeNull();
    const savedAsks = () =>
      (
        JSON.parse(readFileSync(join(carl.deps.storageDir, "justus.json"), "utf8")) as {
          asks: { status: string; replaces?: string }[];
        }
      ).asks;
    await until(() => savedAsks().some((a) => a.status === "accepted"), 15_000);
    expect(savedAsks().map((a) => a.replaces)).toEqual([kept.id]);
    expect(await carlFolders()).toHaveLength(1);
    await carl.store.close();
    const reopened = createPhotoStore(restarted(carl.deps));
    await reopened.ready();
    await until(async () => (await reopened.folders()).folders[0]?.notice === undefined, 15_000);
    const folders = (await reopened.folders()).folders;
    expect(folders.map((f) => f.id)).toEqual([kept.id]);
    expect(folders[0]!.shareKey).toBe(now.shareKey);
    expect(folders[0]!.notice).toBeUndefined();
    await reopened.close();
    await s.close();
  }, 40_000);
});

describe("someone waiting when the Admin removes another person", () => {
  async function waiting() {
    const s = await album();
    const kim = phone(s.hub, "Kim");
    await kim.store.ready();
    const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const [askErr] = await kim.store.ask({
      code: folder.invite!.code,
      owner: identityOf(s.admin),
      albumName: "Trip",
      ownerName: "Anna",
    });
    expect(askErr).toBeNull();
    let key = "";
    await until(async () => {
      key = (await s.admin.store.requests()).requests[0]?.requesterKey ?? "";
      return key !== "";
    });
    expect(key).not.toBe("");
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    const status = () => (kim.store.debugState() as { asks: { status: string }[] }).asks[0]?.status;
    return { ...s, kim, key, status };
  }

  it("stays on the Admin's list after the Remove", async () => {
    const s = await waiting();
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const listed = (await s.admin.store.requests()).requests;
    expect(listed).toHaveLength(1);
    expect(listed[0].requesterKey).toBe(s.key);
    expect(listed[0].viaInvite).toBe(true);
    expect(listed[0].checkCode).toBeTruthy();
    await sleep(300);
    expect(s.status()).toBe("waiting");
    await s.kim.store.close();
    await s.close();
  });

  it("Accept lets them into the album's new key", async () => {
    const s = await waiting();
    expect((await s.admin.store.respond(s.folderId, s.key, true, "reader"))[0]).toBeNull();
    const newKey = s.record().shareKey;
    await until(async () =>
      (await s.kim.store.folders()).folders.some((f) => f.shareKey === newKey && !f.pending),
    );
    const got = (await s.kim.store.folders()).folders.find((f) => f.shareKey === newKey);
    expect(got).toBeDefined();
    expect(got?.pending).toBeFalsy();
    expect(s.record().heldAsks).toBeUndefined();
    await s.kim.store.close();
    await s.close();
  });

  it("Decline reaches them", async () => {
    const s = await waiting();
    expect((await s.admin.store.respond(s.folderId, s.key, false))[0]).toBeNull();
    await until(() => s.status() === "declined");
    expect(s.status()).toBe("declined");
    await s.kim.store.close();
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
    return { hub, admin, ...people, folderId, keys, ids, record, close };
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
  it("a Collaborator's record of held photos follows to the new drive", async () => {
    const s = await invited();
    await s.admin.store.setActive(s.folderId);
    await s.admin.store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
    await until(async () => (await s.nils.store.list({ all: true })).length === 1);
    const photo = (await s.nils.store.list({ all: true }))[0];
    expect((await s.nils.server.getForTest(new URL(photo.url).pathname)).status).toBe(200);
    await until(async () => (await s.admin.store.list())[0].holders!.others.length === 1);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    const code = s.record().invite.code as string;
    const ask = await s.nils.deps.drives.openOwn(`ask/${code}`);
    const held: string[] = [];
    for await (const e of ask.list("/held")) held.push(e.path);
    expect(held).toEqual([`/held/${photo.id}`]);
    expect(await ask.readSmall("/holding.json", 1e6)).toBe('{"version":1}');
    await s.close();
  }, 40_000);

  const savedOf = (p: ReturnType<typeof phone>) =>
    JSON.parse(readFileSync(join(p.deps.storageDir, "justus.json"), "utf8")) as {
      folders: { id: string; shareKey: string }[];
      asks: unknown[];
    };

  /** The phone's new drive (the ask drive) only gets the photos `keep` lets through. */
  function limitCopies(p: ReturnType<typeof phone>, keep: (path: string) => boolean) {
    const drives = p.deps.drives;
    const real = drives.openOwn.bind(drives);
    drives.openOwn = (async (ns: string) => {
      const drive = await real(ns);
      if (!ns.startsWith("ask/")) return drive;
      return new Proxy(drive, {
        get(target, prop, receiver) {
          if (prop !== "put") return Reflect.get(target, prop, receiver);
          return (path: string, ...rest: unknown[]) =>
            path.startsWith("/photos/") && !keep(path)
              ? Promise.resolve()
              : (target.put as (...a: unknown[]) => unknown)(path, ...rest);
        },
      });
    }) as typeof drives.openOwn;
  }

  const earlierKeys = (s: Awaited<ReturnType<typeof invited>>) =>
    ((s.record().earlier ?? []) as { key: string }[]).map((e) => e.key);

  const names = async (p: ReturnType<typeof phone>) =>
    (await p.store.list({ all: true })).map((x) => x.name).sort();

  it("a photo added while the follow waits for the Admin arrives once", async () => {
    const s = await invited();
    await s.nils.store.addBytes("before.jpg", new Uint8Array([1, 1]), s.ids.nils);
    await until(async () => (await names(s.admin)).includes("before.jpg"));
    const drives = s.nils.deps.drives;
    const real = drives.openOwn.bind(drives);
    let fired = false;
    drives.openOwn = (async (ns: string) => {
      const drive = await real(ns);
      if (ns.startsWith("ask/") && !fired) {
        fired = true;
        await s.admin.store.close();
        setFakeNodeConnected({ hub: s.hub, node: s.admin.node, connected: false });
      }
      return drive;
    }) as typeof drives.openOwn;
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(() => fired, 15_000);
    await s.nils.store.addBytes("while.jpg", new Uint8Array([2, 2]), s.ids.nils);
    setFakeNodeConnected({ hub: s.hub, node: s.admin.node, connected: true });
    s.admin.deps = restarted(s.admin.deps);
    s.admin.store = createPhotoStore(s.admin.deps);
    await s.admin.store.ready();
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 20_000);
    const both = ["before.jpg", "while.jpg"];
    await until(async () => {
      const lists = await Promise.all([s.admin, s.vera, s.nils].map(names));
      return lists.every((l) => l.join() === both.join()) && !earlierKeys(s).includes(s.keys.nils);
    }, 15_000);
    expect(await names(s.admin)).toEqual(both);
    expect(await names(s.vera)).toEqual(both);
    expect(await names(s.nils)).toEqual(both);
    expect(earlierKeys(s)).not.toContain(s.keys.nils);
    await s.close();
  }, 60_000);

  it("the Admin drops a Collaborator's old drive once the new one has all their photos", async () => {
    const s = await invited();
    await s.nils.store.addBytes("mine.jpg", new Uint8Array([5, 5, 5]), s.ids.nils);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(earlierKeys(s)).toContain(s.keys.nils);
    await until(() => !earlierKeys(s).includes(s.keys.nils), 15_000);
    expect(earlierKeys(s)).not.toContain(s.keys.nils);
    await s.close();
  }, 40_000);

  it("after a removal the Admin lists each photo once, all the way through the follow", async () => {
    const s = await invited();
    await s.nils.store.addBytes("mine.jpg", new Uint8Array([5, 5, 5]), s.ids.nils);
    await until(async () => (await names(s.admin)).includes("mine.jpg"));
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const seen: string[][] = [];
    const end = Date.now() + 12_000;
    while (Date.now() < end) {
      seen.push(await names(s.admin));
      await sleep(100);
    }
    expect(seen.filter((l) => l.join() !== "mine.jpg")).toEqual([]);
    await s.close();
  }, 40_000);

  it("the Admin keeps the old drive while the new one lists fewer photos", async () => {
    const s = await invited();
    limitCopies(s.nils, () => false);
    await s.nils.store.addBytes("mine.jpg", new Uint8Array([5, 5, 5]), s.ids.nils);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    await sleep(2_000);
    expect(earlierKeys(s)).toContain(s.keys.nils);
    expect(await names(s.admin)).toEqual(["mine.jpg"]);
    await s.close();
  }, 40_000);

  it("while the old drive is kept, the Admin and a Viewer list a copied photo once and the other photo once", async () => {
    const s = await invited();
    limitCopies(s.nils, (path) => path.includes("a.jpg"));
    await s.nils.store.addBytes("a.jpg", new Uint8Array([1, 1, 1]), s.ids.nils);
    await s.nils.store.addBytes("b.jpg", new Uint8Array([2, 2, 2]), s.ids.nils);
    await until(async () => (await names(s.admin)).length === 2);
    // A new name: only the identity can tell the new drive is Nils's.
    await s.nils.store.setName("Nils B");
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    await until(async () => (await albumOf(s.vera, s.ids.vera))?.shareKey === next, 15_000);
    await sleep(2_000);
    expect(earlierKeys(s)).toContain(s.keys.nils);
    const bad: string[] = [];
    const end = Date.now() + 6_000;
    while (Date.now() < end) {
      for (const p of [s.admin, s.vera, s.nils]) {
        const list = (await names(p)).sort().join();
        if (list !== "a.jpg,b.jpg") bad.push(list);
      }
      await sleep(100);
    }
    expect(bad).toEqual([]);
    await s.close();
  }, 40_000);

  it("a Viewer follows without copying anything", async () => {
    const s = await invited();
    const selfNs = (savedOf(s.vera).folders[0] as { selfNs?: string }).selfNs;
    expect(selfNs).toBeTruthy();
    const old = await s.vera.deps.drives.openOwn(selfNs!);
    await old.put("/photos/stray.jpg", Buffer.from("stray"));
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    const code = s.record().invite.code as string;
    await until(async () => (await albumOf(s.vera, s.ids.vera))?.shareKey === next, 15_000);
    const fresh = await s.vera.deps.drives.openOwn(`ask/${code}`);
    const copied: string[] = [];
    for await (const e of fresh.list("/photos")) copied.push(e.path);
    expect(copied).toEqual([]);
    await s.close();
  }, 40_000);

  it("two offers sent at the same instant start one follow", async () => {
    const s = await invited();
    const nilsKey = identityOf(s.nils);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const drives = s.nils.deps.drives;
    const real = drives.openOwn.bind(drives);
    const taken: number[] = [];
    const network = s.nils.deps.network;
    const sendAnswer = network.sendAnswer.bind(network);
    network.sendAnswer = ((conn: number, msg: { kind: string }) => {
      if (msg.kind === "offerTaken") taken.push(conn);
      return sendAnswer(conn, msg as never);
    }) as typeof network.sendAnswer;
    drives.openOwn = (async (ns: string) => {
      const drive = await real(ns);
      if (!ns.startsWith("ask/")) return drive;
      await gate;
      return drive;
    }) as typeof drives.openOwn;
    const oldKey = s.record().shareKey;
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const code = s.record().invite.code as string;
    const links = (
      s.admin.store.debugState() as { connections: { conn: number; identityKey: string | null }[] }
    ).connections.filter((c) => c.identityKey === nilsKey);
    for (const link of links) {
      for (let i = 0; i < 2; i++) {
        s.admin.deps.network.sendAnswer(link.conn, {
          kind: "offer",
          code,
          albumName: "Trip",
          ownerName: "Anna",
          move: { from: [oldKey], role: "member" },
        });
      }
    }
    await sleep(500);
    release();
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    await sleep(500);
    expect(links.length).toBeGreaterThan(0);
    expect(taken).toHaveLength(1);
    await s.close();
  }, 40_000);

  it("the follow's own ask is never listed while the follow runs", async () => {
    const s = await invited();
    const seen: unknown[] = [];
    let asked = 0;
    const deps = s.nils.deps;
    const onChanged = deps.onChanged.bind(deps);
    deps.onChanged = ((change: { cause?: string }) => {
      if (change.cause === "ask") {
        asked++;
        void s.nils.store.folders().then((f) => seen.push(...f.asks));
      }
      return onChanged(change);
    }) as typeof deps.onChanged;
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    await sleep(100);
    expect(asked).toBeGreaterThan(0);
    expect(seen).toEqual([]);
    await s.close();
  }, 40_000);

  it("after the follow the old album is gone and the id is kept", async () => {
    const s = await invited();
    const before = (await albumOf(s.nils, s.ids.nils))!;
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    expect((await s.nils.store.folders()).asks).toHaveLength(0);
    await until(() => savedOf(s.nils).folders.every((f) => f.shareKey === next), 5_000);
    const folders = savedOf(s.nils).folders;
    expect(folders.map((f) => f.id)).toEqual([s.ids.nils]);
    expect(folders.some((f) => f.shareKey === before.shareKey)).toBe(false);
    await s.close();
  }, 40_000);

  it("a repeated offer for the same code does not start a second follow", async () => {
    const s = await invited();
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    const next = s.record().shareKey;
    await until(async () => (await albumOf(s.nils, s.ids.nils))?.shareKey === next, 15_000);
    const code = s.record().invite.code as string;
    const asksBefore = JSON.stringify(savedOf(s.nils).asks);
    const links = (
      s.admin.store.debugState() as { connections: { conn: number; identityKey: string | null }[] }
    ).connections.filter((c) => c.identityKey === identityOf(s.nils));
    for (const link of links) {
      for (let i = 0; i < 2; i++) {
        s.admin.deps.network.sendAnswer(link.conn, {
          kind: "offer",
          code,
          albumName: "Trip",
          ownerName: "Anna",
          move: { from: [s.ids.nils], role: "member" },
        });
      }
    }
    await sleep(1_000);
    expect(JSON.stringify(savedOf(s.nils).asks)).toBe(asksBefore);
    expect(savedOf(s.nils).folders).toHaveLength(1);
    await s.close();
  }, 40_000);

  it("a move offer from someone who is not the Admin is ignored", async () => {
    const s = await invited();
    const nilsId = s.ids.nils;
    const before = (await albumOf(s.nils, s.ids.nils))!.shareKey;
    const linksToNils = () =>
      (
        s.ben.store.debugState() as { connections: { conn: number; identityKey: string | null }[] }
      ).connections.filter((c) => c.identityKey === identityOf(s.nils));
    await until(() => linksToNils().length > 0, 15_000);
    const links = linksToNils();
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

describe("the removed phone sees the album turn read-only", () => {
  const albumOf = async (p: ReturnType<typeof phone>) => (await p.store.folders()).folders[0]!;
  const noticeOf = async (p: ReturnType<typeof phone>) => (await albumOf(p)).notice;

  it("a removed Collaborator turns read-only and keeps both photos", async () => {
    const s = await album();
    const benId = (await albumOf(s.ben)).id;
    expect((await s.ben.store.addBytes("ben.jpg", new Uint8Array([1, 2, 3]), benId))[0]).toBeNull();
    expect((await s.admin.store.addBytes("anna.jpg", new Uint8Array([4, 5, 6])))[0]).toBeNull();
    await until(async () => (await s.ben.store.list({ all: true })).length === 2);
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    await until(async () => (await noticeOf(s.ben))?.kind === "removed", 15_000);
    const folder = await albumOf(s.ben);
    expect(folder.notice).toEqual({ kind: "removed" });
    expect(folder.role).toBe("reader");
    const names = (await s.ben.store.list({ all: true })).map((p) => p.name).sort();
    expect(names).toEqual(["anna.jpg", "ben.jpg"]);
    const added = await s.ben.store.addBytes("late.jpg", new Uint8Array([9]), benId);
    expect(added[0]!.code).toBe(PhotoError.NOT_A_MEMBER);
    await s.close();
  }, 40_000);

  it("a removed Viewer gets the notice", async () => {
    const s = await album();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.vera))[0]).toBeNull();
    await until(async () => (await noticeOf(s.vera))?.kind === "removed", 15_000);
    expect(await noticeOf(s.vera)).toEqual({ kind: "removed" });
    await s.close();
  }, 40_000);

  it("a Collaborator who stays never gets the notice", async () => {
    const s = await album();
    const nilsId = (await albumOf(s.nils)).id;
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    const next = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!.shareKey;
    await until(async () => (await albumOf(s.nils)).shareKey === next, 15_000);
    await until(async () => (await noticeOf(s.ben))?.kind === "removed", 15_000);
    const nils = (await s.nils.store.folders()).folders.find((f) => f.id === nilsId)!;
    expect(nils.notice).toBeUndefined();
    expect(nils.role).toBe("member");
    await s.close();
  }, 40_000);

  it("the notice, the role and the own photo survive a restart", async () => {
    const s = await album();
    const benId = (await albumOf(s.ben)).id;
    await s.ben.store.addBytes("ben.jpg", new Uint8Array([1, 2, 3]), benId);
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    await until(async () => (await noticeOf(s.ben))?.kind === "removed", 15_000);
    await s.ben.store.close();
    const again = createPhotoStore(restarted(s.ben.deps));
    await again.ready();
    const folder = (await again.folders()).folders[0]!;
    expect(folder.notice).toEqual({ kind: "removed" });
    expect(folder.role).toBe("reader");
    expect((await again.list({ all: true })).map((p) => p.name)).toContain("ben.jpg");
    await again.close();
    for (const p of [s.admin, s.nils, s.vera]) await p.store.close();
  }, 40_000);

  const REGISTRY = "/members.json";
  const oldDriveOf = async (s: Awaited<ReturnType<typeof album>>, shareKey: string) =>
    (await s.admin.deps.drives.open(shareKey, { timeoutMs: 1000 }))[1]!;

  it("stays read-only when the old registry still lists the removed phone", async () => {
    const s = await album();
    const oldDrive = await oldDriveOf(s, s.record().shareKey);
    const listed = (await oldDrive.readSmall(REGISTRY, 1 << 20))!;
    expect(JSON.parse(listed).members[s.keys.ben]).toBeDefined();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    await until(async () => (await noticeOf(s.ben))?.kind === "removed", 15_000);
    await oldDrive.put(REGISTRY, Buffer.from(listed));
    await sleep(1_500);
    const folder = await albumOf(s.ben);
    expect(folder.role).toBe("reader");
    expect(folder.notice).toEqual({ kind: "removed" });
    const added = await s.ben.store.addBytes("late.jpg", new Uint8Array([9]), folder.id);
    expect(added[0]!.code).toBe(PhotoError.NOT_A_MEMBER);
    await s.close();
  }, 40_000);

  it("a restart with the registry still listing the phone stays read-only", async () => {
    const s = await album();
    const oldDrive = await oldDriveOf(s, s.record().shareKey);
    const listed = (await oldDrive.readSmall(REGISTRY, 1 << 20))!;
    await s.admin.store.removeMember(s.folderId, s.keys.ben);
    await until(async () => (await noticeOf(s.ben))?.kind === "removed", 15_000);
    await oldDrive.put(REGISTRY, Buffer.from(listed));
    await s.ben.store.close();
    const again = createPhotoStore(restarted(s.ben.deps));
    await again.ready();
    const folder = (await again.folders()).folders[0]!;
    expect(folder.role).toBe("reader");
    expect(folder.notice).toEqual({ kind: "removed" });
    await again.close();
    for (const p of [s.admin, s.nils, s.vera]) await p.store.close();
  }, 40_000);

  it("a phone that was off when it was removed hears it at start-up", async () => {
    const s = await album();
    await s.ben.store.close();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    const again = createPhotoStore(restarted(s.ben.deps));
    await again.ready();
    await until(async () => (await again.folders()).folders[0]?.notice?.kind === "removed", 15_000);
    const folder = (await again.folders()).folders[0]!;
    expect(folder.notice).toEqual({ kind: "removed" });
    expect(folder.role).toBe("reader");
    await again.close();
    for (const p of [s.admin, s.nils, s.vera]) await p.store.close();
  }, 40_000);

  it("hearing it clears a pending badge", async () => {
    const s = await album();
    await s.ben.store.close();
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    const file = join(s.ben.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    for (const f of saved.folders) f.pending = true;
    writeFileSync(file, JSON.stringify(saved));
    const again = createPhotoStore(restarted(s.ben.deps));
    await again.ready();
    await until(async () => (await again.folders()).folders[0]?.notice?.kind === "removed", 15_000);
    const folder = (await again.folders()).folders[0]!;
    expect(folder.notice).toEqual({ kind: "removed" });
    expect(folder.pending).toBeFalsy();
    await again.close();
    for (const p of [s.admin, s.nils, s.vera]) await p.store.close();
  }, 40_000);

  it("Remove fails with HOST_ERROR when the note cannot be written, and a retry succeeds", async () => {
    const s = await album();
    const drive = await oldDriveOf(s, s.record().shareKey);
    const put = drive.put.bind(drive);
    let broken = true;
    drive.put = async (path: string, ...rest: never[]) => {
      if (broken && path === "/removed-people.json") throw new Error("disk full");
      return put(path, ...rest);
    };
    const failed = await s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect(failed[0]!.code).toBe(ErrorCode.HOST_ERROR);
    broken = false;
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    await until(async () => (await noticeOf(s.ben))?.kind === "removed", 15_000);
    expect((await noticeOf(s.ben))?.kind).toBe("removed");
    await s.close();
  }, 40_000);
});

describe("away when removed", () => {
  const albumOf = async (p: ReturnType<typeof phone>) => (await p.store.folders()).folders[0]!;
  const names = async (p: ReturnType<typeof phone>) =>
    (await p.store.list({ all: true })).map((x) => x.name).sort();

  async function benHearsWhileNilsIsAway() {
    const s = await album();
    const nilsId = (await albumOf(s.nils)).id;
    expect((await s.nils.store.addBytes("nils.jpg", new Uint8Array([7]), nilsId))[0]).toBeNull();
    await until(async () => (await names(s.ben)).includes("nils.jpg"));
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: false });
    expect((await s.admin.store.removeMember(s.folderId, s.keys.ben))[0]).toBeNull();
    await until(async () => (await albumOf(s.ben)).notice?.kind === "removed", 15_000);
    setFakeNodeConnected({ hub: s.hub, node: s.admin.node, connected: false });
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    setFakeNodeConnected({ hub: s.hub, node: s.nils.node, connected: true });
    return { s, nilsId };
  }

  it("the removed phone never lists a photo added after it heard", async () => {
    const { s, nilsId } = await benHearsWhileNilsIsAway();
    expect((await s.nils.store.addBytes("late.jpg", new Uint8Array([9]), nilsId))[0]).toBeNull();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: true });
    await sleep(3_000);
    expect(await names(s.ben)).toEqual(["nils.jpg"]);
    await s.close();
  }, 40_000);

  it("the kept versions survive a restart", async () => {
    const { s, nilsId } = await benHearsWhileNilsIsAway();
    await s.nils.store.addBytes("late.jpg", new Uint8Array([9]), nilsId);
    const saved = JSON.parse(readFileSync(join(s.ben.deps.storageDir, "justus.json"), "utf8"));
    expect(Object.keys(saved.folders[0].keptUntil).length).toBeGreaterThan(0);
    await s.ben.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: true });
    const again = createPhotoStore(restarted(s.ben.deps));
    await again.ready();
    await sleep(3_000);
    expect((await again.list({ all: true })).map((x) => x.name).sort()).toEqual(["nils.jpg"]);
    await again.close();
    for (const p of [s.admin, s.nils, s.vera]) await p.store.close();
  }, 40_000);
});

describe("an Accept or a Remove during a Remove", () => {
  async function asking() {
    const s = await album();
    const kim = phone(s.hub, "Kim");
    await kim.store.ready();
    const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
    const [askErr] = await kim.store.ask({
      code: folder.invite!.code,
      owner: identityOf(s.admin),
      albumName: "Trip",
      ownerName: "Anna",
    });
    expect(askErr).toBeNull();
    let key = "";
    await until(async () => {
      key = (await s.admin.store.requests()).requests[0]?.requesterKey ?? "";
      return key !== "";
    });
    expect(key).not.toBe("");
    const status = () => (kim.store.debugState() as { asks: { status: string }[] }).asks[0]?.status;
    return { ...s, kim, key, status };
  }

  /** Pauses the move's new-drive open on the Admin's phone. */
  function holdMove(s: { admin: { deps: { drives: unknown } }; folderId: string }) {
    const drives = s.admin.deps.drives as { openOwn(ns?: string): Promise<unknown> };
    const open = drives.openOwn.bind(drives);
    let reached = false;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    drives.openOwn = async (ns?: string) => {
      if (ns?.startsWith(`folder/${s.folderId}/m`)) {
        reached = true;
        await gate;
      }
      return open(ns);
    };
    return { reached: () => reached, release: () => release() };
  }

  async function kimOnNewKey(s: Awaited<ReturnType<typeof asking>>) {
    const newKey = s.record().shareKey;
    await until(async () =>
      (await s.kim.store.folders()).folders.some((f) => f.shareKey === newKey && !f.pending),
    );
    const got = (await s.kim.store.folders()).folders.find((f) => f.shareKey === newKey);
    expect(got).toBeDefined();
    expect(got?.pending).toBeFalsy();
  }

  it.each(["member", "reader"] as const)(
    "Accept tapped during a Remove lets them into the new key (%s)",
    async (role) => {
      const s = await asking();
      const hold = holdMove(s);
      const removing = s.admin.store.removeMember(s.folderId, s.keys.ben);
      await until(() => hold.reached());
      expect(hold.reached()).toBe(true);
      let settled = false;
      const accepting = s.admin.store.respond(s.folderId, s.key, true, role).then((r) => {
        settled = true;
        return r;
      });
      await sleep(100);
      expect(settled).toBe(false);
      hold.release();
      expect((await removing)[0]).toBeNull();
      expect((await accepting)[0]).toBeNull();
      await kimOnNewKey(s);
      const members = (await s.admin.store.status()).members as {
        key: string;
        viewer?: boolean;
      }[];
      const row = members.find((m) => m.key === s.key);
      expect(row).toBeDefined();
      expect(Boolean(row?.viewer)).toBe(role === "reader");
      expect(members.some((m) => m.key === s.keys.ben)).toBe(false);
      expect(s.record().heldAsks).toBeUndefined();
      await s.kim.store.close();
      await s.close();
    },
  );

  it("Decline tapped during a Remove reaches them", async () => {
    const s = await asking();
    const hold = holdMove(s);
    const removing = s.admin.store.removeMember(s.folderId, s.keys.ben);
    await until(() => hold.reached());
    const declining = s.admin.store.respond(s.folderId, s.key, false);
    hold.release();
    expect((await removing)[0]).toBeNull();
    expect((await declining)[0]).toBeNull();
    await until(() => s.status() === "declined");
    expect(s.status()).toBe("declined");
    await s.kim.store.close();
    await s.close();
  });

  it("a Remove tapped right after an Accept keeps the removed person out", async () => {
    const s = await asking();
    const accepting = s.admin.store.respond(s.folderId, s.key, true, "member");
    const removing = s.admin.store.removeMember(s.folderId, s.keys.ben);
    expect((await accepting)[0]).toBeNull();
    expect((await removing)[0]).toBeNull();
    const members = (await s.admin.store.status()).members as { key: string }[];
    expect(members.some((m) => m.key === s.keys.ben)).toBe(false);
    const moving = Object.values(s.record().moving ?? {}) as { key: string }[];
    expect(moving.some((m) => m.key === s.keys.ben)).toBe(false);
    await kimOnNewKey(s);
    await s.kim.store.close();
    await s.close();
  });
});
