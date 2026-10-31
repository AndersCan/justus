/**
 * Join-request outboxes are written by the requester, so every field is a
 * claim from a peer the Admin does not trust yet. These tests pin the intake
 * rules: malformed entries are dropped, names are clipped, an oversized outbox
 * is ignored, and a device's own outbox forgets an album once it is enrolled
 * (the outbox is readable by every holder of a pre-#195 album, and its keys
 * are share keys).
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeSwarm, makeFakeDeps } from "./fake-drive.ts";
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
  return createPhotoStore(deps);
}

/** A creator with one album and one requester that has filed a join request
 * and been announced on the album's topic. */
async function scenario() {
  const swarm = new FakeSwarm();
  const creator = buildStore("Creator", { swarm });
  const requesterOwn: FakeDrive[] = [];
  const requester = buildStore("Requester", { own: requesterOwn });
  await creator.ready();
  await requester.ready();
  const created = await creator.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  expect((await requester.join(shareKey))[0]).toBeNull();
  const outbox = requesterOwn[0];
  swarm.emit("connection", { remotePublicKey: outbox.key, on: () => {} });
  const close = async () => {
    await creator.close();
    await requester.close();
  };
  return { creator, requester, outbox, folderId, shareKey, close };
}

async function readOutbox(drive: FakeDrive): Promise<Record<string, unknown>> {
  const bytes = await drive.get("/requests.json");
  return bytes
    ? (JSON.parse(bytes.toString()) as { requests: Record<string, unknown> }).requests
    : {};
}

describe("join-request intake", () => {
  it("drops malformed entries and clips names", async () => {
    const s = await scenario();
    const genuine = (await readOutbox(s.outbox))[s.shareKey] as Record<string, unknown>;
    await s.outbox.put(
      "/requests.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          requests: {
            [s.shareKey]: { ...genuine, requesterName: "x".repeat(500) },
            notAKey: { shareKey: s.shareKey, requesterKey: "../../etc", requesterName: "Bad" },
            nullEntry: null,
            numberKey: { shareKey: s.shareKey, requesterKey: 42 },
          },
        }),
      ),
    );

    const { requests } = await s.creator.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0].requesterKey).toBe(genuine.requesterKey);
    expect(requests[0].requesterName).toHaveLength(80);
    await s.close();
  });

  it("ignores an outbox larger than the peer JSON cap", async () => {
    const s = await scenario();
    const genuine = (await readOutbox(s.outbox))[s.shareKey];
    await s.outbox.put(
      "/requests.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          requests: { [s.shareKey]: genuine },
          padding: "x".repeat(1024 * 1024),
        }),
      ),
    );

    expect((await s.creator.requests()).requests).toHaveLength(0);
    await s.close();
  });

  it("removes an album from the outbox once the device is enrolled", async () => {
    const s = await scenario();
    expect(Object.keys(await readOutbox(s.outbox))).toEqual([s.shareKey]);

    const [pending] = (await s.creator.requests()).requests;
    expect((await s.creator.respond(s.folderId, pending.requesterKey, true))[0]).toBeNull();
    // Re-joining makes the requester notice the approval.
    expect((await s.requester.join(s.shareKey))[0]).toBeNull();

    expect(await readOutbox(s.outbox)).toEqual({});
    await s.close();
  });
});
