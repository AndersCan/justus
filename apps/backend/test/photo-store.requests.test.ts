/**
 * Regression tests for the join-request lifecycle in `createPhotoStore`.
 *
 * Before the fix, `requests()` re-surfaced join requests that had already been
 * resolved: an approved member still appeared as a pending request (the
 * creator never removed the entry from the requester's `/requests.json`, and
 * `readRequestsFromPeers` returned every peer request), and a denied request
 * reappeared on every refresh (#84/#85).
 *
 * Stores on one hub share drives by key (see `./fakes/fake-world`), so
 * the creator's `openDriveWithTopic(requesterKey)` resolves to the requester's
 * own drive and can read its `/requests.json` outbox.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, type FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, peerPhone } from "./fakes/fake-store-deps.ts";

/** Build a store on the checked fakes; `identity` is the key of its outbox drive. */
function buildStore(name: string, hub: FakeHub) {
  const changes: Array<{ folderId: string }> = [];
  const deps = fakeStoreDeps({
    hub,
    deviceName: name,
    onChanged: (c) => changes.push({ folderId: c.folderId }),
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  return { store, changes, deps, identity };
}

async function until(done: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("#84/#85 a resolved join request must not resurface as pending", () => {
  it("drops an approved or denied requester from requests()", async () => {
    const hub = createFakeHub();
    const creator = buildStore("Creator", hub);
    const requester = buildStore("Requester", hub);
    const requester2 = buildStore("Requester2", hub);

    await creator.store.ready();
    await requester.store.ready();
    await requester2.store.ready();

    // Each requester tells the creator its identity drive, which holds its outbox.
    const requesterPeer = requester.identity();
    const requester2Peer = requester2.identity();
    const creatorTopic = creator.deps.drives.discoveryKeyOf(creator.identity());

    // Creator makes a folder; requesters file join requests.
    const created = await creator.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;

    expect((await requester.store.join(folderKey))[0]).toBeNull();
    expect((await requester2.store.join(folderKey))[0]).toBeNull();

    // Each requester connects and greets the creator with its identity drive
    // (which `requests()` reads).
    const announce = async (key: string) => {
      const phone = peerPhone(hub, { identityKey: key });
      phone.meet(creatorTopic);
      await until(() => phone.events.some((e) => e.type === "identified"));
    };
    await announce(requesterPeer);
    await announce(requester2Peer);

    // Before any response, both requests are pending. Each asks to be enrolled
    // with its drive for this album, not the identity drive (#195).
    const pending = await creator.store.requests();
    expect(pending.requests.length).toBe(2);
    const keyOf = (name: string) =>
      pending.requests.find((r) => r.requesterName === name)!.requesterKey;
    const requesterKey = keyOf("Requester");
    const requester2Key = keyOf("Requester2");
    expect(requesterKey).not.toBe(requesterPeer);

    // Approve the first requester.
    expect((await creator.store.respond(folderId, requesterKey, true))[0]).toBeNull();
    // Approved member must no longer appear as pending (#84).
    expect((await creator.store.requests()).requests.length).toBe(1);
    // The enrolled member carries the name from its own request, not a fallback.
    await creator.store.setActive(folderId);
    const enrolled = (await creator.store.status()).members.find(
      (m: { key: string }) => m.key === requesterKey,
    );
    expect(enrolled?.name).toBe("Requester");

    // Deny the second requester.
    expect((await creator.store.respond(folderId, requester2Key, false))[0]).toBeNull();
    // Denied request must not resurface on refresh (#85).
    expect((await creator.store.requests()).requests.length).toBe(0);

    // Even after the denied requester re-files (re-join rewrites the outbox),
    // the denial is remembered for the session.
    expect((await requester2.store.join(folderKey))[0]).toBeNull();
    await announce(requester2Peer);
    expect((await creator.store.requests()).requests.length).toBe(0);

    await creator.store.close();
    await requester.store.close();
    await requester2.store.close();
  });
});

describe("#351 a request the joiner cancelled cannot be answered", () => {
  async function cancelledAsk() {
    const hub = createFakeHub();
    const admin = buildStore("Nils", hub);
    const joiner = buildStore("Sam", hub);
    await admin.store.ready();
    await joiner.store.ready();
    const created = await admin.store.createFolder("Trip");
    const { id: folderId, invite } = created[1]!.folder;
    const owner = admin.identity();
    const asked = await joiner.store.ask({ code: invite!.code, owner });
    expect(asked[0]).toBeNull();
    const phone = peerPhone(hub, { identityKey: joiner.identity() });
    phone.meet(admin.deps.drives.discoveryKeyOf(owner));
    await until(() => phone.events.some((e) => e.type === "identified"));
    const rows = (await admin.store.requests()).requests;
    expect(rows[0]?.requesterName).toBe("Sam");
    const requesterKey = rows[0]!.requesterKey;
    expect((await joiner.store.cancelAsk(invite!.code))[0]).toBeNull();
    await until(async () => (await admin.store.requests()).requests.length === 0);
    expect((await admin.store.requests()).requests).toEqual([]);
    return { admin, joiner, folderId, requesterKey };
  }

  async function expectNothingSaved(s: Awaited<ReturnType<typeof cancelledAsk>>) {
    await s.admin.store.setActive(s.folderId);
    const members = (await s.admin.store.status()).members as Array<{ key: string }>;
    expect(members.map((m) => m.key)).not.toContain(s.requesterKey);
    const saved = JSON.parse(readFileSync(join(s.admin.deps.storageDir, "justus.json"), "utf8"));
    expect(saved.folders[0].answers ?? {}).toEqual({});
    expect((await s.joiner.store.folders()).folders).toEqual([]);
    await s.admin.store.close();
    await s.joiner.store.close();
  }

  it("Accept as member on a cancelled request is refused and adds no one", async () => {
    const s = await cancelledAsk();
    const [error] = await s.admin.store.respond(s.folderId, s.requesterKey, true);
    expect(error?.code).toBe("justus.photos/request-cancelled");
    await expectNothingSaved(s);
  });

  it("Accept as reader on a cancelled request is refused and adds no one", async () => {
    const s = await cancelledAsk();
    const [error] = await s.admin.store.respond(s.folderId, s.requesterKey, true, "reader");
    expect(error?.code).toBe("justus.photos/request-cancelled");
    await expectNothingSaved(s);
  });

  it("Decline on a cancelled request is refused and records no answer", async () => {
    const s = await cancelledAsk();
    const [error] = await s.admin.store.respond(s.folderId, s.requesterKey, false);
    expect(error?.code).toBe("justus.photos/request-cancelled");
    await expectNothingSaved(s);
  });
});
