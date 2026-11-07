/**
 * Asking to join through an invite code, on fakes: what the joiner writes to
 * its outbox (a code, never a key), and how the Admin's inbox, answers and
 * registry react. Real-swarm delivery is covered in `p2p-scenarios.ts`.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { FakeSwarm, makeFakeDeps, fakeConnection } from "./fake-drive.ts";
import type { FakeDrive } from "./fake-drive.ts";

function buildStore(name: string, opts: { swarm?: FakeSwarm; own?: FakeDrive[] } = {}) {
  const own: FakeDrive[] = opts.own ?? [];
  const deps = makeFakeDeps({
    deviceName: name,
    ...(opts.swarm ? { makeSwarm: () => opts.swarm! } : {}),
    makeDrive: (cs: unknown, key?: Buffer) => {
      const drive = makeFakeDeps().makeDrive(cs, key);
      if (!key) own.push(drive);
      return drive;
    },
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { store: createPhotoStore(deps), deps };
}

async function scenario() {
  const swarm = new FakeSwarm();
  const admin = buildStore("Admin", { swarm });
  const joinerOwn: FakeDrive[] = [];
  const joiner = buildStore("Joiner", { own: joinerOwn });
  await admin.store.ready();
  await joiner.store.ready();
  const created = await admin.store.createFolder("Trip");
  const { id: folderId, shareKey, invite } = created[1]!.folder;
  const owner = (admin.store.debugState() as { identityDrive: string }).identityDrive;
  const outbox = joinerOwn[0];
  const close = async () => {
    await admin.store.close();
    await joiner.store.close();
  };
  return { admin, joiner, outbox, swarm, folderId, shareKey, invite: invite!, owner, close };
}

async function outboxText(drive: FakeDrive): Promise<string> {
  return (await drive.get("/requests.json"))?.toString() ?? "";
}

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

  it("the Admin sees the ask, and a decline is final", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
    const { requests } = await s.admin.store.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ folderId: s.folderId, shareKey: s.shareKey });

    const declined = await s.admin.store.respond(s.folderId, requests[0].requesterKey, false);
    expect(declined[0]).toBeNull();
    expect((await s.admin.store.requests()).requests).toEqual([]);
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    const identity = Buffer.from(s.outbox.key).toString("hex");
    expect(saved.folders[0].answers).toEqual({ [identity]: "declined" });
    await s.close();
  });

  it("accepting enrolls the asker and records the answer", async () => {
    const s = await scenario();
    await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
    const { requests } = await s.admin.store.requests();
    const accepted = await s.admin.store.respond(s.folderId, requests[0].requesterKey, true);
    expect(accepted[0]).toBeNull();
    const saved = JSON.parse(
      (await s.admin.store.status(),
      readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8")),
    );
    const identity = Buffer.from(s.outbox.key).toString("hex");
    expect(saved.folders[0].answers).toEqual({ [identity]: "accepted" });
    expect((await s.admin.store.requests()).requests).toEqual([]);
    await s.close();
  });

  it("an old-style request still behaves as before", async () => {
    const s = await scenario();
    await s.joiner.store.join(s.shareKey);
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
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
      const mallOwn: FakeDrive[] = [];
      const mallory = buildStore("Mallory", { own: mallOwn });
      await mallory.store.ready();
      await s.joiner.store.ask({ code: s.invite.code, owner: s.owner });
      await mallory.store.ask({ code: s.invite.code, owner: s.owner });
      const aliceKey = Object.values(JSON.parse(await outboxText(s.outbox)).requests as object)[0]
        .requesterKey as string;
      const file = JSON.parse(await outboxText(mallOwn[0]!));
      for (const entry of Object.values(file.requests) as { requesterKey: string }[])
        entry.requesterKey = aliceKey;
      await mallOwn[0]!.put("/requests.json", Buffer.from(JSON.stringify(file)));

      const order = aliceLast ? [mallOwn[0]!, s.outbox] : [s.outbox, mallOwn[0]!];
      for (const d of order) s.swarm.emit("connection", fakeConnection(d.key));
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
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
    const first = (await s.admin.store.requests()).requests;
    await s.admin.store.respond(s.folderId, first[0].requesterKey, false);
    await s.joiner.store.join(s.shareKey);
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
    const after = (await s.admin.store.requests()).requests;
    expect(after.some((r) => r.requesterKey !== first[0].requesterKey)).toBe(true);
    await s.close();
  });
});

describe("turning off invite links", () => {
  async function asked(s: Awaited<ReturnType<typeof scenario>>, code: string) {
    await s.joiner.store.ask({ code, owner: s.owner });
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
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
    s.swarm.emit("connection", fakeConnection(s.outbox.key));
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
    const reopened = createPhotoStore({
      ...makeFakeDeps({
        storageDir: s.admin.deps.storageDir,
        cacheDir: s.admin.deps.cacheDir,
        makeCorestore: s.admin.deps.makeCorestore,
        makeSwarm: () => s.swarm,
      }),
    });
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
    expect(await asked(s, code)).toEqual([]);
    const identity = Buffer.from(s.outbox.key).toString("hex");
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers).toEqual({ [identity]: "declined" });
    await s.close();
  });

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
