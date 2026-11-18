import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub, type FakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps } from "./fakes/fake-store-deps.ts";

function buildStore(name: string, hub: FakeHub) {
  const deps = fakeStoreDeps({ hub, deviceName: name, onChanged: () => {} });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  const topic = () =>
    deps.drives.discoveryKeyOf((store.debugState() as { identityDrive: string }).identityDrive);
  return { store, deps, topic };
}

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
};

describe("last seen from a close before the member was known", () => {
  it("is written to presence.json, so it survives a restart", async () => {
    const hub = createFakeHub();
    const admin = buildStore("Maya", hub);
    const member = buildStore("Nils", hub);
    await admin.store.ready();
    await member.store.ready();
    const folder = (await admin.store.createFolder("Trip"))[1]!.folder;

    // Maya's phone meets Nils before Nils knows her: the close is an unknown peer going down.
    admin.deps.network.join(member.topic(), { server: false });
    await new Promise((r) => setTimeout(r, 100));
    await admin.deps.network.close();
    await new Promise((r) => setTimeout(r, 50));

    await member.store.join(folder.shareKey);
    await waitFor(
      async () =>
        ((await member.store.status()).members.find((m: { admin: boolean }) => m.admin)
          ?.lastSeenAt ?? 0) > 0,
    );
    const mayaKey = (await member.store.status()).members.find(
      (m: { admin: boolean }) => m.admin,
    )!.key;
    let saved: Record<string, number> = {};
    try {
      saved = JSON.parse(readFileSync(join(member.deps.storageDir, "presence.json"), "utf8"));
    } catch {}
    expect(saved[mayaKey]).toBeGreaterThan(0);

    await admin.store.close();
    await member.store.close();
  });
});
