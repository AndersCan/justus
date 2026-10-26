/**
 * Per-member presence: a swarm connection is mapped to a member through the
 * swarm key each device publishes in its drive's `/device.json`, so the status
 * reports who is reachable (not just how many connections exist).
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { FakeSwarm, makeFakeDeps } from "./fake-drive.ts";

function buildStore(name: string, swarmKey: Buffer, changes: string[] = []) {
  const swarm = new FakeSwarm() as FakeSwarm & { keyPair?: { publicKey: Buffer } };
  swarm.keyPair = { publicKey: swarmKey };
  const deps = makeFakeDeps({
    deviceName: name,
    makeSwarm: () => swarm,
    onChanged: (c) => changes.push(c.cause),
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { store: createPhotoStore(deps), swarm };
}

/** A fake connection whose `close` can be fired by the test. */
function connection(remote: Buffer) {
  const handlers: Record<string, () => void> = {};
  return {
    remotePublicKey: remote,
    on: (event: string, fn: () => void) => void (handlers[event] = fn),
    close: () => handlers.close?.(),
  };
}

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
};

describe("member presence", () => {
  it("marks a member connected while its swarm connection is open, then records last seen", async () => {
    const adminKey = Buffer.alloc(32, 1);
    const memberKey = Buffer.alloc(32, 2);
    const adminChanges: string[] = [];
    const admin = buildStore("Maya", adminKey, adminChanges);
    const member = buildStore("Nils", memberKey);
    await admin.store.ready();
    await member.store.ready();

    const folder = (await admin.store.createFolder("Trip"))[1]!.folder;
    await member.store.join(folder.shareKey);

    // Before any connection the Admin is listed but not connected.
    const before = (await member.store.status()).members;
    expect(before.find((m: { admin: boolean }) => m.admin)).toMatchObject({
      name: "Maya",
      connected: false,
    });
    expect(before.find((m: { admin: boolean }) => !m.admin)).toMatchObject({
      name: "Nils",
      connected: true,
    });

    // The member's device connects to the Admin's swarm identity.
    const conn = connection(adminKey);
    member.swarm.emit("connection", conn);
    await waitFor(
      async () =>
        (await member.store.status()).members.find((m: { admin: boolean }) => m.admin)
          ?.connected === true,
    );

    conn.close();
    const after = (await member.store.status()).members.find((m: { admin: boolean }) => m.admin)!;
    expect(after.connected).toBe(false);
    expect(after.lastSeenAt).toBeGreaterThan(0);

    await admin.store.close();
    await member.store.close();
  });

  it("pushes a presence change when a connection opens", async () => {
    const changes: string[] = [];
    const { store, swarm } = buildStore("Maya", Buffer.alloc(32, 3), changes);
    await store.ready();
    await store.createFolder("Trip");
    swarm.emit("connection", connection(Buffer.alloc(32, 9)));
    expect(changes).toContain("presence");
    await store.close();
  });

  it("lets the Admin remove an approved member", async () => {
    const admin = buildStore("Maya", Buffer.alloc(32, 4));
    const member = buildStore("Nils", Buffer.alloc(32, 5));
    await admin.store.ready();
    await member.store.ready();
    const folder = (await admin.store.createFolder("Trip"))[1]!.folder;
    await member.store.join(folder.shareKey);
    const memberKey = (await member.store.status()).members.find(
      (m: { admin: boolean }) => !m.admin,
    )!.key;

    expect((await admin.store.respond(folder.id, memberKey, true))[0]).toBeNull();
    expect((await admin.store.status()).members.map((m: { key: string }) => m.key)).toContain(
      memberKey,
    );

    // Only the Admin may remove; the member's own attempt is refused.
    expect((await member.store.removeMember(folder.id, memberKey))[0]).not.toBeNull();
    expect((await admin.store.removeMember(folder.id, memberKey))[0]).toBeNull();
    expect((await admin.store.status()).members.map((m: { key: string }) => m.key)).not.toContain(
      memberKey,
    );

    await admin.store.close();
    await member.store.close();
  });
});
