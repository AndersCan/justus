/**
 * Asking to join through an invite code, on fakes: what the joiner writes to
 * its outbox (a code, never a key), and how the Admin's inbox, answers and
 * registry react. Real-swarm delivery is covered in `p2p-scenarios.ts`.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeCrypto from "node:crypto";
import { inviteTopic } from "../src/membership/invite.ts";
import { boxKeyOf } from "../src/membership/records.ts";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  createFakePeerNetwork,
  setFakeNodeConnected,
} from "./fakes/fake-world.ts";
import {
  fakeStoreDeps,
  peerPhone,
  restarted,
  type FakeStoreDeps,
} from "./fakes/fake-store-deps.ts";
import type { FakeHub } from "./fakes/fake-world.ts";
import { makeTmpDir } from "./tmp-dirs.ts";

function buildStore(name: string, hub: FakeHub, deps: Partial<FakeStoreDeps> = {}) {
  const full = fakeStoreDeps({ hub, deviceName: name, ...deps });
  mkdirSync(full.cacheDir, { recursive: true });
  return { store: createPhotoStore(full), deps: full };
}

const identityOf = (s: { store: { debugState(): unknown } }) =>
  (s.store.debugState() as { identityDrive: string }).identityDrive;

async function until(done: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function scenario(
  adminDeps?: Partial<FakeStoreDeps>,
  joinerDeps?: Partial<FakeStoreDeps>,
  hub = createFakeHub(),
) {
  const admin = buildStore("Admin", hub, adminDeps);
  const joiner = buildStore("Joiner", hub, joinerDeps);
  await admin.store.ready();
  await joiner.store.ready();
  const created = await admin.store.createFolder("Trip");
  const { id: folderId, shareKey, invite } = created[1]!.folder;
  const owner = identityOf(admin);
  const outboxKey = identityOf(joiner);
  const outbox = await openDrive(joiner, outboxKey);
  const adminTopic = admin.deps.drives.discoveryKeyOf(owner);
  const close = async () => {
    await admin.store.close();
    await joiner.store.close();
  };
  return {
    hub,
    admin,
    joiner,
    outbox,
    outboxKey,
    adminTopic,
    folderId,
    shareKey,
    invite: invite!,
    owner,
    close,
  };
}

/** The drive object the store itself holds, so a test can replace its methods. */
async function openDrive(on: { deps: FakeStoreDeps }, key: string): Promise<Drive> {
  const [err, drive] = await on.deps.drives.open(key, { timeoutMs: 1_000 });
  if (err || !drive) throw err ?? new Error("drive did not open");
  return drive;
}

async function albumDriveOf(s: Awaited<ReturnType<typeof scenario>>): Promise<Drive> {
  const folder = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId)!;
  return openDrive(s.admin, folder.driveKey);
}

/** A phone with `identityKey` meets the Admin; resolves once the Admin has been greeted. */
async function connect(s: Awaited<ReturnType<typeof scenario>>, identityKey = s.outboxKey) {
  const phone = peerPhone(s.hub, { identityKey });
  phone.meet(s.adminTopic);
  await until(() => phone.events.some((e) => e.type === "identified"));
  return phone;
}

async function outboxText(drive: Drive): Promise<string> {
  return (await drive.readSmall("/requests.json", 1 << 20)) ?? "";
}

/** The joiner's outbox once its ask is filed: Ask returns before the write. */
async function filedOutbox(s: { outbox: Drive }): Promise<string> {
  await until(async () => (await outboxText(s.outbox)).includes("sealedKey"));
  return outboxText(s.outbox);
}

const readText = async (drive: Drive, path: string) => drive.readSmall(path, 1 << 20);

describe("ask after a No", () => {
  const CODE = "c".repeat(64);
  const OWNER = "d".repeat(64);

  /** A joiner whose saved state already holds a declined ask (and optionally the invite). */
  async function declinedJoiner(withOffer: boolean, status = "declined") {
    const storageDir = makeTmpDir("justus-declined-");
    const declined = {
      code: CODE,
      owner: OWNER,
      albumName: "Trip",
      ownerName: "Admin",
      askedAt: 1,
      status,
    };
    const offers = withOffer
      ? [{ code: CODE, owner: OWNER, albumName: "Trip", ownerName: "Admin" }]
      : [];
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({
        version: 2,
        name: "Joiner",
        folders: [],
        activeFolderId: null,
        asks: [declined],
        offers,
        gone: [],
      }),
    );
    const s = await scenario(undefined, { storageDir });
    const saved = () => JSON.parse(readFileSync(join(storageDir, "justus.json"), "utf8"));
    return { s, saved };
  }

  it("asking again after a No files a new ask", async () => {
    const { s, saved } = await declinedJoiner(false);
    const asked = await s.joiner.store.ask({ code: CODE, owner: OWNER });
    expect(asked[0]).toBeNull();
    expect(asked[1]!.ask.status).toBe("waiting");
    expect(asked[1]!.ask.askedAt).toBeGreaterThan(1);
    const kept = saved().asks.filter((a: { code: string }) => a.code === CODE);
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe("waiting");
    await s.close();
  });

  it("OK on a No takes the ask off the phone and the saved file", async () => {
    const { s, saved } = await declinedJoiner(false);
    const dismissed = await s.joiner.store.dismissDeclinedAsk(CODE);
    expect(dismissed[0]).toBeNull();
    expect((await s.joiner.store.folders()).asks).toEqual([]);
    expect(saved().asks).toEqual([]);
    await s.close();
  });

  it("OK is refused for an ask that is still waiting, which stays", async () => {
    const { s, saved } = await declinedJoiner(false, "waiting");
    const dismissed = await s.joiner.store.dismissDeclinedAsk(CODE);
    expect(dismissed[0]!.code).toBe(PhotoError.NOT_FOUND);
    expect(saved().asks).toHaveLength(1);
    await s.close();
  });

  it("#349 joining an invite after a No returns the new ask", async () => {
    const { s, saved } = await declinedJoiner(true);
    const taken = await s.joiner.store.joinOffer(CODE, OWNER);
    expect(taken[0]).toBeNull();
    expect(taken[1]!.ask.status).toBe("waiting");
    expect(saved().asks).toHaveLength(1);
    expect(saved().asks[0].status).toBe("waiting");
    await s.close();
  });
});

describe("ask", () => {
  it("every album the Admin creates carries an invite code", async () => {
    const s = await scenario();
    expect(s.invite.code).toMatch(/^[0-9a-f]{64}$/);
    expect(s.invite.owner).toBe(s.owner);
    await s.close();
  });

  it("files a code in the outbox and no key anywhere on the joiner", async () => {
    const s = await scenario();
    const asked = await s.joiner.store.ask({
      code: s.invite.code,
      owner: s.owner,
      albumName: "Trip",
      ownerName: "Admin",
    });
    expect(asked[0]).toBeNull();
    expect(asked[1]!.ask).toMatchObject({ code: s.invite.code, status: "waiting" });

    const text = await filedOutbox(s);
    const entry = JSON.parse(text).requests[`invite:${s.invite.code}`];
    expect(entry.invite).toBe(s.invite.code);
    expect(entry.shareKey).toBeUndefined();
    expect(entry.folderName).toBeUndefined();
    expect(text).not.toContain(s.shareKey);

    const everything = JSON.stringify([
      s.joiner.store.debugState(),
      await s.joiner.store.folders(),
      readFileSync(join(s.joiner.deps.storageDir, "justus.json"), "utf8"),
    ]);
    expect(everything).not.toContain(s.shareKey);
    expect((await s.joiner.store.folders()).folders).toEqual([]);
    await s.close();
  });

  it("asking twice returns the same ask without a second entry", async () => {
    const s = await scenario();
    const args = { code: s.invite.code, owner: s.owner };
    const first = await s.joiner.store.ask(args);
    const second = await s.joiner.store.ask(args);
    expect(second[1]!.ask).toEqual(first[1]!.ask);
    expect(Object.keys(JSON.parse(await filedOutbox(s)).requests)).toHaveLength(1);
    expect((await s.joiner.store.folders()).asks).toHaveLength(1);
    await s.close();
  });

  it("rejects malformed keys and the Admin's own album", async () => {
    const s = await scenario();
    const bad = await s.joiner.store.ask({ code: "abc", owner: s.owner });
    expect(bad[0]?.message).toContain("64-char");
    const badOwner = await s.joiner.store.ask({ code: s.invite.code, owner: "zz" });
    expect(badOwner[0]).not.toBeNull();
    const own = await s.admin.store.ask({ code: s.invite.code, owner: s.owner });
    expect(own[0]?.code).toBe("justus.photos/already-enrolled");
    await s.close();
  });

  it("clips the names the link carried", async () => {
    const s = await scenario();
    const asked = await s.joiner.store.ask({
      code: s.invite.code,
      owner: s.owner,
      albumName: "a".repeat(500),
      ownerName: "  ",
    });
    expect(asked[1]!.ask.albumName).toHaveLength(80);
    expect(asked[1]!.ask.ownerName).toBe("the Admin");
    await s.close();
  });

  it("the Admin's request and the asker's ask show the same check code", async () => {
    const s = await scenario();
    const asked = await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    const { asks } = await s.joiner.store.folders();
    expect(requests[0]!.checkCode).toMatch(/^[a-z]+ [a-z]+ [a-z]+$/);
    expect(asks[0]!.checkCode).toBe(requests[0]!.checkCode);
    expect(asked[1]!.ask.checkCode).toBe(requests[0]!.checkCode);
    await s.close();
  });

  it("a decline saves the time of the ask it answered", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ folderId: s.folderId, shareKey: s.shareKey });

    const declined = await s.admin.store.respond(s.folderId, requests[0].requesterKey, false);
    expect(declined[0]).toBeNull();
    expect((await s.admin.store.requests()).requests).toEqual([]);
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    const identity = s.outboxKey;
    expect(saved.folders[0].answers).toEqual({ [identity]: "declined" });
    const outbox = JSON.parse(await filedOutbox(s)).requests[`invite:${s.invite.code}`];
    expect(saved.folders[0].declinedAsks).toEqual({ [identity]: outbox.requestedAt });
    await s.close();
  });

  it("after a No, a newer ask from the same phone is listed again and can be accepted", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const first = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, first[0].requesterKey, false);
    expect((await s.admin.store.requests()).requests).toEqual([]);
    const file = JSON.parse(await filedOutbox(s));
    file.requests[`invite:${s.invite.code}`].requestedAt += 1;
    await s.outbox.put("/requests.json", Buffer.from(JSON.stringify(file)));
    const again = (await s.admin.store.requests()).requests;
    expect(again).toHaveLength(1);
    const accepted = await s.admin.store.respond(s.folderId, again[0].requesterKey, true);
    expect(accepted[0]).toBeNull();
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers).toEqual({ [s.outboxKey]: "accepted" });
    expect(saved.folders[0].declinedAsks ?? {}).toEqual({});
    await s.close();
  });

  it("accepting enrolls the asker and records the answer", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    const accepted = await s.admin.store.respond(s.folderId, requests[0].requesterKey, true);
    expect(accepted[0]).toBeNull();
    const saved = JSON.parse(
      (await s.admin.store.status(),
      readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8")),
    );
    const identity = s.outboxKey;
    expect(saved.folders[0].answers).toEqual({ [identity]: "accepted" });
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("an old-style request still behaves as before", async () => {
    const s = await scenario();
    await s.joiner.store.join(s.shareKey);
    await connect(s);
    const { requests } = await s.admin.store.requests();
    expect(requests).toHaveLength(1);
    await s.admin.store.respond(s.folderId, requests[0].requesterKey, false);
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers ?? {}).toEqual({});
    await s.close();
  });

  it("an ask copied into another phone's outbox is listed once, for the phone that sealed it", async () => {
    for (const aliceLast of [true, false]) {
      const s = await scenario();
      const mallory = buildStore("Mallory", s.hub);
      await mallory.store.ready();
      const mallKey = identityOf(mallory);
      const mallBox = await openDrive(mallory, mallKey);
      await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
      await mallory.store.ask({ code: s.invite.code, owner: s.owner });
      const aliceFile = JSON.parse(await filedOutbox(s));
      await filedOutbox({ outbox: mallBox });
      // Mallory puts Alice's sealed entry verbatim in her own outbox, in place of hers.
      await mallBox.put("/requests.json", Buffer.from(JSON.stringify(aliceFile)));

      const order = aliceLast ? [mallKey, s.outboxKey] : [s.outboxKey, mallKey];
      for (const key of order) await connect(s, key);
      await until(async () => (await s.admin.store.requests()).requests.length > 0);
      const { requests } = await s.admin.store.requests();
      expect(requests, "one row for the one ask").toHaveLength(1);
      expect(requests[0]!.requesterName).toBe("Joiner");
      const res = await s.admin.store.respond(s.folderId, requests[0]!.requesterKey, true);
      expect(res[0] === null).toBe(true);
      await mallory.store.close();
      await s.close();
    }
  });

  it("a declined identity's old-style request is not hidden", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const first = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, first[0].requesterKey, false);
    await s.joiner.store.join(s.shareKey);
    await connect(s);
    const after = (await s.admin.store.requests()).requests;
    expect(after.some((r) => r.requesterKey !== first[0].requesterKey)).toBe(true);
    await s.close();
  });
});

describe("accepting as a Viewer", () => {
  async function asked() {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    return { ...s, key: requests[0].requesterKey, request: requests[0] };
  }

  it("drops the former name of a Viewer who is accepted again", async () => {
    const s = await asked();
    const albumDrive = await albumDriveOf(s);
    const identity = s.outboxKey;
    await albumDrive.put(
      "/former.json",
      Buffer.from(
        JSON.stringify({ version: 1, former: [{ name: "Joiner", identity, ids: ["p1"] }] }),
      ),
    );
    const done = await s.admin.store.respond(s.folderId, s.key, true, "reader");
    expect(done[0]).toBeNull();
    expect(JSON.parse((await readText(albumDrive, "/former.json"))!).former).toEqual([]);
  });

  it("gives a Viewer accepted next to another Viewer the next free seat", async () => {
    const s = await asked();
    expect((await s.admin.store.respond(s.folderId, s.key, true, "reader"))[0]).toBeNull();
    const second = buildStore("Second", s.hub);
    await second.store.ready();
    await second.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s, identityOf(second));
    const { requests } = await s.admin.store.requests();
    const next = requests.find((r) => r.requesterKey !== s.key)!;
    expect(
      (await s.admin.store.respond(s.folderId, next.requesterKey, true, "reader"))[0],
    ).toBeNull();
    const file = JSON.parse((await readText(await albumDriveOf(s), "/viewers.json"))!);
    expect(file.viewers[s.key].color).toBe(1);
    expect(file.viewers[next.requesterKey].color).toBe(2);
    await second.store.close();
  });

  it("lists the asker in /viewers.json, loads no drive and leaves the request list", async () => {
    const s = await asked();
    expect(s.request.viaInvite).toBe(true);
    const done = await s.admin.store.respond(s.folderId, s.key, true, "reader");
    expect(done[0]).toBeNull();
    const albumDrive = await albumDriveOf(s);
    const file = JSON.parse((await readText(albumDrive, "/viewers.json"))!);
    expect(Object.keys(file.viewers)).toEqual([s.key]);
    expect(file.viewers[s.key].color).toBe(1);
    expect(await readText(albumDrive, "/members.json")).toBeUndefined();
    expect((await s.admin.store.requests()).requests).toEqual([]);
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers).toEqual({
      [s.outboxKey]: "accepted",
    });
    const status = await s.admin.store.status();
    expect(
      status.members.map((m: { admin: boolean; viewer?: boolean }) => [m.admin, m.viewer]),
    ).toEqual([
      [true, undefined],
      [false, true],
    ]);
    expect(status.folder.members, "Admin and one Viewer").toBe(2);
    const again = await s.admin.store.respond(s.folderId, s.key, true, "reader");
    expect(again[0]).toMatchObject({ code: PhotoError.ALREADY_ENROLLED });
    await s.close();
  });

  /** The asker's drive already says they left (after any listing); `whileReading` runs as the Admin reads that note. */
  async function leaver(whileReading?: () => Promise<void>) {
    const s = await asked();
    for (const node of s.hub.nodes) setFakeNodeConnected({ hub: s.hub, node, connected: true });
    expect((await s.admin.store.respond(s.folderId, s.key, true, "reader"))[0]).toBeNull();
    // Let the asker's phone settle: joining clears any left note on its drive.
    await new Promise((r) => setTimeout(r, 600));
    const held = await openDrive(s.admin, s.key);
    const read = held.readSmall.bind(held);
    held.readSmall = (async (path: string, max: number) => {
      if (path === "/left.json") await whileReading?.();
      return read(path, max);
    }) as typeof held.readSmall;
    const theirs = await openDrive(s.joiner, s.key);
    await theirs.put(
      "/left.json",
      Buffer.from(JSON.stringify({ version: 1, leftAt: Date.now() + 60_000 })),
    );
    const albumDrive = await albumDriveOf(s);
    const keys = async () =>
      Object.keys(JSON.parse((await readText(albumDrive, "/viewers.json"))!).viewers);
    return { ...s, albumDrive, keys };
  }

  it("a Viewer who left has their answer cleared, so the old link asks afresh", async () => {
    const s = await leaver();
    const saved = () =>
      JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    await until(async () => !(await s.keys()).includes(s.key));
    await until(() => (saved().folders[0].answers ?? {})[s.outboxKey] === undefined);
    expect(await s.keys()).toEqual([]);
    expect(saved().folders[0].answers ?? {}).toEqual({});
    await s.close();
  });

  it("a Viewer seated while the drop reads the left note stays on the list", async () => {
    const other = "e".repeat(64);
    let albumDrive: Drive | undefined;
    const s = await leaver(async () => {
      if (!albumDrive) return;
      const file = JSON.parse((await readText(albumDrive, "/viewers.json"))!);
      file.viewers[other] = { key: other, name: "Late", addedAt: Date.now() };
      await albumDrive.put("/viewers.json", Buffer.from(JSON.stringify(file)));
    });
    albumDrive = s.albumDrive;
    await until(async () => !(await s.keys()).includes(s.key));
    expect(await s.keys()).toEqual([other]);
    await s.close();
  });

  it("shows the Viewer connected on the Admin's list while their phone is connected", async () => {
    const s = await asked();
    expect((await s.admin.store.respond(s.folderId, s.key, true, "reader"))[0]).toBeNull();
    let connected = false;
    for (let i = 0; i < 200 && !connected; i++) {
      const status = await s.admin.store.status();
      connected = status.members.some(
        (m: { viewer?: boolean; connected?: boolean }) => m.viewer && m.connected,
      );
      if (!connected) await new Promise((r) => setTimeout(r, 25));
    }
    expect(connected).toBe(true);
    await s.close();
  });

  it("a Collaborator is still the default", async () => {
    const s = await asked();
    expect((await s.admin.store.respond(s.folderId, s.key, true))[0]).toBeNull();
    const albumDrive = await albumDriveOf(s);
    expect(await readText(albumDrive, "/viewers.json")).toBeUndefined();
    expect(await readText(albumDrive, "/members.json")).not.toBeUndefined();
    expect(JSON.parse((await readText(albumDrive, "/members.json"))!).members[s.key].color).toBe(1);
    await s.close();
  });

  it("an old-style request cannot be a Viewer", async () => {
    const s = await scenario();
    await s.joiner.store.join(s.shareKey);
    await connect(s);
    const { requests } = await s.admin.store.requests();
    expect(requests[0].viaInvite).toBeUndefined();
    const refused = await s.admin.store.respond(
      s.folderId,
      requests[0].requesterKey,
      true,
      "reader",
    );
    expect(refused[0]).toMatchObject({ code: PhotoError.VIEWER_NEEDS_INVITE });
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    await s.close();
  });

  it("a role other than reader or member is refused", async () => {
    const s = await asked();
    for (const role of ["creator", "admin", ""]) {
      const refused = await s.admin.store.respond(s.folderId, s.key, true, role as never);
      expect(refused[0], role).toMatchObject({ code: PhotoError.INVALID_ROLE });
    }
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    await s.close();
  });

  it("a failed write takes the answer back, so the request can be retried", async () => {
    const s = await asked();
    const albumDrive = await albumDriveOf(s);
    const put = albumDrive.put.bind(albumDrive);
    albumDrive.put = (async (path: string, data: Buffer) => {
      if (path === "/viewers.json") throw new Error("disk full");
      return put(path, data);
    }) as typeof albumDrive.put;
    const failed = await s.admin.store.respond(s.folderId, s.key, true, "reader");
    expect(failed[0]?.message).toContain("disk full");
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers ?? {}).toEqual({});
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    albumDrive.put = put;
    expect((await s.admin.store.respond(s.folderId, s.key, true, "reader"))[0]).toBeNull();
    await s.close();
  });
});

describe("letting a Viewer add photos", () => {
  async function viewer() {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    const key = requests[0].requesterKey;
    expect((await s.admin.store.respond(s.folderId, key, true, "reader"))[0]).toBeNull();
    return { ...s, key, albumDrive: await albumDriveOf(s) };
  }

  it("shows the Viewer their own seat on their own phone", async () => {
    const s = await viewer();
    await connect(s);
    await s.joiner.store.join(s.shareKey);
    const own = async () =>
      (await s.joiner.store.status()).members.find((m: { viewer?: boolean }) => m.viewer) as
        | { color?: number }
        | undefined;
    await until(async () => (await own())?.color === 1);
    expect((await own())?.color).toBe(1);
    await s.close();
  });

  it("moves the key from /viewers.json to /members.json and loads the drive", async () => {
    const s = await viewer();
    const done = await s.admin.store.makeMember(s.folderId, s.key);
    expect(done[0]).toBeNull();
    const viewers = JSON.parse((await readText(s.albumDrive, "/viewers.json"))!);
    const members = JSON.parse((await readText(s.albumDrive, "/members.json"))!);
    expect(Object.keys(viewers.viewers)).toEqual([]);
    expect(Object.keys(members.members)).toEqual([s.key]);
    const debug = s.admin.store.debugState() as { remoteDrives: { role: string }[] };
    expect(debug.remoteDrives.filter((d) => d.role === "member")).toHaveLength(1);
    const status = await s.admin.store.status();
    expect(status.members.map((m: { viewer?: boolean }) => m.viewer)).toEqual([
      undefined,
      undefined,
    ]);
    await s.close();
  });

  it("refuses with the Spec's codes, in order", async () => {
    const s = await viewer();
    const code = async (folderId: string, key: string) =>
      (await s.admin.store.makeMember(folderId, key))[0]?.code;
    expect(await code("nope", s.key)).toBe(PhotoError.FOLDER_NOT_FOUND);
    expect(await code(s.folderId, "xyz")).toBe(PhotoError.INVALID_KEY);
    expect(await code(s.folderId, s.shareKey)).toBe(PhotoError.INVALID_KEY);
    expect(await code(s.folderId, "ab".repeat(32))).toBe(PhotoError.NOT_FOUND);
    expect(await code(s.folderId, s.key)).toBeUndefined();
    expect(await code(s.folderId, s.key)).toBe(PhotoError.NOT_FOUND);
    await s.close();
  });

  it("only the Admin may do it", async () => {
    const s = await viewer();
    const joined = await s.joiner.store.join(s.shareKey);
    const refused = await s.joiner.store.makeMember(joined[1]!.folder.id, s.key);
    expect(refused[0]?.code).toBe(PhotoError.NOT_CREATOR);
    await s.close();
  });

  it("tells the UI with an enroll change", async () => {
    const changes: unknown[] = [];
    const s = await scenario({ onChanged: (c: unknown) => changes.push(c) });
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const key = (await s.admin.store.requests()).requests[0].requesterKey;
    await s.admin.store.respond(s.folderId, key, true, "reader");
    changes.length = 0;
    expect((await s.admin.store.makeMember(s.folderId, key))[0]).toBeNull();
    expect(changes).toContainEqual({ cause: "enroll", folderId: s.folderId, memberKey: key });
    await s.close();
  });

  it("accepts an uppercase key and normalises it", async () => {
    const s = await viewer();
    expect((await s.admin.store.makeMember(s.folderId, s.key.toUpperCase()))[0]).toBeNull();
    const members = JSON.parse((await readText(s.albumDrive, "/members.json"))!);
    expect(Object.keys(members.members)).toEqual([s.key]);
    await s.close();
  });

  it("a first write failing leaves both files untouched", async () => {
    const s = await viewer();
    const put = s.albumDrive.put.bind(s.albumDrive);
    s.albumDrive.put = (async (path: string, data: Buffer) => {
      if (path === "/members.json") throw new Error("disk full");
      return put(path, data);
    }) as typeof s.albumDrive.put;
    const failed = await s.admin.store.makeMember(s.folderId, s.key);
    expect(failed[0]?.message).toContain("disk full");
    s.albumDrive.put = put;
    const viewers = JSON.parse((await readText(s.albumDrive, "/viewers.json"))!);
    expect(Object.keys(viewers.viewers)).toEqual([s.key]);
    expect(await readText(s.albumDrive, "/members.json")).toBeUndefined();
    await s.close();
  });

  it("a failed second write leaves the person a Collaborator", async () => {
    const s = await viewer();
    const put = s.albumDrive.put.bind(s.albumDrive);
    s.albumDrive.put = (async (path: string, data: Buffer) => {
      if (path === "/viewers.json") throw new Error("disk full");
      return put(path, data);
    }) as typeof s.albumDrive.put;
    const failed = await s.admin.store.makeMember(s.folderId, s.key);
    expect(failed[0]?.message).toContain("disk full");
    s.albumDrive.put = put;
    const status = await s.admin.store.status();
    expect(status.members.map((m: { viewer?: boolean }) => m.viewer)).toEqual([
      undefined,
      undefined,
    ]);
    const members = JSON.parse((await readText(s.albumDrive, "/members.json"))!);
    expect(Object.keys(members.members)).toEqual([s.key]);
    expect((await s.admin.store.makeMember(s.folderId, s.key))[0]?.code).toBe(
      PhotoError.ALREADY_ENROLLED,
    );
    await s.close();
  });
});

describe("making a Collaborator a Viewer", () => {
  async function collaborator() {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    const key = requests[0].requesterKey;
    expect((await s.admin.store.respond(s.folderId, key, true))[0]).toBeNull();
    return { ...s, key, albumDrive: await albumDriveOf(s) };
  }

  it("a joiner accepted as Collaborator through a link is not told about a role change", async () => {
    const changes: { cause: string }[] = [];
    const s = await scenario(undefined, { onChanged: (c: { cause: string }) => changes.push(c) });
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    const key = requests[0].requesterKey;
    expect((await s.admin.store.respond(s.folderId, key, true))[0]).toBeNull();
    await until(async () => {
      const { folders } = await s.joiner.store.folders();
      return folders.some((f) => f.role === "member");
    });
    expect(changes.filter((c) => c.cause === "role")).toEqual([]);
    expect((await s.admin.store.makeViewer(s.folderId, key))[0]).toBeNull();
    await until(() => changes.some((c) => c.cause === "role"));
    expect(changes.filter((c) => c.cause === "role")).toHaveLength(1);
    await s.close();
  });

  it("moves them to /viewers.json with a kept version and shows them as a Viewer", async () => {
    const s = await collaborator();
    expect((await s.admin.store.makeViewer(s.folderId, s.key.toUpperCase()))[0]).toBeNull();
    const viewers = JSON.parse((await readText(s.albumDrive, "/viewers.json"))!);
    const members = JSON.parse((await readText(s.albumDrive, "/members.json"))!);
    expect(Object.keys(members.members)).toEqual([]);
    expect(Number.isInteger(viewers.viewers[s.key].keptVersion)).toBe(true);
    const status = await s.admin.store.status();
    expect(status.members.map((m: { viewer?: boolean }) => m.viewer)).toEqual([undefined, true]);
    expect((await s.admin.store.makeViewer(s.folderId, s.key))[0]).toBeNull();
    await s.close();
  });

  /** Counts the Viewer's drives the Admin's store opened since now and has not given back. */
  function spy(s: Awaited<ReturnType<typeof collaborator>>) {
    const refs = new Map<Drive, number>();
    const log = {
      opened: 0,
      joins: [] as boolean[],
      held: () => [...refs.values()].reduce((sum, n) => sum + n, 0),
    };
    const { drives, network } = s.admin.deps;
    const open = drives.open.bind(drives);
    drives.open = (async (key: string, opts: never) => {
      const [err, drive] = await open(key, opts);
      if (drive && key === s.key) {
        log.opened++;
        refs.set(drive, (refs.get(drive) ?? 0) + 1);
      }
      return [err, drive];
    }) as typeof drives.open;
    const openAt = drives.openAt.bind(drives);
    drives.openAt = (async (key: string, version: number, opts: never) => {
      const [err, drive] = await openAt(key, version, opts);
      if (drive && key === s.key) refs.set(drive, (refs.get(drive) ?? 0) + 1);
      return [err, drive];
    }) as typeof drives.openAt;
    const release = drives.release.bind(drives);
    drives.release = (async (drive: Drive) => {
      const n = refs.get(drive);
      if (n) refs.set(drive, n - 1);
      return release(drive);
    }) as typeof drives.release;
    const join = network.join.bind(network);
    network.join = ((topic: string, opts: { server: boolean }) => {
      log.joins.push(opts.server);
      return join(topic, opts);
    }) as typeof network.join;
    return log;
  }

  it("reads a Viewer's drive without serving it, and gives it back when they are a Collaborator again", async () => {
    const s = await collaborator();
    const log = spy(s);
    expect((await s.admin.store.makeViewer(s.folderId, s.key))[0]).toBeNull();
    await connect(s);
    await until(() => log.joins.length > 0);
    await until(() => log.opened > 0);
    expect(log.opened, "the Viewer's drive is opened for its device.json").toBeGreaterThan(0);
    expect(log.joins.length).toBeGreaterThan(0);
    expect(log.joins, "read-only").not.toContain(true);
    expect((await s.admin.store.makeMember(s.folderId, s.key))[0]).toBeNull();
    await s.admin.store.status();
    await until(() => log.held() === 1);
    expect(log.held(), "only the Collaborator's own drive is held").toBe(1);
    await s.close();
  });

  it("gives the Viewer's drive back when the Admin's store closes", async () => {
    const s = await collaborator();
    const log = spy(s);
    expect((await s.admin.store.makeViewer(s.folderId, s.key))[0]).toBeNull();
    await connect(s);
    await until(() => log.joins.length > 0);
    await until(() => log.opened > 0);
    await s.admin.store.close();
    expect(log.held(), "every open of the Viewer's drive was given back").toBe(0);
    await s.close();
  });

  it("a closed store does not keep a Viewer's drive that finished opening late", async () => {
    const s = await collaborator();
    const log = spy(s);
    const open = s.admin.deps.drives.open.bind(s.admin.deps.drives);
    let gate: () => void = () => {};
    let waiting = 0;
    let armed = false;
    const held = new Promise<void>((r) => (gate = r));
    s.admin.deps.drives.open = (async (key: string, opts: never) => {
      if (key === s.key && armed) {
        waiting++;
        await held;
      }
      return open(key, opts);
    }) as typeof s.admin.deps.drives.open;
    expect((await s.admin.store.makeViewer(s.folderId, s.key))[0]).toBeNull();
    armed = true;
    await connect(s);
    await until(() => waiting > 0);
    expect(waiting).toBeGreaterThan(0);
    // The late open settles while the store is closing, before its drives shut.
    const closeNetwork = s.admin.deps.network.close.bind(s.admin.deps.network);
    s.admin.deps.network.close = async () => {
      gate();
      await new Promise((r) => setTimeout(r, 100));
      return closeNetwork();
    };
    await s.admin.store.close();
    await until(() => log.held() === 0);
    expect(log.held(), "every drive opened was given back").toBe(0);
    await s.close();
  });

  it("a Viewer can be made a Collaborator again", async () => {
    const s = await collaborator();
    expect((await s.admin.store.makeViewer(s.folderId, s.key))[0]).toBeNull();
    expect((await s.admin.store.makeMember(s.folderId, s.key))[0]).toBeNull();
    const status = await s.admin.store.status();
    expect(status.members.map((m: { viewer?: boolean }) => m.viewer)).toEqual([
      undefined,
      undefined,
    ]);
    await s.close();
  });

  it("refuses a stranger, a bad key and a non-Admin", async () => {
    const s = await collaborator();
    expect((await s.admin.store.makeViewer(s.folderId, "ab".repeat(32)))[0]).toMatchObject({
      code: PhotoError.NOT_FOUND,
    });
    expect((await s.admin.store.makeViewer(s.folderId, "nope"))[0]).toMatchObject({
      code: PhotoError.INVALID_KEY,
    });
    expect((await s.admin.store.makeViewer("missing", s.key))[0]).toMatchObject({
      code: PhotoError.FOLDER_NOT_FOUND,
    });
    await s.close();
  });

  it("a failed write is reported", async () => {
    const s = await collaborator();
    const put = s.albumDrive.put.bind(s.albumDrive);
    s.albumDrive.put = (async (path: string, data: Buffer) => {
      if (path === "/viewers.json") throw new Error("disk full");
      return put(path, data);
    }) as typeof s.albumDrive.put;
    const failed = await s.admin.store.makeViewer(s.folderId, s.key);
    expect(failed[0]?.message).toContain("disk full");
    s.albumDrive.put = put;
    expect((await s.admin.store.makeViewer(s.folderId, s.key))[0]).toBeNull();
    await s.close();
  });
});

describe("turning off invite links", () => {
  async function asked(s: Awaited<ReturnType<typeof scenario>>, code: string) {
    await s.joiner.store.ask({ code, owner: s.owner });
    await connect(s);
    return (await s.admin.store.requests()).requests;
  }

  it("a request made with a turned-off code never reaches the Admin", async () => {
    const s = await scenario();
    const turned = await s.admin.store.turnOffInvite(s.folderId);
    expect(turned[0]).toBeNull();
    expect(await asked(s, s.invite.code)).toEqual([]);
    await s.close();
  });

  it("a request filed before the turn-off and not answered disappears", async () => {
    const s = await scenario();
    expect(await asked(s, s.invite.code)).toHaveLength(1);
    await s.admin.store.turnOffInvite(s.folderId);
    await connect(s);
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("the album gets a new code and a request with it reaches the Admin", async () => {
    const s = await scenario();
    const turned = await s.admin.store.turnOffInvite(s.folderId);
    const { code, owner } = turned[1]!.invite;
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(code).not.toBe(s.invite.code);
    expect(owner).toBe(s.owner);
    const summary = (await s.admin.store.folders()).folders.find((f) => f.id === s.folderId);
    expect(summary!.invite!.code).toBe(code);
    expect(await asked(s, code)).toHaveLength(1);
    await s.close();
  });

  it("the new code survives a restart", async () => {
    const s = await scenario();
    const code = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
    await s.admin.store.close();
    const reopened = createPhotoStore(restarted(s.admin.deps));
    await reopened.ready();
    const summary = (await reopened.folders()).folders.find((f) => f.id === s.folderId);
    expect(summary!.invite!.code).toBe(code);
    await reopened.close();
    await s.joiner.store.close();
  });

  it("answers are kept", async () => {
    const s = await scenario();
    const first = await asked(s, s.invite.code);
    await s.admin.store.respond(s.folderId, first[0].requesterKey, false);
    const code = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
    expect(await asked(s, code)).toHaveLength(1);
    const identity = s.outboxKey;
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers).toEqual({ [identity]: "declined" });
    await s.close();
  });

  it.each([[true], [false]])(
    "an answer given before the turn-off still reaches the joiner (accept=%s)",
    async (accept) => {
      // I8: a tee on the joiner's network records the connections and the
      // answers that reach it.
      const hub = createFakeHub();
      const net = createFakePeerNetwork({ hub });
      const arrived: { code: string; answer: string }[] = [];
      const conns: number[] = [];
      const joinerNetwork: PeerNetwork = {
        ...net,
        start: (identity, on, protocol) =>
          net.start(
            identity,
            (e: PeerEvent) => {
              if (e.type === "connected") conns.push(e.conn);
              if (e.type === "answer") arrived.push(e.value as { code: string; answer: string });
              on(e);
            },
            protocol,
          ),
      };
      const s = await scenario({}, { network: joinerNetwork }, hub);
      await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
      // Proven: the joiner's own network meets the Admin, so its noise key is
      // the one its /device.json publishes.
      joinerNetwork.join(s.adminTopic, { server: false });
      await until(() => conns.length > 0);
      await until(async () => (await s.admin.store.requests()).requests.length > 0);
      const first = (await s.admin.store.requests()).requests;
      await s.admin.store.respond(s.folderId, first[0].requesterKey, accept);
      await until(() => arrived.length >= 1, 4_000);
      expect(arrived).toHaveLength(1);
      const code1 = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
      const code2 = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
      expect(new Set([s.invite.code, code1, code2]).size).toBe(3);
      for (const conn of conns) joinerNetwork.drop(conn);
      joinerNetwork.leave(s.adminTopic);
      joinerNetwork.join(s.adminTopic, { server: false });
      const old = () => arrived.filter((m) => m.code === s.invite.code);
      // Once on the connection before the turn-off, once on the new one.
      await until(() => old().length >= 2, 4_000);
      const answer = accept ? "accepted" : "declined";
      expect(old().map((m) => m.answer)).toEqual([answer, answer]);
      await s.close();
    },
  );

  it("only the creator can turn off", async () => {
    const s = await scenario();
    await s.joiner.store.join(s.shareKey);
    const joinedId = (await s.joiner.store.folders()).folders[0].id;
    expect((await s.joiner.store.turnOffInvite(joinedId))[0]).toMatchObject({
      code: PhotoError.NOT_CREATOR,
    });
    expect((await s.admin.store.turnOffInvite("nope"))[0]).toMatchObject({
      code: PhotoError.FOLDER_NOT_FOUND,
    });
    await s.close();
  });
});

describe("cancel a waiting request", () => {
  const savedAsks = (s: Awaited<ReturnType<typeof scenario>>) =>
    JSON.parse(readFileSync(join(s.joiner.deps.storageDir, "justus.json"), "utf8")).asks;

  it("takes the ask off the phone, the saved file and the outbox", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await filedOutbox(s);
    const cancelled = await s.joiner.store.cancelAsk(s.invite.code);
    expect(cancelled).toEqual([null, { ok: true }]);
    expect((await s.joiner.store.folders()).asks).toEqual([]);
    expect(savedAsks(s)).toEqual([]);
    expect(
      JSON.parse(await outboxText(s.outbox)).requests[`invite:${s.invite.code}`],
    ).toBeUndefined();
    await s.close();
  });

  it("leaves the invite topic", async () => {
    const s = await scenario();
    const topics = () =>
      (s.joiner.store.debugState() as { joins: { topic: string }[] }).joins.map((j) => j.topic);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await filedOutbox(s);
    const before = topics();
    await s.joiner.store.cancelAsk(s.invite.code);
    const after = topics();
    expect(after).toHaveLength(before.length - 1);
    expect(after.every((t) => before.includes(t))).toBe(true);
    await s.close();
  });

  it("tells the UI with an ask change", async () => {
    const changes: unknown[] = [];
    const s = await scenario(undefined, { onChanged: (c: unknown) => changes.push(c) });
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    changes.length = 0;
    await s.joiner.store.cancelAsk(s.invite.code);
    expect(changes).toContainEqual({ cause: "ask", code: s.invite.code });
    await s.close();
  });

  it("the Admin stops seeing the request", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    await s.joiner.store.cancelAsk(s.invite.code);
    await until(async () => (await s.admin.store.requests()).requests.length === 0);
    await s.close();
  });

  it("asking again after Cancel files a new waiting ask", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await s.joiner.store.cancelAsk(s.invite.code);
    const again = await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    expect(again[1]!.ask.status).toBe("waiting");
    await connect(s);
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    await s.close();
  });

  it("is refused for an unknown code", async () => {
    const s = await scenario();
    const cancelled = await s.joiner.store.cancelAsk("e".repeat(64));
    expect(cancelled[0]!.code).toBe(PhotoError.NOT_FOUND);
    await s.close();
  });

  it("is refused for a declined ask, which stays", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await connect(s);
    const { requests } = await s.admin.store.requests();
    await s.admin.store.respond(s.folderId, requests[0].requesterKey, false);
    await until(async () => (await s.joiner.store.folders()).asks[0]?.status === "declined");
    const cancelled = await s.joiner.store.cancelAsk(s.invite.code);
    expect(cancelled[0]!.code).toBe(PhotoError.NOT_FOUND);
    expect(savedAsks(s)).toHaveLength(1);
    await s.close();
  });
});

describe("a request through a turned-off link", () => {
  type Arrived = { code: string; answer: string; askedAt?: number };
  const topicHex = (code: string) =>
    Buffer.from(inviteTopic(code, nodeCrypto as unknown as typeof import("bare-crypto"))).toString(
      "hex",
    );
  const joinsOf = (store: { debugState(): unknown }) =>
    (store.debugState() as { joins: { topic: string }[] }).joins.map((j) => j.topic);

  /** A scenario whose joiner network records the answers that reach it. */
  async function teed(adminDeps?: Partial<FakeStoreDeps>, joinerDeps?: Partial<FakeStoreDeps>) {
    const hub = createFakeHub();
    const net = createFakePeerNetwork({ hub });
    const arrived: Arrived[] = [];
    const joinerNetwork: PeerNetwork = {
      ...net,
      start: (identity, on, protocol) =>
        net.start(
          identity,
          (e: PeerEvent) => {
            if (e.type === "answer") arrived.push(e.value as Arrived);
            on(e);
          },
          protocol,
        ),
    };
    const changes: unknown[] = [];
    const s = await scenario(
      adminDeps,
      { network: joinerNetwork, onChanged: (c: unknown) => changes.push(c), ...joinerDeps },
      hub,
    );
    return { s, arrived, changes, joinerNetwork };
  }

  const askStatus = async (s: Awaited<ReturnType<typeof scenario>>) =>
    (await s.joiner.store.folders()).asks[0]?.status;

  it("a joiner waiting when links are turned off is told the link no longer works, and nothing else", async () => {
    const { s, arrived, changes, joinerNetwork } = await teed();
    const asked = await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    const askedAt = asked[1]!.ask.askedAt;
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    await s.admin.store.turnOffInvite(s.folderId);
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    const linkOff = arrived.filter((m) => m.answer === "linkOff");
    expect(linkOff).toEqual([
      { code: s.invite.code, answer: "linkOff", askedAt, why: "turnedOff" },
    ]);
    expect(Object.keys(linkOff[0]).sort()).toEqual(["answer", "askedAt", "code", "why"]);
    expect((await s.joiner.store.folders()).asks[0]).toMatchObject({ why: "turnedOff" });
    expect((await s.joiner.store.folders()).folders).toEqual([]);
    expect(JSON.parse(await outboxText(s.outbox)).requests[`invite:${s.invite.code}`]).toBe(
      undefined,
    );
    expect(joinsOf(s.joiner.store)).not.toContain(topicHex(s.invite.code));
    expect(joinsOf(s.admin.store)).toContain(topicHex(s.invite.code));
    expect(changes).toContainEqual({
      cause: "ask",
      code: s.invite.code,
      answer: "linkOff",
      why: "turnedOff",
    });
    await s.close();
  });

  it("after a restart the Admin still serves a turned-off code and tells a joiner who asks through it", async () => {
    const { s, joinerNetwork } = await teed();
    await s.admin.store.turnOffInvite(s.folderId);
    await s.admin.store.close();
    const reopened = createPhotoStore(restarted(s.admin.deps));
    await reopened.ready();
    expect(joinsOf(reopened)).toContain(topicHex(s.invite.code));
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    expect((await s.joiner.store.folders()).asks[0]!.why).toBe("turnedOff");
    await reopened.close();
    await s.joiner.store.close();
  });

  it("a link turned off after a restart is still answered as turned off after the next one", async () => {
    const { s, joinerNetwork } = await teed();
    await s.admin.store.close();
    const first = createPhotoStore(restarted(s.admin.deps));
    await first.ready();
    await first.turnOffInvite(s.folderId);
    await first.close();
    const second = createPhotoStore(restarted(s.admin.deps));
    await second.ready();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect((await s.joiner.store.folders()).asks[0]!.why).toBe("turnedOff");
    await second.close();
    await s.joiner.store.close();
  });

  const savedGone = (s: { admin: { deps: { storageDir: string } } }) =>
    (
      JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8")) as {
        gone: { kind: string; inviteCodes?: string[] }[];
      }
    ).gone;

  it("a joiner waiting when the Admin deletes the album is told the link no longer works", async () => {
    const { s, arrived, joinerNetwork } = await teed();
    const asked = await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    const askedAt = asked[1]!.ask.askedAt;
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    const deleted = await s.admin.store.deleteAlbum(s.folderId);
    expect(deleted[0]).toBe(null);
    await until(async () => (await askStatus(s)) === "linkOff", 600);
    expect(await askStatus(s)).toBe("linkOff");
    expect(arrived.filter((m) => m.answer === "linkOff")).toEqual([
      { code: s.invite.code, answer: "linkOff", askedAt, why: "albumDeleted" },
    ]);
    expect((await s.joiner.store.folders()).asks[0]!.why).toBe("albumDeleted");
    expect((await s.joiner.store.folders()).folders).toEqual([]);
    expect(joinsOf(s.joiner.store)).not.toContain(topicHex(s.invite.code));
    expect(joinsOf(s.admin.store)).toContain(topicHex(s.invite.code));
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("an ask through a deleted album's link is told it no longer works", async () => {
    const { s, joinerNetwork } = await teed();
    expect((await s.admin.store.deleteAlbum(s.folderId))[0]).toBe(null);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("a turned-off code of a deleted album is answered too", async () => {
    const { s, joinerNetwork } = await teed();
    await s.admin.store.turnOffInvite(s.folderId);
    expect((await s.admin.store.deleteAlbum(s.folderId))[0]).toBe(null);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    expect(savedGone(s)[0]!.inviteCodes).toHaveLength(2);
    await s.close();
  });

  it("after a restart the Admin still serves a deleted album's codes", async () => {
    const { s, joinerNetwork } = await teed();
    expect((await s.admin.store.deleteAlbum(s.folderId))[0]).toBe(null);
    expect(savedGone(s)).toMatchObject([
      { kind: "deletedForEveryone", inviteCodes: [s.invite.code] },
    ]);
    await s.admin.store.close();
    const reopened = createPhotoStore(restarted(s.admin.deps));
    await reopened.ready();
    expect(joinsOf(reopened)).toContain(topicHex(s.invite.code));
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    await reopened.close();
    await s.joiner.store.close();
  });

  it("a gone record with bad codes keeps only hex ones", async () => {
    const storageDir = makeTmpDir("justus-gone-codes-");
    const code = "ab".repeat(32);
    const other = "ba".repeat(32);
    writeFileSync(
      join(storageDir, "justus.json"),
      JSON.stringify({
        version: 2,
        name: "Admin",
        folders: [],
        activeFolderId: null,
        asks: [],
        offers: [],
        gone: [
          {
            id: "f1",
            name: "Trip",
            shareKey: "cd".repeat(32),
            kind: "deletedForEveryone",
            inviteCodes: ["zz", code, 7],
            at: 1,
          },
          {
            id: "f2",
            name: "Other",
            shareKey: "ef".repeat(32),
            kind: "deletedByAdmin",
            inviteCodes: [other],
            at: 1,
          },
        ],
      }),
    );
    const { store } = buildStore("Admin", createFakeHub(), { storageDir });
    await store.ready();
    const gone = (store.debugState() as { gone: { id: string; inviteCodes?: string[] }[] }).gone;
    expect(gone.find((g) => g.id === "f1")?.inviteCodes).toEqual([code]);
    expect(gone.find((g) => g.id === "f2")?.inviteCodes).toBeUndefined();
    expect(joinsOf(store)).toContain(topicHex(code));
    expect(joinsOf(store)).not.toContain(topicHex(other));
    await store.close();
  });

  it("a request through the live code gets no linkOff", async () => {
    const { s, arrived, joinerNetwork } = await teed();
    const code = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
    await s.joiner.store.ask({ code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await askStatus(s)).toBe("waiting");
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    expect(arrived.filter((m) => m.answer === "linkOff")).toEqual([]);
    await s.close();
  });

  it("an answer given before the turn-off is not followed by a linkOff", async () => {
    const { s, arrived, joinerNetwork } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const first = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, first[0].requesterKey, false);
    await until(() => arrived.length >= 1, 4_000);
    await s.admin.store.turnOffInvite(s.folderId);
    await new Promise((r) => setTimeout(r, 200));
    expect(arrived.some((m) => m.answer === "linkOff")).toBe(false);
    await s.close();
  });

  it("Close on a linkOff request hides it and the phone still knows the link is off", async () => {
    const { s, joinerNetwork, changes } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    await s.admin.store.turnOffInvite(s.folderId);
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect((await s.joiner.store.folders()).asks[0]!.closed).toBeUndefined();
    changes.length = 0;
    expect(await s.joiner.store.cancelAsk(s.invite.code)).toEqual([null, { ok: true }]);
    expect(changes).toContainEqual({ cause: "ask", code: s.invite.code });
    const kept = (await s.joiner.store.folders()).asks;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ status: "linkOff", why: "turnedOff", closed: true });
    await s.joiner.store.close();
    const reopened = createPhotoStore(restarted(s.joiner.deps));
    await reopened.ready();
    expect((await reopened.folders()).asks[0]).toMatchObject({
      status: "linkOff",
      why: "turnedOff",
      closed: true,
    });
    const again = await reopened.ask({ code: s.invite.code, owner: s.owner });
    expect(again[1]!.ask).toMatchObject({ status: "linkOff", closed: true });
    expect(joinsOf(reopened)).not.toContain(topicHex(s.invite.code));
    await reopened.close();
    await s.admin.store.close();
  });

  it("a linkOff answer from an older Admin phone, with no reason, stores none", async () => {
    const hub = createFakeHub();
    const net = createFakePeerNetwork({ hub });
    const older: PeerNetwork = {
      ...net,
      start: (identity, on, protocol) =>
        net.start(
          identity,
          (e: PeerEvent) => {
            if (e.type === "answer") delete (e.value as { why?: string }).why;
            on(e);
          },
          protocol,
        ),
    };
    const s = await scenario(undefined, { network: older }, hub);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    older.join(s.adminTopic, { server: false });
    await s.admin.store.turnOffInvite(s.folderId);
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    const [ask] = (await s.joiner.store.folders()).asks;
    expect(ask!.status).toBe("linkOff");
    expect(ask).not.toHaveProperty("why");
    await s.close();
  });

  it("a person removed from the album: an ask through the old link says it was replaced", async () => {
    const { s, joinerNetwork } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const [req] = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, req.requesterKey, true);
    await until(async () => (await s.joiner.store.folders()).folders.length === 1, 4_000);
    expect((await s.admin.store.removeMember(s.folderId, req.requesterKey))[0]).toBeNull();
    const c = buildStore("Cy", s.hub);
    await c.store.ready();
    await c.store.ask({ code: s.invite.code, owner: s.owner });
    c.deps.network.join(s.adminTopic, { server: false });
    await until(async () => (await c.store.folders()).asks[0]?.status === "linkOff", 4_000);
    expect((await c.store.folders()).asks[0]).toMatchObject({ status: "linkOff", why: "replaced" });
    await c.store.close();
    await s.close();
  });

  it("Remove then Turn off: the code the Remove retired still answers replaced", async () => {
    const { s, joinerNetwork } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const [req] = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, req.requesterKey, true);
    await until(async () => (await s.joiner.store.folders()).folders.length === 1, 4_000);
    await s.admin.store.removeMember(s.folderId, req.requesterKey);
    await s.admin.store.turnOffInvite(s.folderId);
    const c = buildStore("Cy", s.hub);
    await c.store.ready();
    await c.store.ask({ code: s.invite.code, owner: s.owner });
    c.deps.network.join(s.adminTopic, { server: false });
    await until(async () => (await c.store.folders()).asks[0]?.status === "linkOff", 4_000);
    expect((await c.store.folders()).asks[0]).toMatchObject({ status: "linkOff", why: "replaced" });
    await c.store.close();
    await s.close();
  });

  it("Turn off then Remove: the code Turn off retired still answers turnedOff", async () => {
    const { s, joinerNetwork } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const [req] = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, req.requesterKey, true);
    await until(async () => (await s.joiner.store.folders()).folders.length === 1, 4_000);
    await s.admin.store.turnOffInvite(s.folderId);
    await s.admin.store.removeMember(s.folderId, req.requesterKey);
    await s.admin.store.turnOffInvite(s.folderId);
    const c = buildStore("Cy", s.hub);
    await c.store.ready();
    await c.store.ask({ code: s.invite.code, owner: s.owner });
    c.deps.network.join(s.adminTopic, { server: false });
    await until(async () => (await c.store.folders()).asks[0]?.status === "linkOff", 4_000);
    expect((await c.store.folders()).asks[0]).toMatchObject({
      status: "linkOff",
      why: "turnedOff",
    });
    await c.store.close();
    await s.close();
  });

  it("bad saved reasons are dropped on load", async () => {
    const { s } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await s.admin.store.turnOffInvite(s.folderId);
    await s.admin.store.close();
    await s.joiner.store.close();
    const hex = "ab".repeat(32);
    const adminFile = join(s.admin.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(adminFile, "utf8"));
    saved.folders[0].retiredWhy = {
      [hex]: "turnedOff",
      nothex: "replaced",
      [`${"cd".repeat(32)}`]: "bogus",
    };
    writeFileSync(adminFile, JSON.stringify(saved));
    const admin = createPhotoStore(restarted(s.admin.deps));
    await admin.ready();
    await admin.turnOffInvite(s.folderId);
    const kept = JSON.parse(readFileSync(adminFile, "utf8")).folders[0].retiredWhy;
    expect(Object.keys(kept)).toContain(hex);
    expect(kept[hex]).toBe("turnedOff");
    expect(kept).not.toHaveProperty("nothex");
    expect(kept).not.toHaveProperty("cd".repeat(32));
    await admin.close();
    const joinerFile = join(s.joiner.deps.storageDir, "justus.json");
    const js = JSON.parse(readFileSync(joinerFile, "utf8"));
    js.asks = [
      { ...js.asks[0], status: "linkOff", why: "bogus" },
      { ...js.asks[0], code: "zz", status: "linkOff", why: "turnedOff" },
      { ...js.asks[0], code: hex, status: "waiting", why: "turnedOff" },
    ];
    writeFileSync(joinerFile, JSON.stringify(js));
    const joiner = createPhotoStore(restarted(s.joiner.deps));
    await joiner.ready();
    const asks = (await joiner.folders()).asks;
    expect(asks.map((a) => [a.code, a.status])).toEqual([
      [js.asks[0].code, "linkOff"],
      [hex, "waiting"],
    ]);
    expect(asks.every((a) => !("why" in a))).toBe(true);
    await joiner.close();
  });

  it("a new ask to the same Admin and album replaces the linkOff row", async () => {
    const { s, joinerNetwork } = await teed();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const code = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    await s.joiner.store.ask({ code, owner: s.owner });
    const asks = (await s.joiner.store.folders()).asks;
    expect(asks.map((a) => [a.code, a.status])).toEqual([[code, "waiting"]]);
    await s.close();
  });

  /** Back-dates the joiner's ask by writing `requestedAt` in its outbox. */
  async function backdate(s: Awaited<ReturnType<typeof scenario>>, ms: number) {
    const file = JSON.parse(await filedOutbox(s));
    file.requests[`invite:${s.invite.code}`].requestedAt -= ms;
    await s.outbox.put("/requests.json", Buffer.from(JSON.stringify(file)));
  }

  it("an ask sent after every link ended is not listed, and the joiner hears the link no longer works", async () => {
    const { s, arrived, joinerNetwork } = await teed();
    const [saveErr] = await s.admin.store.saveInviteLink(s.folderId, Date.now() + 60_000);
    expect(saveErr).toBeNull();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await backdate(s, -2 * 60 * 60_000);
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    expect(arrived.filter((m) => m.answer === "linkOff")).toHaveLength(1);
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("an ask sent while the link works is listed", async () => {
    const { s, joinerNetwork } = await teed();
    await s.admin.store.saveInviteLink(s.folderId, Date.now() + 60_000);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    expect(await askStatus(s)).toBe("waiting");
    await s.close();
  });

  it("link times survive a restart, so a late ask is still turned away", async () => {
    const { s, joinerNetwork } = await teed();
    await s.admin.store.saveInviteLink(s.folderId, Date.now() + 60_000);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await backdate(s, -2 * 60 * 60_000);
    await s.admin.store.close();
    const reopened = createPhotoStore(restarted(s.admin.deps));
    await reopened.ready();
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await askStatus(s)) === "linkOff", 4_000);
    expect(await askStatus(s)).toBe("linkOff");
    expect((await reopened.requests()).requests).toEqual([]);
    await reopened.close();
    await s.joiner.store.close();
  });

  it("a late invite ask is not listed, while an in-time ask is", async () => {
    const { s, joinerNetwork } = await teed();
    await s.admin.store.saveInviteLink(s.folderId, Date.now() + 60_000);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    expect((await s.admin.store.requests()).requests).toHaveLength(1);
    await backdate(s, -2 * 60 * 60_000);
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("asking the Admin again about a late ask pushes linkOff once", async () => {
    const { s, arrived, joinerNetwork } = await teed();
    await s.admin.store.saveInviteLink(s.folderId, Date.now() + 60_000);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await backdate(s, -2 * 60 * 60_000);
    joinerNetwork.join(s.adminTopic, { server: false });
    await until(async () => arrived.some((m) => m.answer === "linkOff"), 4_000);
    for (let i = 0; i < 5; i++) await s.admin.store.requests();
    await new Promise((r) => setTimeout(r, 100));
    expect(arrived.filter((m) => m.answer === "linkOff")).toHaveLength(1);
    await s.close();
  });

  it("the same end time saved twice is one link, and only the last 50 links are kept", async () => {
    const { s } = await teed();
    const base = Date.now() + 60_000;
    const savedLinks = () => {
      const state = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
      return state.folders.find((f: { id: string }) => f.id === s.folderId).invite.links;
    };
    await s.admin.store.saveInviteLink(s.folderId, base);
    await s.admin.store.saveInviteLink(s.folderId, base);
    await s.admin.store.saveInviteLink(s.folderId, base + 1);
    expect(savedLinks()).toHaveLength(2);
    for (let i = 2; i < 52; i++) await s.admin.store.saveInviteLink(s.folderId, base + i);
    const links = savedLinks();
    expect(links).toHaveLength(50);
    expect(links.map((l: { to: number }) => l.to)).toEqual(
      Array.from({ length: 50 }, (_, i) => base + i + 2),
    );
    await s.close();
  });

  it("saveInviteLink refuses a time more than 7 days ahead, a past time and an unknown album", async () => {
    const { s } = await teed();
    const far = Date.now() + 8 * 24 * 60 * 60_000;
    expect((await s.admin.store.saveInviteLink(s.folderId, far))[0]!.code).toBe(
      PhotoError.INVALID_LINK_TIME,
    );
    expect((await s.admin.store.saveInviteLink(s.folderId, Date.now() - 1))[0]!.code).toBe(
      PhotoError.INVALID_LINK_TIME,
    );
    expect((await s.admin.store.saveInviteLink("nope", Date.now() + 1000))[0]!.code).toBe(
      PhotoError.FOLDER_NOT_FOUND,
    );
    await s.close();
  });
});

describe("the Admin's sealing key", () => {
  it("the Admin's identity /device.json names its sealing key, also after a restart", async () => {
    const s = await scenario();
    const [boxErr, box] = await s.admin.deps.drives.boxPublicKey();
    expect(boxErr).toBeNull();
    const named = async (on: { deps: FakeStoreDeps }) =>
      boxKeyOf((await readText(await openDrive(on, s.owner), "/device.json")) ?? null);
    expect(await named(s.joiner)).toBe(box);
    await s.admin.store.close();
    const reopened = createPhotoStore(restarted(s.admin.deps));
    await reopened.ready();
    expect(await named(s.joiner)).toBe(box);
    await reopened.close();
    await s.joiner.store.close();
  });

  it("publishes /device.json without a sealing key, and logs it, when the key cannot be read", async () => {
    const s = await scenario();
    await s.admin.store.close();
    const base = restarted(s.admin.deps);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const failing = createPhotoStore({
      ...base,
      drives: Object.assign(Object.create(base.drives), {
        boxPublicKey: async () => [new Error("no box"), null],
      }),
      log: (e: { event: string; fields: Record<string, unknown> }) => events.push(e),
    } as never);
    await failing.ready();
    const text = await readText(await openDrive(s.joiner, s.owner), "/device.json");
    expect(boxKeyOf(text ?? null)).toBeUndefined();
    expect(JSON.parse(text!).identityKey).toBeDefined();
    expect(events.some((e) => e.event === "error" && e.fields.where === "box.key")).toBe(true);
    await failing.close();
    await s.joiner.store.close();
  });
});

describe("a joiner's ask is sealed to the Admin's phone", () => {
  it("no version of the joiner's outbox names the drive it asked with", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await filedOutbox(s);
    await connect(s);
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const driveKey = (await s.admin.store.requests()).requests[0]!.requesterKey;
    const accepted = await s.admin.store.respond(s.folderId, driveKey, true, "member");
    expect(accepted[0]).toBeNull();
    await until(async () => (await s.joiner.store.folders()).folders.length === 1);
    const versions = s.outbox.version();
    expect(versions, "the outbox has history").toBeGreaterThan(1);
    for (let v = 1; v <= versions; v++) {
      const [err, old] = await s.joiner.deps.drives.openAt(s.outboxKey, v, { timeoutMs: 1_000 });
      if (err || !old) throw err ?? new Error("version did not open");
      const text = (await old.readSmall("/requests.json", 1 << 20)) ?? "";
      expect(text.includes(driveKey), `version ${v} of the outbox`).toBe(false);
    }
    await s.close();
  });

  it(
    "an ask made while the Admin's phone is away is filed when it comes back",
    { timeout: 20_000 },
    async () => {
      const s = await scenario();
      await s.admin.store.close();
      for (const node of s.hub.nodes) {
        if (node === s.admin.deps.node)
          setFakeNodeConnected({ hub: s.hub, node, connected: false });
      }
      const asked = await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
      expect(asked[1]!.ask.status).toBe("waiting");
      // Longer than the 5 s the filing waits for the Admin's key.
      await until(async () => false, 5_500);
      expect(await outboxText(s.outbox)).not.toContain("invite:");
      for (const node of s.hub.nodes) setFakeNodeConnected({ hub: s.hub, node, connected: true });
      const back = createPhotoStore(restarted(s.admin.deps));
      await back.ready();
      await until(async () => (await back.requests()).requests.length === 1, 6_000);
      const { requests } = await back.requests();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.requestedAt).toBe(asked[1]!.ask.askedAt);
      await back.close();
      await s.joiner.store.close();
    },
  );

  it("a cancelled ask is never filed later", async () => {
    const { s, events } = await loggedScenario();
    const drives = s.joiner.deps.drives;
    let release: () => void = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    const open = drives.open.bind(drives);
    drives.open = (async (key: string, opts: never) => {
      if (key === s.owner) await paused;
      return open(key, opts);
    }) as typeof drives.open;
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    expect(await s.joiner.store.cancelAsk(s.invite.code)).toEqual([null, { ok: true }]);
    release();
    await until(async () => false, 1_000);
    expect(await outboxText(s.outbox)).not.toContain(`invite:${s.invite.code}`);
    expect(
      events.filter((e) => e.event === "error"),
      "cancelling is not an error",
    ).toEqual([]);
    await s.close();
  });

  it("an ask still waiting when the joiner restarts is filed at start-up", async () => {
    const s = await scenario();
    setFakeNodeConnected({ hub: s.hub, node: s.admin.deps.node, connected: false });
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(async () => false, 300);
    expect(await outboxText(s.outbox)).not.toContain("invite:");
    await s.joiner.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.admin.deps.node, connected: true });
    const deps = restarted(s.joiner.deps);
    // No connection can form, so only the start-up pass can file the ask.
    deps.network.join = () => {};
    const again = createPhotoStore(deps);
    await again.ready();
    const outbox = await openDrive({ deps }, s.outboxKey);
    await until(async () => (await outboxText(outbox)).includes("sealedKey"), 6_000);
    expect(await outboxText(outbox)).toContain(`invite:${s.invite.code}`);
    await again.close();
    await s.admin.store.close();
  });

  it("an ask already filed is not filed again when the joiner restarts", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await filedOutbox(s);
    await s.joiner.store.close();
    const deps = restarted(s.joiner.deps);
    let puts = 0;
    const openOwn = deps.drives.openOwn.bind(deps.drives);
    deps.drives.openOwn = (async (ns?: string) => {
      const drive = await openOwn(ns);
      const put = drive.put.bind(drive);
      drive.put = (async (path: string, bytes: Uint8Array) => {
        if (path === "/requests.json") puts++;
        return put(path, bytes);
      }) as typeof drive.put;
      return drive;
    }) as typeof deps.drives.openOwn;
    const again = createPhotoStore(deps);
    await again.ready();
    await until(async () => false, 800);
    expect(puts).toBe(0);
    await again.close();
    await s.admin.store.close();
  });

  it("an ask filed while another ask is taken back keeps its entry", async () => {
    const hub = createFakeHub();
    const node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
    const drives = createFakeDriveStore({ hub, node });
    const gate = { armed: false, hit: false, release: () => {} };
    const held = new Promise<void>((resolve) => (gate.release = resolve));
    const openOwn = drives.openOwn.bind(drives);
    drives.openOwn = (async (ns?: string) => {
      const drive = await openOwn(ns);
      if (ns !== undefined && ns !== "") return drive;
      const put = drive.put.bind(drive);
      drive.put = (async (path: string, bytes: Uint8Array) => {
        if (path === "/requests.json" && gate.armed) {
          gate.armed = false;
          gate.hit = true;
          await held;
        }
        return put(path, bytes);
      }) as typeof drive.put;
      return drive;
    }) as typeof drives.openOwn;
    const s = await scenario(undefined, { hub, node, drives }, hub);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await filedOutbox(s);
    const second = (await s.admin.store.createFolder("Two"))[1]!.folder.invite!;
    gate.armed = true;
    const cancelling = s.joiner.store.cancelAsk(s.invite.code);
    await until(() => gate.hit);
    await s.joiner.store.ask({ code: second.code, owner: s.owner });
    await until(async () => false, 300);
    gate.release();
    await cancelling;
    await until(async () => (await outboxText(s.outbox)).includes(second.code));
    expect(await outboxText(s.outbox)).toContain(`invite:${second.code}`);
    await s.close();
  });

  /** A scenario whose joiner records its log events. */
  async function loggedScenario() {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const s = await scenario(undefined, {
      log: (e: { event: string; fields: Record<string, unknown> }) => events.push(e),
    });
    return { s, events };
  }

  it("an Admin phone that publishes no sealing key gets no ask, and the joiner logs why", async () => {
    const { s, events } = await loggedScenario();
    const identity = await s.admin.deps.drives.openOwn();
    await identity.put("/device.json", Buffer.from(JSON.stringify({ name: "Admin" })));
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(async () => events.some((e) => e.event === "ask.unsealed"));
    expect(events.find((e) => e.event === "ask.unsealed")?.fields.reason).toBe("no-box-key");
    expect(await outboxText(s.outbox)).not.toContain("invite:");
    await s.close();
  });

  it("an Admin phone that cannot be reached gets no ask, and the joiner logs why", async () => {
    const { s, events } = await loggedScenario();
    setFakeNodeConnected({ hub: s.hub, node: s.admin.deps.node, connected: false });
    await s.admin.store.close();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(async () => events.some((e) => e.event === "ask.unsealed"), 8_000);
    expect(events.find((e) => e.event === "ask.unsealed")?.fields.reason).toBe("unreachable");
    await s.joiner.store.close();
  }, 15_000);

  it("a seal that fails is logged and nothing is filed", async () => {
    const { s, events } = await loggedScenario();
    s.joiner.deps.drives.sealFor = () => [new Error("no seal"), null];
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(async () => events.some((e) => e.event === "error"));
    expect(events.find((e) => e.event === "error")?.fields).toMatchObject({
      where: "ask.seal",
      err: "no seal",
    });
    expect(await outboxText(s.outbox)).not.toContain("invite:");
    await s.close();
  });

  /** Holds the joiner's first read of the Admin's /device.json until `release`. */
  async function holdDeviceRead(s: Awaited<ReturnType<typeof scenario>>) {
    const peer = await openDrive(s.joiner, s.owner);
    const held = { hit: false, release: () => {} };
    const gate = new Promise<void>((resolve) => (held.release = resolve));
    const readSmall = peer.readSmall.bind(peer);
    peer.readSmall = (async (path: string, max: number) => {
      if (path === "/device.json" && !held.hit) {
        held.hit = true;
        await gate;
      }
      return readSmall(path, max);
    }) as typeof peer.readSmall;
    return held;
  }

  it("an ask that turns linkOff while the Admin's key is being read is not filed", async () => {
    const hub = createFakeHub();
    const net = createFakePeerNetwork({ hub });
    const s = await scenario(undefined, { network: net }, hub);
    const held = await holdDeviceRead(s);
    await s.admin.store.turnOffInvite(s.folderId);
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(() => held.hit);
    net.join(s.adminTopic, { server: false });
    await until(async () => (await s.joiner.store.folders()).asks[0]?.status === "linkOff", 4_000);
    expect((await s.joiner.store.folders()).asks[0]?.status).toBe("linkOff");
    held.release();
    await until(async () => false, 500);
    expect(await outboxText(s.outbox)).not.toContain(`invite:${s.invite.code}`);
    await s.close();
  });

  it("asking again files the new ask when an older entry for the code is still in the outbox", async () => {
    const s = await scenario();
    const old = {
      version: 1,
      requests: {
        [`invite:${s.invite.code}`]: {
          sealedKey: "old",
          requesterName: "Joiner",
          requestedAt: 1,
        },
      },
    };
    await s.outbox.put("/requests.json", Buffer.from(JSON.stringify(old)));
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(async () => !(await outboxText(s.outbox)).includes('"old"'));
    const entry = JSON.parse(await outboxText(s.outbox)).requests[`invite:${s.invite.code}`];
    expect(entry.sealedKey).not.toBe("old");
    expect(entry.requestedAt).toBeGreaterThan(1);
    await s.close();
  });

  it("stops reading the Admin's drive once the wait for its key has timed out", async () => {
    const { s, events } = await loggedScenario();
    setFakeNodeConnected({ hub: s.hub, node: s.admin.deps.node, connected: false });
    await s.admin.store.close();
    const peer = await openDrive(s.joiner, s.owner);
    const update = peer.update.bind(peer);
    let updates = 0;
    peer.update = (async (...a: Parameters<typeof peer.update>) => {
      updates += 1;
      return update(...a);
    }) as typeof peer.update;
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    await until(async () => events.some((e) => e.event === "ask.unsealed"), 8_000);
    await until(async () => false, 300);
    const after = updates;
    await until(async () => false, 1_000);
    expect(updates).toBe(after);
    await s.joiner.store.close();
  }, 15_000);
});

describe("a joiner checks a link against the owner's published list", () => {
  it("a joiner who never asked learns a turned-off link is off, and the Admin sees nothing", async () => {
    const s = await scenario();
    await s.admin.store.turnOffInvite(s.folderId);
    const result = await s.joiner.store.linkTurnedOff(s.invite.code, s.owner);
    expect(result).toEqual([null, { turnedOff: true }]);
    expect((await s.admin.store.requests()).requests).toEqual([]);
    expect((await s.joiner.store.folders()).asks).toEqual([]);
    await s.close();
  });

  it("the current link is not off", async () => {
    const s = await scenario();
    const code = (await s.admin.store.turnOffInvite(s.folderId))[1]!.invite.code;
    expect(await s.joiner.store.linkTurnedOff(code, s.owner)).toEqual([null, { turnedOff: false }]);
    await s.close();
  });

  it("a replaced link is not listed", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    const phone = await connect(s);
    void phone;
    await until(async () => (await s.admin.store.requests()).requests.length === 1);
    const [req] = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, req.requesterKey, true);
    await until(async () => (await s.joiner.store.folders()).folders.length === 1, 4_000);
    await s.admin.store.removeMember(s.folderId, req.requesterKey);
    await s.admin.store.turnOffInvite(s.folderId);
    const c = buildStore("Cy", s.hub);
    await c.store.ready();
    expect(await c.store.linkTurnedOff(s.invite.code, s.owner)).toEqual([
      null,
      { turnedOff: false },
    ]);
    await c.store.close();
    await s.close();
  });

  it("after a restart the list is still published", async () => {
    const s = await scenario();
    await s.admin.store.turnOffInvite(s.folderId);
    // The file is derived from saved state: blank it, and the next boot writes it again.
    await (await openDrive(s.admin, s.owner)).put("/links.json", Buffer.from('{"off":[]}'));
    await s.admin.store.close();
    const reopened = createPhotoStore(restarted(s.admin.deps));
    await reopened.ready();
    const c = buildStore("Cy", s.hub);
    await c.store.ready();
    expect(await c.store.linkTurnedOff(s.invite.code, s.owner)).toEqual([
      null,
      { turnedOff: true },
    ]);
    await c.store.close();
    await reopened.close();
    await s.joiner.store.close();
  });

  it("an unreachable owner reads as not off within the budget", async () => {
    const hub = createFakeHub({ readyDelayMs: (key) => (key === "e".repeat(64) ? Infinity : 0) });
    const joiner = buildStore("Joiner", hub);
    await joiner.store.ready();
    const started = Date.now();
    const result = await joiner.store.linkTurnedOff("c".repeat(64), "e".repeat(64));
    expect(result).toEqual([null, { turnedOff: false }]);
    expect(Date.now() - started).toBeLessThan(6_000);
    await joiner.store.close();
  }, 10_000);
});
