/**
 * Friend invites that wait for a phone that is off, on fakes: turning links
 * off drops them, and a restart keeps the live ones, drops the expired and
 * filters garbage. Real-swarm delivery is in `p2p-scenarios.ts`.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OFFER_HOLD_MS } from "../src/membership/offers.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import { createFakeHub } from "./fakes/fake-world.ts";
import { fakeStoreDeps, restarted } from "./fakes/fake-store-deps.ts";

const FRIEND = "a".repeat(64);
const OLD_FRIEND = "b".repeat(64);
const NEW_FRIEND = "c".repeat(64);

type Owed = {
  folders: {
    invited: string[];
    offerOwed?: Record<string, number>;
    invitedRoles?: Record<string, string>;
  }[];
};

async function waiting(role?: "reader" | "member") {
  const deps = fakeStoreDeps({ hub: createFakeHub(), deviceName: "Admin", offerReachMs: 50 });
  const store = createPhotoStore(deps);
  await store.ready();
  const created = await store.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const offered = await store.offerAlbum(folderId, FRIEND, role);
  expect(offered[1]).toEqual({ ok: true, waiting: true });
  return { deps, store, folderId };
}

describe("waiting friend invites", () => {
  it("an invite to a phone that is off waits", async () => {
    const { store } = await waiting();
    expect((await store.folders()).folders[0].waitingFor).toEqual([FRIEND]);
    const state = store.debugState() as Owed;
    expect(Object.keys(state.folders[0].offerOwed ?? {})).toEqual([FRIEND]);
    expect(state.folders[0].invited).toEqual([]);
    await store.close();
  });

  it("turning links off drops the waiting invite", async () => {
    const { deps, store, folderId } = await waiting();
    await store.turnOffInvite(folderId);
    expect((await store.folders()).folders[0].waitingFor).toBeUndefined();
    expect((store.debugState() as Owed).folders[0].offerOwed ?? {}).toEqual({});
    await store.close();
    const reopened = createPhotoStore(restarted(deps));
    await reopened.ready();
    expect((await reopened.folders()).folders[0].waitingFor).toBeUndefined();
    await reopened.close();
  });

  it("a restart keeps the live wait, drops the expired and filters garbage", async () => {
    const { deps, store } = await waiting();
    await store.close();
    const file = join(deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].offerOwed = {
      [FRIEND]: Date.now(),
      [OLD_FRIEND]: Date.now() - OFFER_HOLD_MS - 1000,
      [NEW_FRIEND]: "soon",
      "not-a-key": Date.now(),
    };
    writeFileSync(file, JSON.stringify(saved));
    const reopened = createPhotoStore(restarted(deps));
    await reopened.ready();
    expect((await reopened.folders()).folders[0].waitingFor).toEqual([FRIEND]);
    expect(Object.keys((reopened.debugState() as Owed).folders[0].offerOwed ?? {})).toEqual([
      FRIEND,
    ]);
    await reopened.close();
  });
});

describe("the role of a waiting friend invite", () => {
  it("is kept across a restart", async () => {
    const { deps, store } = await waiting("reader");
    await store.close();
    const reopened = createPhotoStore(restarted(deps));
    await reopened.ready();
    expect((reopened.debugState() as Owed).folders[0].invitedRoles).toEqual({ [FRIEND]: "reader" });
    await reopened.close();
  });

  it("is dropped when links are turned off", async () => {
    const { store, folderId } = await waiting("reader");
    await store.turnOffInvite(folderId);
    expect((store.debugState() as Owed).folders[0].invitedRoles).toEqual({});
    await store.close();
  });

  it("is dropped when the wait expires on restart", async () => {
    const { deps, store } = await waiting("reader");
    await store.close();
    const file = join(deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].offerOwed = { [FRIEND]: Date.now() - OFFER_HOLD_MS - 1000 };
    writeFileSync(file, JSON.stringify(saved));
    const reopened = createPhotoStore(restarted(deps));
    await reopened.ready();
    expect((reopened.debugState() as Owed).folders[0].invitedRoles).toEqual({});
    await reopened.close();
  });

  it("is Collaborator when the Admin picked none", async () => {
    const { store } = await waiting();
    expect((store.debugState() as Owed).folders[0].invitedRoles).toEqual({ [FRIEND]: "member" });
    await store.close();
  });

  it("refuses a role other than reader or member and saves nothing", async () => {
    const { store, folderId } = await waiting();
    const [error] = await store.offerAlbum(folderId, OLD_FRIEND, "creator" as never);
    expect(error?.code).toBe("justus.photos/invalid-role");
    expect((store.debugState() as Owed).folders[0].invitedRoles).toEqual({ [FRIEND]: "member" });
    await store.close();
  });
});
