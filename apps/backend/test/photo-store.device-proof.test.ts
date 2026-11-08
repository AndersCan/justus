/**
 * Every `/device.json` a phone writes into an album drive carries the phone's
 * identity signature for that drive, so a reader can tell the identity is not
 * a copied claim.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { identityMessage } from "../src/membership/records.ts";
import { createFakeHub, type FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember, restarted } from "./fakes/fake-store-deps.ts";

function device(hub: FakeHub, name: string) {
  const deps = fakeStoreDeps({ hub, deviceName: name });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  return { deps, store, identity };
}

type Phone = ReturnType<typeof device>;

async function record(phone: Phone, driveKey: string) {
  const drive = await phone.deps.drives.open(driveKey, { timeoutMs: 500 });
  if (drive[0]) throw drive[0];
  const text = await drive[1].readSmall("/device.json", 1e6);
  return JSON.parse(text ?? "{}") as Record<string, string | undefined>;
}

function signedFor(phone: Phone, driveKey: string, rec: Record<string, string | undefined>) {
  return phone.deps.drives.verifyIdentity({
    identityKey: phone.identity(),
    publicKey: rec.identityPublicKey ?? "",
    signature: rec.identitySig ?? "",
    message: identityMessage(driveKey),
  });
}

describe("signed device records", () => {
  it("every device record a phone writes into an album drive is signed for the drive it is in", async () => {
    const hub = createFakeHub();
    const [admin, member] = [device(hub, "Anna"), device(hub, "Ben")];
    await Promise.all([admin.store.ready(), member.store.ready()]);
    const folder = (await admin.store.createFolder("Trip"))[1]!.folder;
    const memberKey = await joinAsMember(admin.store, folder.id, member.store, folder.shareKey);

    const adminRec = await record(admin, folder.shareKey);
    const memberRec = await record(member, memberKey);
    expect(
      [signedFor(admin, folder.shareKey, adminRec), signedFor(member, memberKey, memberRec)],
      "Trip: album drive and member drive records verify",
    ).toEqual([true, true]);
    expect(
      signedFor(member, folder.shareKey, memberRec),
      "Trip: a signature for one drive does not verify for another",
    ).toBe(false);

    await member.store.setName("Ben 2");
    const renamed = await record(member, memberKey);
    expect({ name: renamed.name, verifies: signedFor(member, memberKey, renamed) }).toEqual({
      name: "Ben 2",
      verifies: true,
    });
    await Promise.all([admin.store.close(), member.store.close()]);
  });

  it("an album is still created when signing fails, with an unsigned record", async () => {
    const hub = createFakeHub();
    const phone = device(hub, "Anna");
    await phone.store.ready();
    phone.deps.drives.signAsIdentity = async () => [new Error("no key"), null];
    const folder = (await phone.store.createFolder("Trip"))[1]!.folder;
    const rec = await record(phone, folder.shareKey);
    expect({ identityKey: rec.identityKey, sig: rec.identitySig }).toEqual({
      identityKey: phone.identity(),
      sig: undefined,
    });
    await phone.store.close();
  });

  it("the creator's record still verifies for its drive after a restart", async () => {
    const hub = createFakeHub();
    const phone = device(hub, "Anna");
    await phone.store.ready();
    const folder = (await phone.store.createFolder("Trip"))[1]!.folder;
    await phone.store.close();

    const deps = restarted(phone.deps);
    const again = createPhotoStore(deps);
    await again.ready();
    const after = {
      deps,
      store: again,
      identity: () => (again.debugState() as { identityDrive: string }).identityDrive,
    };
    const rec = await record(after, folder.shareKey);
    expect(
      signedFor(after, folder.shareKey, rec),
      "Trip: creator record after restart verifies",
    ).toBe(true);
    await again.close();
  });

  it("a member who copies another member's identity is shown without one", async () => {
    const hub = createFakeHub();
    const [anna, ben, mallory] = [device(hub, "Anna"), device(hub, "Ben"), device(hub, "Mallory")];
    await Promise.all([anna.store.ready(), ben.store.ready(), mallory.store.ready()]);
    const folder = (await anna.store.createFolder("Trip"))[1]!.folder;
    const benKey = await joinAsMember(anna.store, folder.id, ben.store, folder.shareKey);
    const malloryKey = await joinAsMember(anna.store, folder.id, mallory.store, folder.shareKey);

    const benRec = await record(ben, benKey);
    const forged = await mallory.deps.drives.openOwn(`member/${folder.shareKey}`);
    await forged.put(
      "/device.json",
      Buffer.from(JSON.stringify({ name: "Mallory", swarmKey: "e".repeat(64), ...benRec })),
    );

    const deadline = Date.now() + 3000;
    let members: { key: string; identity?: string }[] = [];
    while (Date.now() < deadline) {
      members = (await anna.store.status()).members;
      if (members.find((m) => m.key === benKey)?.identity) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      members
        .filter((m) => m.key === benKey || m.key === malloryKey)
        .map((m) => [m.key === benKey ? "Ben" : "Mallory", m.identity])
        .sort(),
    ).toEqual([
      ["Ben", ben.identity()],
      ["Mallory", undefined],
    ]);
    await Promise.all([anna.store.close(), ben.store.close(), mallory.store.close()]);
  });

  it("a member who leaves with a copy of another member's identity does not clear that member's answer", async () => {
    const hub = createFakeHub();
    const [anna, ben, mallory] = [device(hub, "Anna"), device(hub, "Ben"), device(hub, "Mallory")];
    await Promise.all([anna.store.ready(), ben.store.ready(), mallory.store.ready()]);
    const folder = (await anna.store.createFolder("Trip"))[1]!.folder;
    const benKey = await joinAsMember(anna.store, folder.id, ben.store, folder.shareKey);
    const malloryKey = await joinAsMember(anna.store, folder.id, mallory.store, folder.shareKey);
    const benRec = await record(ben, benKey);
    await anna.store.close();

    const stateFile = join(anna.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    saved.folders[0].answers = { [ben.identity()]: "accepted" };
    writeFileSync(stateFile, JSON.stringify(saved));

    const forged = await mallory.deps.drives.openOwn(`member/${folder.shareKey}`);
    await forged.put(
      "/device.json",
      Buffer.from(JSON.stringify({ name: "Mallory", swarmKey: "e".repeat(64), ...benRec })),
    );
    await forged.put(
      "/left.json",
      Buffer.from(JSON.stringify({ version: 1, leftAt: Date.now() + 60_000 })),
    );

    const deps = restarted(anna.deps);
    const again = createPhotoStore(deps);
    await again.ready();
    const deadline = Date.now() + 3000;
    let keys: string[] = [];
    while (Date.now() < deadline) {
      keys = (await again.status()).members.map((m: { key: string }) => m.key);
      if (!keys.includes(malloryKey)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(keys, "Mallory was dropped after leaving").not.toContain(malloryKey);
    const after = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(after.folders[0].answers).toEqual({ [ben.identity()]: "accepted" });
    await Promise.all([again.close(), ben.store.close(), mallory.store.close()]);
  });
});
