/**
 * An Admin hands the album to a Collaborator: the Collaborator's phone takes
 * the lists onto its own drive, the old Admin writes `/admin.json` once both
 * copies agree, and the Collaborator's phone becomes the Admin. Phones on the
 * checked fakes share one hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import type { PeerNetwork } from "../src/ports/peer-network.ts";
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
    inviteOwner?: string;
    handover?: { to: string; written: boolean };
    takingOver?: string;
    handedBy?: string;
  }>;
};

/** Drops "done" messages while `held.on`, so Ada's phone has not yet been told Ben's phone has the album. */
function holdingDone(network: PeerNetwork, held: { on: boolean }) {
  const start = network.start.bind(network);
  network.start = (identity, onEvent, protocol) =>
    start(
      identity,
      (e) => {
        const done = e.type === "answer" && JSON.stringify(e.value).includes('"handoverDone"');
        if (!(held.on && done)) onEvent(e);
      },
      protocol,
    );
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string, held?: { on: boolean }) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({
    hub,
    node,
    deviceName,
    server: new FakeLoopbackServer(),
  });
  if (held) holdingDone(deps.network, held);
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;

const debugOf = (p: { store: { debugState(): unknown } }) => p.store.debugState() as Debug;
const identityOf = (p: Phone) => debugOf(p).identityDrive;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

/** Ada's "Trip" with Ben and Cy as Collaborators. */
async function scene(options: { holdDone?: boolean } = {}) {
  const hub = createFakeHub();
  const held = { on: options.holdDone === true };
  const ada = phone(hub, "Ada", held);
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
  return { hub, held, ada, ben, cy, folderId, shareKey, benKey, cyKey, read, close };
}

describe("handing an album to a Collaborator", () => {
  it("makes their phone the Admin once it has the lists", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");

    const folder = await trip(s.ben);
    expect(folder.notice).toEqual({ kind: "madeAdmin", fromName: "Ada" });
    expect(debugOf(s.ben).folders[0]!.adminChain).toEqual([s.shareKey, s.benKey]);

    const lists = JSON.parse((await s.read(s.cy, s.benKey, "/members.json"))!);
    expect(Object.values(lists.members).map((m) => (m as { key: string }).key)).toEqual([s.cyKey]);
    const note = JSON.parse((await s.read(s.cy, s.shareKey, "/admin.json"))!);
    expect(note.next).toMatchObject({ key: s.benKey, identity: identityOf(s.ben), name: "Ben" });
    await s.close();
  });

  it("tells the next Admin who Ada removed, and Ben's card names Ada", async () => {
    const s = await scene({ holdDone: true });
    const code = (await trip(s.ada)).invite!.code;
    const adaIdentity = identityOf(s.ada);
    await s.ada.store.close();
    const file = join(s.ada.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].removals = { [identityOf(s.cy)]: { name: "Cy", at: 1_700_000_000_000 } };
    writeFileSync(file, JSON.stringify(saved));
    const ada = createPhotoStore(restarted(s.ada.deps));
    await ada.ready();
    expect((await ada.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    await until(async () => (await s.cy.store.ask({ code, owner: adaIdentity }))[0] === null);
    await until(async () => (await s.ben.store.requests()).requests.length === 1, 30_000);
    const [card] = (await s.ben.store.requests()).requests;
    expect(card!.removedEarlier).toEqual({ name: "Cy", at: 1_700_000_000_000, by: "Ada" });
    await ada.close();
    await s.ben.store.close();
    await s.cy.store.close();
  }, 60_000);

  it("names Ada on the Admin's row for Ben and for Cy, and on no row before", async () => {
    const s = await scene();
    expect(
      (await s.ben.store.status()).members.some(
        (m: { handedBy?: string }) => m.handedBy !== undefined,
      ),
    ).toBe(false);
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    const own = (await s.ben.store.status()).members[0]!;
    expect(own).toMatchObject({ admin: true, handedBy: "Ada" });
    await until(async () =>
      (await s.cy.store.status()).members.some(
        (m: { admin: boolean; handedBy?: string }) => m.admin && m.handedBy === "Ada",
      ),
    );
    for (const p of [s.ben, s.cy]) {
      const named = (await p.store.status()).members.filter(
        (m: { handedBy?: string }) => m.handedBy !== undefined,
      );
      expect(named.map((m: { admin: boolean }) => m.admin)).toEqual([true]);
    }
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

describe("Ada's phone after Ben's phone has the album", () => {
  it("removes the album from her phone once Ben's phone says it has it", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await s.ada.store.folders()).folders.length === 0);
    expect((await s.ada.store.folders()).archived).toEqual([]);
    expect(debugOf(s.ada).folders).toEqual([]);
    expect((await trip(s.ben)).role).toBe("creator");
    await s.close();
  });

  it("finishes leaving when Ben's phone says so after Ada's phone restarted", async () => {
    const s = await scene({ holdDone: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    expect(debugOf(s.ada).folders[0]!.handover).toEqual({ to: s.benKey, written: true });
    await s.ada.store.close();

    const reopened = createPhotoStore(restarted(s.ada.deps));
    await reopened.ready();
    expect((await reopened.folders()).folders[0]!.handingOver).toEqual({
      key: s.benKey,
      name: "Ben",
      final: true,
    });
    await until(async () => (await reopened.folders()).folders.length === 0, 30_000);
    await reopened.close();
    await s.ben.store.close();
    await s.cy.store.close();
  }, 40_000);
});

describe("Stay Admin", () => {
  it("keeps the album on Ada's phone and ends the handover line", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    expect((await trip(s.ada)).handingOver).toEqual({
      key: s.benKey,
      name: "Ben",
      final: false,
    });
    const changes: unknown[] = [];
    s.ada.deps.onChanged = (c: unknown) => void changes.push(c);
    expect((await s.ada.store.stayAdmin(s.folderId))[0]).toBeNull();
    expect(changes).toContainEqual({ cause: "enroll", folderId: s.folderId });
    expect((await s.ada.store.stayAdmin(s.folderId))[0]).toBeNull();
    const folder = await trip(s.ada);
    expect(folder.handingOver).toBeUndefined();
    expect(folder.role).toBe("creator");
    expect(debugOf(s.ada).folders[0]!.handover).toBeUndefined();
    await s.close();
  });

  it("is ignored by Ben's phone when Ben's phone comes back afterwards", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    expect((await s.ada.store.stayAdmin(s.folderId))[0]).toBeNull();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: true });
    await sleep(3_000);
    expect((await trip(s.ben)).role).toBe("member");
    expect(await s.read(s.cy, s.shareKey, "/admin.json")).toBeNull();
    expect((await trip(s.ada)).role).toBe("creator");
    await s.close();
  }, 15_000);

  it("can hand over again after staying", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    expect((await s.ada.store.stayAdmin(s.folderId))[0]).toBeNull();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    await s.close();
  });

  it("is refused once Ben's phone has the lists and /admin.json is written", async () => {
    const s = await scene({ holdDone: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    const [error] = await s.ada.store.stayAdmin(s.folderId);
    expect(error?.code).toBe(PhotoError.HANDOVER_REFUSED);
    expect((await s.ada.store.handOver(s.folderId, s.cyKey))[0]?.code).toBe(
      PhotoError.HANDOVER_REFUSED,
    );
    await s.close();
  });

  it("is for the Admin only", async () => {
    const s = await scene();
    const [error] = await s.ben.store.stayAdmin((await trip(s.ben)).id);
    expect(error?.code).toBe(PhotoError.NOT_CREATOR);
    const [missing] = await s.ada.store.stayAdmin("nope");
    expect(missing?.code).toBe(PhotoError.FOLDER_NOT_FOUND);
    await s.close();
  });
});

describe("other phones follow the new Admin", () => {
  const people = async (p: Phone) =>
    (await p.store.status()).members.map((m: { name: string }) => m.name).toSorted();

  it("a connected Collaborator reads Ben's lists, with Ada gone from them", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.cy).folders[0]!.adminChain?.at(-1) === s.benKey);
    expect(debugOf(s.cy).folders[0]!.folderDrive.key).toBe(s.benKey);
    expect(debugOf(s.cy).folders[0]!.adminChain).toEqual([s.shareKey, s.benKey]);
    await until(async () => (await people(s.cy)).join() === "Ben,Cy");
    expect((await trip(s.cy)).role).toBe("member");
    expect((await trip(s.cy)).adminChanged).toEqual({ fromName: "Ada", toName: "Ben" });
    expect((await trip(s.ben)).adminChanged).toBeUndefined();
    expect((await s.cy.store.dismissAdminChanged((await trip(s.cy)).id))[0]).toBeNull();
    expect((await trip(s.cy)).adminChanged).toBeUndefined();
    await until(async () => (await s.ada.store.folders()).folders.length === 0);
    await s.close();
  });

  it("trusts Ben as the owner of the invite a phone joined through", async () => {
    const s = await scene();
    await s.cy.store.close();
    const file = join(s.cy.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].invite = { code: "ab".repeat(32), owner: identityOf(s.ada) };
    writeFileSync(file, JSON.stringify(saved));
    const cy = createPhotoStore(restarted(s.cy.deps));
    await cy.ready();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf({ store: cy }).folders[0]!.adminChain?.at(-1) === s.benKey);
    expect(debugOf({ store: cy }).folders[0]!.inviteOwner).toBe(identityOf(s.ben));
    await cy.close();
    await s.ada.store.close();
    await s.ben.store.close();
  });

  it("a phone that was off follows once it reaches Ben alone", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.cy.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    await sleep(200);
    expect(debugOf(s.cy).folders[0]!.adminChain).toBeUndefined();

    await s.ada.store.close();
    setFakeNodeConnected({ hub: s.hub, node: s.cy.node, connected: true });
    await until(() => debugOf(s.cy).folders[0]!.adminChain?.at(-1) === s.benKey, 30_000);
    await until(async () => (await people(s.cy)).join() === "Ben,Cy");
    expect((await trip(s.cy)).adminChanged).toEqual({ fromName: "Ada", toName: "Ben" });
    await s.ben.store.close();
    await s.cy.store.close();
  }, 40_000);

  it("keeps following Ben after the phone restarts", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.cy).folders[0]!.adminChain?.at(-1) === s.benKey);
    await s.cy.store.close();

    const reopened = createPhotoStore(restarted(s.cy.deps));
    await reopened.ready();
    const folder = debugOf({ store: reopened }).folders[0]!;
    expect(folder.folderDrive.key).toBe(s.benKey);
    expect(folder.adminChain).toEqual([s.shareKey, s.benKey]);
    expect(folder.role).toBe("member");
    expect((await reopened.folders()).folders[0]!.adminChanged).toBeUndefined();
    await reopened.close();
    await s.ada.store.close();
    await s.ben.store.close();
  });

  it("a newcomer with the old share key lands on Ben's lists", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    const benFolderId = (await trip(s.ben)).id;
    const dee = phone(s.hub, "Dee");
    await dee.store.ready();
    const deeKey = await joinAsMember(s.ben.store, benFolderId, dee.store, s.shareKey);
    expect(debugOf(dee).folders[0]!.adminChain).toEqual([s.shareKey, s.benKey]);
    expect((await trip(dee)).role).toBe("member");
    expect(
      (await trip(dee)).adminChanged,
      "Trip: a newcomer after the handover is not told",
    ).toBeUndefined();
    const lists = JSON.parse((await s.read(s.ben, s.benKey, "/members.json"))!);
    expect(Object.values(lists.members).map((m) => (m as { key: string }).key)).toContain(deeKey);
    await dee.store.close();
    await s.close();
  });

  it("a phone that was off takes the Viewer seat Ben gave it while it was away", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.cy.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    expect((await s.ben.store.makeViewer((await trip(s.ben)).id, s.cyKey))[0]).toBeNull();

    setFakeNodeConnected({ hub: s.hub, node: s.cy.node, connected: true });
    await until(() => debugOf(s.cy).folders[0]!.adminChain?.at(-1) === s.benKey, 30_000);
    await until(async () => (await trip(s.cy)).role === "reader");
    expect((await trip(s.cy)).adminChanged, "Trip: a phone that became a Viewer is told").toEqual({
      fromName: "Ada",
      toName: "Ben",
    });
    await s.close();
  }, 40_000);

  it("a phone that was off learns Ben deleted the album", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.cy.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    expect((await s.ben.store.deleteAlbum((await trip(s.ben)).id))[0]).toBeNull();

    setFakeNodeConnected({ hub: s.hub, node: s.cy.node, connected: true });
    await until(async () => (await s.cy.store.folders()).folders.length === 0, 30_000);
    await s.close();
  }, 40_000);

  it("tells the screen when a connected phone follows Ben", async () => {
    const s = await scene();
    await s.cy.store.close();
    const pushes: string[] = [];
    const cy = createPhotoStore({
      ...restarted(s.cy.deps),
      onChanged: (e: { cause: string }) => pushes.push(e.cause),
    });
    await cy.ready();
    await sleep(500);
    pushes.length = 0;
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf({ store: cy }).folders[0]!.adminChain?.at(-1) === s.benKey);
    await until(() => pushes.includes("enroll"));
    await cy.close();
    await s.ada.store.close();
    await s.ben.store.close();
  });

  it("a phone that was restarted after a handover it missed follows Ben and lists Ada's and Ben's photos", async () => {
    const s = await scene();
    await s.ada.store.setActive(s.folderId);
    await s.ada.store.addBytes("ada.jpg", new Uint8Array([1, 2, 3, 41]));
    const benId = (await trip(s.ben)).id;
    await s.ben.store.setActive(benId);
    await s.ben.store.addBytes("ben.jpg", new Uint8Array([1, 2, 3, 42]));
    const cyId = (await trip(s.cy)).id;
    await s.cy.store.setActive(cyId);
    const names = async (st: Phone["store"]) =>
      (await st.list())
        .map((p: { name: string }) => p.name)
        .toSorted()
        .join();
    await until(async () => (await names(s.cy.store)) === "ada.jpg,ben.jpg");
    await s.cy.store.close();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    await s.ada.store.close();
    const cy = createPhotoStore(restarted(s.cy.deps));
    await cy.ready();
    await until(() => debugOf({ store: cy }).folders[0]!.adminChain?.at(-1) === s.benKey, 30_000);
    expect(
      (await cy.folders()).folders[0]!.adminChanged,
      "Trip: Cy's app started after the handover still tells it",
    ).toEqual({ fromName: "Ada", toName: "Ben" });
    await cy.setActive((await cy.folders()).folders[0]!.id);
    await until(async () => (await names(cy)) === "ada.jpg,ben.jpg");
    await cy.close();
    await s.ben.store.close();
  }, 60_000);

  it("Ada's photos stay under her name after she leaves, and Ben can delete one", async () => {
    const s = await scene();
    await s.ada.store.setActive(s.folderId);
    await s.ada.store.addBytes("ada1.jpg", new Uint8Array([1, 2, 3, 51]));
    await s.ada.store.addBytes("ada2.jpg", new Uint8Array([1, 2, 3, 52]));
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator", 30_000);
    await until(async () => (await s.ada.store.folders()).folders.length === 0, 30_000);
    await s.ada.store.close();
    const benId = (await trip(s.ben)).id;
    const cyId = (await trip(s.cy)).id;
    await s.ben.store.setActive(benId);
    await s.cy.store.setActive(cyId);
    const names = async (st: Phone["store"]) =>
      (await st.list())
        .map((p: { name: string }) => p.name)
        .toSorted()
        .join();
    await until(async () => (await names(s.ben.store)) === "ada1.jpg,ada2.jpg", 30_000);
    await until(async () => (await names(s.cy.store)) === "ada1.jpg,ada2.jpg", 30_000);
    const photos = await s.ben.store.list();
    expect(photos.every((p: { member?: { name: string } }) => p.member?.name === "Ada")).toBe(true);
    const ada1 = photos.find((p: { name: string }) => p.name === "ada1.jpg")!;
    expect((await s.ben.store.remove(ada1.id, benId))[0]).toBeNull();
    await until(async () => (await names(s.cy.store)) === "ada2.jpg", 30_000);
    expect(await names(s.ben.store)).toBe("ada2.jpg");
    await s.cy.store.close();
    await s.ben.store.close();
  }, 90_000);

  it("Ada's old photos stay after she leaves and Ben lets her back in", async () => {
    const s = await scene();
    await s.ada.store.setActive(s.folderId);
    await s.ada.store.addBytes("ada1.jpg", new Uint8Array([1, 2, 3, 61]));
    await s.ada.store.addBytes("ada2.jpg", new Uint8Array([1, 2, 3, 62]));
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator", 30_000);
    await until(async () => (await s.ada.store.folders()).folders.length === 0, 30_000);
    const benId = (await trip(s.ben)).id;
    const cyId = (await trip(s.cy)).id;
    await s.ben.store.setActive(benId);
    await s.cy.store.setActive(cyId);
    const names = async (st: Phone["store"]) =>
      (await st.list())
        .map((p: { name: string }) => p.name)
        .toSorted()
        .join();
    await until(async () => (await names(s.cy.store)) === "ada1.jpg,ada2.jpg", 30_000);
    // Ada is let back in: her new drive, under the same identity, is enrolled.
    await joinAsMember(s.ben.store, benId, s.ada.store, s.shareKey);
    // Her new drive comes to hold as many photos as her old one did.
    const again = await s.ada.deps.drives.openOwn(`member/${s.shareKey}`);
    await again.put("/photos/x1.jpg", Buffer.from([9, 9, 1]));
    await again.put("/photos/x2.jpg", Buffer.from([9, 9, 2]));
    await sleep(5_000);
    expect(await names(s.cy.store)).toContain("ada1.jpg,ada2.jpg");
    expect(await names(s.ben.store)).toContain("ada1.jpg,ada2.jpg");
    await s.close();
  }, 120_000);

  it("a photo Ada adds again after Ben lets her back in is listed once", async () => {
    const s = await scene();
    await s.ada.store.setActive(s.folderId);
    await s.ada.store.addBytes("ada1.jpg", new Uint8Array([1, 2, 3, 61]));
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator", 30_000);
    await until(async () => (await s.ada.store.folders()).folders.length === 0, 30_000);
    const benId = (await trip(s.ben)).id;
    const cyId = (await trip(s.cy)).id;
    await s.ben.store.setActive(benId);
    await s.cy.store.setActive(cyId);
    const names = async (st: Phone["store"]) =>
      (await st.list())
        .map((p: { name: string }) => p.name)
        .toSorted()
        .join();
    await until(async () => (await names(s.cy.store)) === "ada1.jpg", 30_000);
    const old = (await s.cy.store.list()).find((p: { name: string }) => p.name === "ada1.jpg");
    await joinAsMember(s.ben.store, benId, s.ada.store, s.shareKey);
    // Back in, Ada adds the same photo again (same bytes) on her new drive.
    const again = await s.ada.deps.drives.openOwn(`member/${s.shareKey}`);
    await again.put("/photos/x1.jpg", Buffer.from([1, 2, 3, 61]), {
      metadata: { name: "ada1.jpg", sha256: old?.sha256, addedAt: Date.now(), mime: "image/jpeg" },
    });
    await until(async () => (await names(s.cy.store)) === "ada1.jpg", 30_000);
    await sleep(3_000);
    expect(await names(s.cy.store)).toBe("ada1.jpg");
    expect(await names(s.ben.store)).toBe("ada1.jpg");
    await s.close();
  }, 120_000);

  it("a connected phone hears Ben's later changes on Ben's drive", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.cy).folders[0]!.adminChain?.at(-1) === s.benKey);
    await until(async () => (await trip(s.ben)).role === "creator");
    expect((await s.ben.store.makeViewer((await trip(s.ben)).id, s.cyKey))[0]).toBeNull();
    await until(async () => (await trip(s.cy)).role === "reader");
    await s.close();
  }, 40_000);

  for (const what of ["removed", "deleted"] as const) {
    it(`a phone restarted after Ben ${what} it while it was off, Ada gone`, async () => {
      const s = await scene();
      await s.cy.store.close();
      expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
      await until(async () => (await trip(s.ben)).role === "creator");
      const benId = (await trip(s.ben)).id;
      if (what === "removed")
        expect((await s.ben.store.removeMember(benId, s.cyKey))[0]).toBeNull();
      else expect((await s.ben.store.deleteAlbum(benId))[0]).toBeNull();
      await sleep(500);
      await s.ada.store.close();
      const cy = createPhotoStore(restarted(s.cy.deps));
      await cy.ready();
      if (what === "removed")
        await until(
          () => debugOf({ store: cy }).folders[0]?.adminChain?.at(-1) === s.benKey,
          30_000,
        );
      if (what === "removed")
        await until(
          async () => (await cy.folders()).folders[0]?.notice?.kind === "removed",
          15_000,
        );
      else await until(async () => (await cy.folders()).folders.length === 0, 15_000);
      await cy.close();
      await s.ben.store.close();
    }, 90_000);
  }
});
