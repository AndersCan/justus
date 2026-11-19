/**
 * An archived album can be the open one: status describes it, and requests to
 * join it are answered while it stays archived.
 */
import { describe, it, expect } from "vite-plus/test";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, peerPhone, type FakeStoreDeps } from "./fakes/fake-store-deps.ts";
import type { FakeHub } from "./fakes/fake-world.ts";

function buildStore(name: string, hub: FakeHub) {
  const full: FakeStoreDeps = fakeStoreDeps({ hub, deviceName: name });
  return { store: createPhotoStore(full), deps: full };
}

const identityOf = (s: { store: { debugState(): unknown } }) =>
  (s.store.debugState() as { identityDrive: string }).identityDrive;

async function until(done: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await done()); waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("an archived album", () => {
  it("opened, it is the album status describes, and it stays archived", async () => {
    const { store } = buildStore("Ada", createFakeHub());
    await store.ready();
    const summer = (await store.createFolder("Summer"))[1]!.folder.id;
    const other = (await store.createFolder("Other"))[1]!.folder.id;
    await store.archiveAlbum(summer);
    await store.setActive(summer);

    expect((await store.status()).folder.id).toBe(summer);
    const listed = await store.folders();
    expect(listed.activeFolderId).toBe(summer);
    expect(listed.archived.map((f) => f.id)).toEqual([summer]);
    expect(listed.folders.map((f) => f.id)).toEqual([other]);
    await store.close();
  });

  it("an ask is listed, accepting it adds the asker, and the album stays archived", async () => {
    const hub = createFakeHub();
    const admin = buildStore("Admin", hub);
    const joiner = buildStore("Joiner", hub);
    await admin.store.ready();
    await joiner.store.ready();
    const { id, invite } = (await admin.store.createFolder("Summer"))[1]!.folder;
    await admin.store.archiveAlbum(id);
    await admin.store.setActive(id);

    const owner = identityOf(admin);
    await joiner.store.ask({ code: invite!.code, owner });
    const phone = peerPhone(hub, { identityKey: identityOf(joiner) });
    phone.meet(admin.deps.drives.discoveryKeyOf(owner));
    await until(async () => (await admin.store.requests()).requests.length > 0);
    const { requests } = await admin.store.requests();
    expect(requests).toHaveLength(1);

    const answered = await admin.store.respond(id, requests[0]!.requesterKey, true);
    expect(answered[0]).toBeNull();
    const listed = await admin.store.folders();
    expect(listed.archived[0]!.members).toBe(2);
    expect((await admin.store.requests()).requests).toEqual([]);
    await admin.store.close();
    await joiner.store.close();
  });
});
