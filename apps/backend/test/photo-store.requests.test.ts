/**
 * Regression tests for the join-request lifecycle in `createPhotoStore`.
 *
 * Before the fix, `requests()` re-surfaced join requests that had already been
 * resolved: an approved member still appeared as a pending request (the
 * creator never removed the entry from the requester's `/requests.json`, and
 * `readRequestsFromPeers` returned every peer request), and a denied request
 * reappeared on every refresh (#84/#85).
 *
 * The fake harness shares drives by key across stores (see `./fake-drive`), so
 * the creator's `openDriveWithTopic(requesterKey)` resolves to the requester's
 * own drive and can read its `/requests.json` outbox.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeSwarm, makeFakeDeps } from "./fake-drive.ts";
import type { FakeDrive } from "./fake-drive.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build a store on the in-memory harness, recording its keyless (identity)
 * drive so a scenario can act as the swarm peer that announced it. */
function buildStore(name: string, opts: { swarm?: FakeSwarm; own?: FakeDrive[] } = {}) {
  const own: FakeDrive[] = opts.own ?? [];
  const changes: Array<{ folderId: string }> = [];
  const deps = makeFakeDeps({
    deviceName: name,
    onChanged: (c) => changes.push({ folderId: c.folderId }),
    ...(opts.swarm ? { makeSwarm: () => opts.swarm! } : {}),
    // Wrap the default (shared-cache) makeDrive so we can capture the identity
    // drive without breaking cross-store drive resolution.
    makeDrive: (cs: unknown, key?: Buffer) => {
      const drive = makeFakeDeps().makeDrive(cs, key);
      if (!key) own.push(drive);
      return drive;
    },
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  return { store, changes };
}

describe("#84/#85 a resolved join request must not resurface as pending", () => {
  it("drops an approved or denied requester from requests()", async () => {
    const creatorSwarm = new FakeSwarm();
    const creatorOwn: FakeDrive[] = [];
    const creator = buildStore("Creator", { swarm: creatorSwarm, own: creatorOwn });
    const requesterOwn: FakeDrive[] = [];
    const requester = buildStore("Requester", { own: requesterOwn });
    const requester2Own: FakeDrive[] = [];
    const requester2 = buildStore("Requester2", { own: requester2Own });

    await creator.store.ready();
    await requester.store.ready();
    await requester2.store.ready();

    const requesterKey = requesterOwn[0].key.toString("hex");
    const requester2Key = requester2Own[0].key.toString("hex");

    // Creator makes a folder; requesters file join requests.
    const created = await creator.store.createFolder("Trip");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    const folderKey = created[1]!.folder.shareKey;

    expect((await requester.store.join(folderKey))[0]).toBeNull();
    expect((await requester2.store.join(folderKey))[0]).toBeNull();

    // The swarm announces each requester to the creator (populates
    // `rt.social.peers`, which `requests()` reads).
    const announce = (key: string) =>
      creatorSwarm.emit("connection", {
        remotePublicKey: Buffer.from(key, "hex"),
        on: () => {},
      });
    announce(requesterKey);
    announce(requester2Key);

    // Before any response, both requests are pending.
    const pending = await creator.store.requests();
    expect(pending.requests.length).toBe(2);

    // Approve the first requester.
    expect((await creator.store.respond(folderId, requesterKey, true))[0]).toBeNull();
    // Approved member must no longer appear as pending (#84).
    expect((await creator.store.requests()).requests.length).toBe(1);

    // Deny the second requester.
    expect((await creator.store.respond(folderId, requester2Key, false))[0]).toBeNull();
    // Denied request must not resurface on refresh (#85).
    expect((await creator.store.requests()).requests.length).toBe(0);

    // Even after the denied requester re-files (re-join rewrites the outbox),
    // the denial is remembered for the session.
    expect((await requester2.store.join(folderKey))[0]).toBeNull();
    announce(requester2Key);
    expect((await creator.store.requests()).requests.length).toBe(0);

    await creator.store.close();
    await requester.store.close();
    await requester2.store.close();
  });
});
