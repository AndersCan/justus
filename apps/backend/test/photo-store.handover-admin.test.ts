/**
 * An old Admin whose `/admin.json` is written stays
 * off its invite codes and its lists; a handover from a verified phone that
 * is not the Admin is refused; the new Admin serves the code after a restart.
 */
import { describe, it, expect } from "vite-plus/test";
import { createHash } from "node:crypto";
import { createPhotoStore, PhotoError } from "../src/photo-store.ts";
import { listsDigest } from "../src/albums/handover.ts";
import { inviteTopic } from "../src/membership/invite.ts";
import type { PeerEvent, PeerNetwork } from "../src/ports/peer-network.ts";
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
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const topicOfCode = (code: string) => inviteTopic(code, { createHash } as never).toString("hex");

/** Records the topics a network is in and the events it reports. */
function watchNet(network: PeerNetwork) {
  const joined = new Set<string>();
  const events: PeerEvent[] = [];
  const join = network.join.bind(network);
  const leave = network.leave.bind(network);
  const start = network.start.bind(network);
  network.join = (topic, opts) => {
    joined.add(topic);
    return join(topic, opts);
  };
  network.leave = (topic) => {
    joined.delete(topic);
    return leave(topic);
  };
  network.start = (identity, onEvent, protocol) =>
    start(identity, (e) => (events.push(e), onEvent(e)), protocol);
  return { joined, events };
}

/** Drops "done" messages while `held.on`, so Ada's phone has not yet been told Ben's phone has the album. */
function holdingDone(network: PeerNetwork, held: { on: boolean; pass?: number }) {
  const start = network.start.bind(network);
  network.start = (identity, onEvent, protocol) =>
    start(
      identity,
      (e) => {
        const done = e.type === "answer" && JSON.stringify(e.value).includes('"handoverDone"');
        if (!(held.on && done && e.conn !== held.pass)) onEvent(e);
      },
      protocol,
    );
}

function phone(
  hub: ReturnType<typeof createFakeHub>,
  deviceName: string,
  held?: { on: boolean; pass?: number },
) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({
    hub,
    node,
    deviceName,
    server: new FakeLoopbackServer(),
  });
  if (held) holdingDone(deps.network, held);
  const net = watchNet(deps.network);
  return { deps, node, net, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;
type Debug = {
  identityDrive: string;
  folders: Array<{ handover?: { written: boolean }; takingOver?: string }>;
};
const debugOf = (store: { debugState(): unknown }) => store.debugState() as Debug;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

async function scene(options: { holdDone?: boolean } = {}) {
  const hub = createFakeHub();
  const held: { on: boolean; pass?: number } = { on: options.holdDone === true };
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
  const code = (await trip(ada)).invite!.code;
  return { hub, held, ada, ben, cy, folderId, shareKey, benKey, cyKey, code };
}

describe("an old Admin once /admin.json is written", () => {
  it("stays off its invite codes after a restart", async () => {
    const s = await scene({ holdDone: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.ada.store).folders[0]!.handover?.written === true);
    expect(s.ada.net.joined.has(topicOfCode(s.code))).toBe(false);
    await s.ada.store.close();

    const deps = restarted(s.ada.deps);
    holdingDone(deps.network, s.held);
    const net = watchNet(deps.network);
    const reopened = createPhotoStore(deps);
    await reopened.ready();
    expect(debugOf(reopened).folders[0]!.handover?.written).toBe(true);
    expect(net.joined.has(topicOfCode(s.code))).toBe(false);
    for (const store of [reopened, s.ben.store, s.cy.store]) await store.close();
  }, 30_000);

  it("refuses to change the lists it handed over", async () => {
    const s = await scene({ holdDone: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.ada.store).folders[0]!.handover?.written === true);
    const viewer = await s.ada.store.makeViewer(s.folderId, s.cyKey);
    expect(viewer[0]?.code).toBe(PhotoError.HANDOVER_REFUSED);
    const removed = await s.ada.store.removeMember(s.folderId, s.cyKey);
    expect(removed[0]?.code).toBe(PhotoError.HANDOVER_REFUSED);
    for (const p of [s.ada, s.ben, s.cy]) await p.store.close();
  }, 30_000);
});

describe("a handover from a verified phone that is not the Admin", () => {
  it("is refused", async () => {
    const s = await scene();
    const benIdentity = debugOf(s.ben.store).identityDrive;
    const conn = s.cy.net.events.find(
      (e): e is Extract<PeerEvent, { type: "identified" }> =>
        e.type === "identified" && e.identityKey === benIdentity,
    )!.conn;
    const [, drive] = await s.ben.deps.drives.open(s.shareKey, { timeoutMs: 5_000 });
    const code = "cd".repeat(32);
    const proof = { from: "01".repeat(32), to: "02".repeat(32), publicKey: "03".repeat(32) };
    s.cy.deps.network.sendAnswer(conn, {
      kind: "handover",
      album: s.ben.deps.drives.discoveryKeyOf(s.shareKey),
      digest: await listsDigest(drive!, hash),
      admin: {
        fromName: "Cy",
        invite: { code },
        chains: { [code]: [{ ...proof, signature: "04".repeat(64) }] },
      },
    });
    await sleep(3_000);
    expect(debugOf(s.ben.store).folders[0]!.takingOver).toBeUndefined();
    for (const p of [s.ada, s.ben, s.cy]) await p.store.close();
  }, 30_000);
});

describe("the new Admin", () => {
  it("serves the handed-over invite code, before and after a restart", async () => {
    const s = await scene();
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(async () => (await trip(s.ben)).role === "creator");
    expect(s.ben.net.joined.has(topicOfCode(s.code))).toBe(true);
    await s.ben.store.close();

    const deps = restarted(s.ben.deps);
    const net = watchNet(deps.network);
    const reopened = createPhotoStore(deps);
    await reopened.ready();
    expect(net.joined.has(topicOfCode(s.code))).toBe(true);
    expect(net.joined.has(String(deps.drives.discoveryKeyOf(s.shareKey)))).toBe(true);
    expect((await reopened.folders()).folders[0]!.notice).toEqual({
      kind: "madeAdmin",
      fromName: "Ada",
    });
    for (const store of [reopened, s.ada.store, s.cy.store]) await store.close();
  }, 30_000);
});

describe("a handover package sent to a Viewer", () => {
  it("is ignored", async () => {
    const s = await scene();
    expect((await s.ada.store.makeViewer(s.folderId, s.cyKey))[0]).toBeNull();
    await until(async () => (await trip(s.cy)).role === "reader");
    const cyIdentity = debugOf(s.cy.store).identityDrive;
    const conn = s.ada.net.events.find(
      (e): e is Extract<PeerEvent, { type: "identified" }> =>
        e.type === "identified" && e.identityKey === cyIdentity,
    )!.conn;
    const [, drive] = await s.cy.deps.drives.open(s.shareKey, { timeoutMs: 5_000 });
    const code = "cd".repeat(32);
    const proof = { from: "01".repeat(32), to: "02".repeat(32), publicKey: "03".repeat(32) };
    s.ada.deps.network.sendAnswer(conn, {
      kind: "handover",
      album: s.cy.deps.drives.discoveryKeyOf(s.shareKey),
      digest: await listsDigest(drive!, hash),
      admin: {
        fromName: "Ada",
        invite: { code },
        chains: { [code]: [{ ...proof, signature: "04".repeat(64) }] },
      },
    });
    await sleep(3_000);
    expect(debugOf(s.cy.store).folders[0]!.takingOver).toBeUndefined();
    expect((await trip(s.cy)).role).not.toBe("creator");
    for (const p of [s.ada, s.ben, s.cy]) await p.store.close();
  }, 30_000);
});

describe("an old Admin once /admin.json is written (more)", () => {
  it("refuses every other album change it no longer owns", async () => {
    const s = await scene({ holdDone: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.ada.store).folders[0]!.handover?.written === true);
    const refused = PhotoError.HANDOVER_REFUSED;
    expect((await s.ada.store.makeMember(s.folderId, s.cyKey))[0]?.code).toBe(refused);
    expect((await s.ada.store.respond(s.folderId, "ab".repeat(32), true))[0]?.code).toBe(refused);
    expect((await s.ada.store.enroll("ef".repeat(32), "Zed"))[0]?.code).toBe(refused);
    const before = new Set(s.ada.net.joined);
    expect((await s.ada.store.turnOffInvite(s.folderId))[0]?.code).toBe(refused);
    expect([...s.ada.net.joined].filter((t) => !before.has(t))).toEqual([]);
    expect((await s.ada.store.saveInviteLink(s.folderId, Date.now() + 60_000))[0]?.code).toBe(
      refused,
    );
    expect((await s.ada.store.offerAlbum(s.folderId, s.cyKey))[0]?.code).toBe(refused);
    expect((await s.ada.store.takeBackOffer(s.folderId, s.cyKey))[0]?.code).toBe(refused);
    for (const p of [s.ada, s.ben, s.cy]) await p.store.close();
  }, 30_000);
});

describe("a done that is not from the new Admin", () => {
  it("leaves the album on Ada's phone", async () => {
    const s = await scene({ holdDone: true });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    await until(() => debugOf(s.ada.store).folders[0]!.handover?.written === true);
    const adaIdentity = debugOf(s.ada.store).identityDrive;
    const cyIdentity = debugOf(s.cy.store).identityDrive;
    const identified = (net: Phone["net"], identity: string) =>
      net.events.find(
        (e): e is Extract<PeerEvent, { type: "identified" }> =>
          e.type === "identified" && e.identityKey === identity,
      )!.conn;
    // Only the message from Cy's phone gets through to Ada's phone.
    s.held.pass = identified(s.ada.net, cyIdentity);
    const conn = identified(s.cy.net, adaIdentity);
    s.cy.deps.network.sendAnswer(conn, {
      kind: "handoverDone",
      album: s.ada.deps.drives.discoveryKeyOf(s.shareKey),
    });
    await sleep(1_000);
    expect(debugOf(s.ada.store).folders).toHaveLength(1);
    for (const p of [s.ada, s.ben, s.cy]) await p.store.close();
  }, 30_000);
});

describe("a done before the handover is written", () => {
  it("leaves the album on Ada's phone", async () => {
    const s = await scene();
    setFakeNodeConnected({ hub: s.hub, node: s.ben.node, connected: false });
    expect((await s.ada.store.handOver(s.folderId, s.benKey))[0]).toBeNull();
    const adaIdentity = debugOf(s.ada.store).identityDrive;
    const conn = s.ben.net.events.find(
      (e): e is Extract<PeerEvent, { type: "identified" }> =>
        e.type === "identified" && e.identityKey === adaIdentity,
    )!.conn;
    s.ben.deps.network.sendAnswer(conn, {
      kind: "handoverDone",
      album: s.ada.deps.drives.discoveryKeyOf(s.shareKey),
    });
    await sleep(1_000);
    expect(debugOf(s.ada.store).folders).toHaveLength(1);
    expect(debugOf(s.ada.store).folders[0]!.handover?.written).toBe(false);
    for (const p of [s.ada, s.ben, s.cy]) await p.store.close();
  }, 30_000);
});
