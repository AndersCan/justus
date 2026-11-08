/**
 * Every `/device.json` a phone writes into an album drive carries the phone's
 * identity signature for that drive, so a reader can tell the identity is not
 * a copied claim.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync } from "node:fs";
import { createPhotoStore } from "../src/photo-store.ts";
import { identityMessage } from "../src/membership/records.ts";
import { createFakeHub, type FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember } from "./fakes/fake-store-deps.ts";

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
});
