/**
 * Per-member presence: a swarm connection is mapped to a member through the
 * swarm key each device publishes in its drive's `/device.json`, so the status
 * reports who is reachable (not just how many connections exist).
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, type FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, peerPhone } from "./fakes/fake-store-deps.ts";

function buildStore(name: string, hub: FakeHub, changes: string[] = []) {
  const deps = fakeStoreDeps({
    hub,
    deviceName: name,
    onChanged: (c) => changes.push(c.cause),
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  const topic = () =>
    deps.drives.discoveryKeyOf((store.debugState() as { identityDrive: string }).identityDrive);
  return { store, deps, topic };
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
    const hub = createFakeHub();
    const adminChanges: string[] = [];
    const admin = buildStore("Maya", hub, adminChanges);
    const member = buildStore("Nils", hub);
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

    // The Admin's own network meets the member, so the connection carries the
    // swarm key the Admin published in /device.json.
    admin.deps.network.join(member.topic(), { server: false });
    await waitFor(
      async () =>
        (await member.store.status()).members.find((m: { admin: boolean }) => m.admin)
          ?.connected === true,
    );

    await admin.deps.network.close();
    await waitFor(
      async () =>
        (await member.store.status()).members.find((m: { admin: boolean }) => m.admin)
          ?.connected === false,
    );
    const after = (await member.store.status()).members.find((m: { admin: boolean }) => m.admin)!;
    expect(after.connected).toBe(false);
    expect(after.lastSeenAt).toBeGreaterThan(0);

    await admin.store.close();
    await member.store.close();
  });

  it("pushes a presence change when a connection opens", async () => {
    const changes: string[] = [];
    const hub = createFakeHub();
    const { store, topic } = buildStore("Maya", hub, changes);
    await store.ready();
    await store.createFolder("Trip");
    peerPhone(hub, { identityKey: "9".repeat(64) }).meet(topic());
    await waitFor(async () => changes.includes("presence"));
    expect(changes).toContain("presence");
    await store.close();
  });

  it("lets the Admin remove an approved member", async () => {
    const hub = createFakeHub();
    const admin = buildStore("Maya", hub);
    const member = buildStore("Nils", hub);
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
