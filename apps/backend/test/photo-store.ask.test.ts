/**
 * Asking to join through an invite code, on fakes: what the joiner writes to
 * its outbox (a code, never a key), and how the Admin's inbox, answers and
 * registry react. Real-swarm delivery is covered in `p2p-scenarios.ts`.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import type { Drive } from "../src/ports/drive-store.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";
import { createFakeHub, createFakePeerNetwork } from "./fakes/fake-world.ts";
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
    expect(JSON.parse(await outboxText(s.outbox)).requests[`invite:${CODE}`]).toBeDefined();
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

    const text = await outboxText(s.outbox);
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
    expect(Object.keys(JSON.parse(await outboxText(s.outbox)).requests)).toHaveLength(1);
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
    const outbox = JSON.parse(await outboxText(s.outbox)).requests[`invite:${s.invite.code}`];
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
    const file = JSON.parse(await outboxText(s.outbox));
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

  it("a requester key listed by two outboxes is dropped, in either read order", async () => {
    for (const aliceLast of [true, false]) {
      const s = await scenario();
      const mallory = buildStore("Mallory", s.hub);
      await mallory.store.ready();
      const mallKey = identityOf(mallory);
      const mallBox = await openDrive(mallory, mallKey);
      await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
      await mallory.store.ask({ code: s.invite.code, owner: s.owner });
      const aliceKey = Object.values(JSON.parse(await outboxText(s.outbox)).requests as object)[0]
        .requesterKey as string;
      const file = JSON.parse(await outboxText(mallBox));
      for (const entry of Object.values(file.requests) as { requesterKey: string }[])
        entry.requesterKey = aliceKey;
      await mallBox.put("/requests.json", Buffer.from(JSON.stringify(file)));

      const order = aliceLast ? [mallKey, s.outboxKey] : [s.outboxKey, mallKey];
      for (const key of order) await connect(s, key);
      const { requests } = await s.admin.store.requests();
      expect(requests.filter((r) => r.requesterKey === aliceKey)).toEqual([]);

      const res = await s.admin.store.respond(s.folderId, aliceKey, true);
      const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
      expect(saved.folders[0].answers ?? {}).toEqual({});
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

  it("lists the asker in /viewers.json, loads no drive and leaves the request list", async () => {
    const s = await asked();
    expect(s.request.viaInvite).toBe(true);
    const done = await s.admin.store.respond(s.folderId, s.key, true, "reader");
    expect(done[0]).toBeNull();
    const albumDrive = await albumDriveOf(s);
    const file = JSON.parse((await readText(albumDrive, "/viewers.json"))!);
    expect(Object.keys(file.viewers)).toEqual([s.key]);
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
