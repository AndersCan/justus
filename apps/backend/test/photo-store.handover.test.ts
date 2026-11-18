/**
 * An Admin hands the album to a Collaborator: the Collaborator's phone takes
 * the lists onto its own drive, the old Admin writes `/admin.json` once both
 * copies agree, and the Collaborator's phone becomes the Admin. Phones on the
 * checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { listsDigest } from "../src/albums/handover.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}

type Debug = {
  identityDrive: string;
  folders: Array<{
    role: string;
    shareKey: string;
    folderDrive: { key: string };
    adminChain?: string[];
    handover?: { to: string; written: boolean };
    takingOver?: string;
    handedBy?: string;
  }>;
};

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;

const debugOf = (p: { store: { debugState(): unknown } }) => p.store.debugState() as Debug;
const identityOf = (p: Phone) => debugOf(p).identityDrive;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

/** Ada's "Trip" with Ben and Cy as Collaborators. */
async function scene() {
  const hub = createFakeHub();
  const ada = phone(hub, "Ada");
  const ben = phone(hub, "Ben");
  const cy = phone(hub, "Cy");
  for (const p of [ada, ben, cy]) await p.store.ready();
  const created = await ada.store.createFolder("Trip");
  const folderId = created[1]!.folder.id;
  const shareKey = created[1]!.folder.shareKey;
  const benKey = await joinAsMember(ada.store, folderId, ben.store, shareKey);
  const cyKey = await joinAsMember(ada.store, folderId, cy.store, shareKey);
  await until(async () => {
    const m = (await ada.store.status()).members;
    return m.length === 3 && m.every((x: { identity?: string }) => x.identity !== undefined);
  });
  const read = async (p: Phone, key: string, path: string) => {
    const [openErr, drive] = await p.deps.drives.open(key, { timeoutMs: 5_000 });
    if (openErr) throw openErr;
    return (await drive.readSmall(path, 1 << 20, { timeoutMs: 2_000 })) ?? null;
  };
  const close = async () => {
    for (const p of [ada, ben, cy]) await p.store.close();
  };
  return { hub, ada, ben, cy, folderId, shareKey, benKey, cyKey, read, close };
}

describe("handing an album to a Collaborator", () => {
  it("makes their phone the Admin once it has the lists", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");

    const folder = await trip(s.ben);
    expect(folder.notice).toEqual({ kind: "madeAdmin", fromName: "Ada" });
    expect(debugOf(s.ben).folders[0]!.adminChain).toEqual([s.shareKey, s.benKey]);

    const lists = JSON.parse((await s.read(s.ada, s.benKey, "/members.json"))!);
    expect(Object.values(lists.members).map((m) => (m as { key: string }).key)).toEqual([s.cyKey]);
    const note = JSON.parse((await s.read(s.ada, s.shareKey, "/admin.json"))!);
    expect(note.next).toMatchObject({ key: s.benKey, identity: identityOf(s.ben), name: "Ben" });
    expect(debugOf(s.ada).folders[0]!.handover).toEqual({ to: s.benKey, written: true });
    await s.close();
  });

  it("waits for Ben's phone, and hands over what changed while it was off", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    expect((await s.ada.store.makeViewer(s.folderId, s.cyKey))[0]).toBeNull();
    await sleep(400);
    expect((await trip(s.ben)).role).toBe("member");
    expect(debugOf(s.ada).folders[0]!.handover?.written).toBe(false);

    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: true });
    await until(async () => (await trip(s.ben)).role === "creator", 30_000);
    const viewers = JSON.parse((await s.read(s.ada, s.benKey, "/viewers.json"))!);
    expect(Object.keys(viewers.viewers)).toEqual([s.cyKey]);
    await s.close();
  }, 40_000);

  it("keeps Ben the Admin after his phone restarts", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    await s.ben.store.close();

    const reopened = createPhotoStore(restarted(s.ben.deps));
    await reopened.ready();
    const debug = debugOf({ store: reopened });
    expect(debug.folders[0]!.role).toBe("creator");
    expect(debug.folders[0]!.folderDrive.key).toBe(s.benKey);
    expect(debug.folders[0]!.adminChain).toEqual([s.shareKey, s.benKey]);
    expect((await reopened.folders()).folders[0]!.role).toBe("creator");
    await reopened.close();
    await s.ada.store.close();
    await s.cy.store.close();
  });

  it("lets the new Admin change the lists on their own drive", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    const benFolderId = (await trip(s.ben)).id;

    expect((await s.ben.store.makeViewer(benFolderId, s.cyKey))[0]).toBeNull();
    const viewers = JSON.parse((await s.read(s.ben, s.benKey, "/viewers.json"))!);
    expect(Object.keys(viewers.viewers)).toEqual([s.cyKey]);
    expect(await s.read(s.ada, s.shareKey, "/viewers.json")).toBeNull();
    await s.close();
  });
});

describe("refusing a handover", () => {
  it("is for the Admin only", async () => {
    const s = await scene();
    const benFolderId = (await trip(s.ben)).id;
    const [error] = await s.ben.store.handOver(benFolderId, s.cyKey);
    expect(error?.code).toBe(PhotoError.NOT_CREATOR);
    await s.close();
  });

  it("is for someone who can add photos", async () => {
    const s = await scene();
    expect((await s.ada.store.makeViewer(s.folderId, s.benKey))[0]).toBeNull();
    const viewer = await s.ada.store.handOver(s.folderId, s.benKey);
    expect(viewer[0]?.code).toBe(PhotoError.HANDOVER_REFUSED);
    const stranger = await s.ada.store.handOver(s.folderId, "ab".repeat(32));
    expect(stranger[0]?.code).toBe(PhotoError.HANDOVER_REFUSED);
    const notHex = await s.ada.store.handOver(s.folderId, "nope");
    expect(notHex[0]?.code).toBe(PhotoError.INVALID_KEY);
    expect(debugOf(s.ada).folders[0]!.handover).toBeUndefined();
    await s.close();
  });

  it("waits while a Remove is still moving people", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    expect((await s.ada.store.removeMember(s.folderId, s.cyKey))[0]).toBeNull();
    const [error] = await s.ada.store.handOver(s.folderId, s.benKey);
    expect(error?.code).toBe(PhotoError.HANDOVER_MOVE_OPEN);
    await s.close();
  });

  it.each(["moveOwed", "movingUnknown"])("waits while %s is not empty", async (field) => {
    const s = await scene();
    await s.ada.store.close();
    const file = join(s.ada.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0][field] =
      field === "moveOwed"
        ? [s.cyKey]
        : { [s.cyKey]: { role: "member", name: "Cy", key: s.cyKey, color: 1 } };
    writeFileSync(file, JSON.stringify(saved));
    const reopened = createPhotoStore(restarted(s.ada.deps));
    await reopened.ready();
    const [error] = await reopened.handOver(s.folderId, s.benKey);
    expect(error?.code).toBe(PhotoError.HANDOVER_MOVE_OPEN);
    await reopened.close();
    await s.ben.store.close();
    await s.cy.store.close();
  });

  it("is refused once it has been written", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.ada).folders[0]!.handover?.written === true);
    const [error] = await s.ada.store.handOver(s.folderId, s.cyKey);
    expect(error?.code).toBe(PhotoError.HANDOVER_REFUSED);
    await s.close();
  });
});
