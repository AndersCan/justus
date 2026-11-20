/**
 * Requests made with the old Admin's link after the album was handed on:
 * the new Admin's phone tells the asker, the ask is sealed to it again, and
 * the request opens on the new Admin's phone. Phones share one fake hub.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPhotoStore } from "../src/photo-store.ts";
import { inviteTopic } from "../src/membership/invite.ts";
import type { PeerEvent } from "../src/ports/peer-network.ts";
import { createFakeHub, addFakeNode, setFakeNodeConnected } from "./fakes/fake-world.ts";
import {
  FakeLoopbackServer,
  fakeStoreDeps,
  joinAsMember,
  restarted,
} from "./fakes/fake-store-deps.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await sleep(25);
  expect(await check()).toBe(true);
}

function phone(hub: ReturnType<typeof createFakeHub>, deviceName: string) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const deps = fakeStoreDeps({ hub, node, deviceName, server: new FakeLoopbackServer() });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, node, store: createPhotoStore(deps) };
}
type Phone = ReturnType<typeof phone>;

const identityOf = (p: Phone) => (p.store.debugState() as { identityDrive: string }).identityDrive;
const trip = async (p: Phone) => (await p.store.folders()).folders.find((f) => f.name === "Trip")!;

/** Ada's "Trip" with Ben as a Collaborator; Cy is outside the album. */
async function scene() {
  const hub = createFakeHub();
  const ada = phone(hub, "Ada");
  const ben = phone(hub, "Ben");
  const cy = phone(hub, "Cy");
  for (const p of [ada, ben, cy]) await p.store.ready();
  const created = await ada.store.createFolder("Trip");
  const folder = created[1]!.folder;
  const benKey = await joinAsMember(ada.store, folder.id, ben.store, folder.shareKey);
  await until(async () => (await ada.store.status()).members.length === 2);
  const handOver = async () => {
    expect((await ada.store.handOver(folder.id, benKey))[0]).toBeNull();
    await until(async () => (await trip(ben)).role === "creator");
  };
  const close = async () => {
    for (const p of [ada, ben, cy]) await p.store.close();
  };
  return { hub, ada, ben, cy, code: folder.invite!.code, folderId: folder.id, handOver, close };
}

describe("a request made with the old Admin's link", () => {
  it("reaches the new Admin, who lets the asker in", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    const [seenByAda] = (await s.ada.store.requests()).requests;
    await s.handOver();

    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    const [onBen] = (await s.ben.store.requests()).requests;
    expect(onBen!.checkCode).toBe(seenByAda!.checkCode);
    expect((await s.cy.store.folders()).asks[0]).toMatchObject({
      owner: identityOf(s.ben),
      checkCode: onBen!.checkCode,
    });

    const benFolder = await trip(s.ben);
    expect((await s.ben.store.respond(benFolder.id, onBen!.requesterKey, true))[0]).toBeNull();
    await until(async () => (await s.cy.store.folders()).folders.some((f) => f.name === "Trip"));
    expect((await s.cy.store.folders()).asks).toEqual([]);
    await s.close();
  }, 40_000);

  it("filed before the handover, with Ada's phone off from then on, reaches Ben without Cy asking again", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    await sleep(500);
    await s.handOver();
    setFakeNodeConnected({ hub: s.hub, node: s.ada.node, connected: false });
    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    expect((await s.cy.store.folders()).asks[0]).toMatchObject({ owner: identityOf(s.ben) });
    await s.close();
  }, 40_000);

  it("filed before the handover, with Cy already connected to Ben, reaches Ben without Cy asking again", async () => {
    const s = await scene();
    // Ben and Cy meet before the handover (on real phones the swarm links them through the album's topics).
    const met = "aa".repeat(32);
    s.ben.deps.network.join(met, { server: true });
    s.cy.deps.network.join(met, { server: false });
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    await sleep(500);
    await s.handOver();
    setFakeNodeConnected({ hub: s.hub, node: s.ada.node, connected: false });
    await until(
      async () => (await s.cy.store.folders()).asks[0]?.owner === identityOf(s.ben),
      5_000,
    );
    await until(async () => (await s.ben.store.requests()).requests.length === 1, 5_000);
    await s.close();
  }, 40_000);

  it("made after the handover, with Ada's phone off, still reaches Ben", async () => {
    const s = await scene();
    await s.handOver();
    setFakeNodeConnected({ hub: s.hub, node: s.ada.node, connected: false });

    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    const [ask] = (await s.cy.store.folders()).asks;
    expect(ask).toMatchObject({ owner: identityOf(s.ben), status: "waiting" });
    await until(async () => (await s.cy.store.folders()).asks[0]?.albumName === "Trip");
    expect((await s.cy.store.folders()).asks[0]!.ownerName).toBe("");
    await s.close();
  }, 40_000);

  it("made with a link Ada turned off before the handover, is told the link is off once it opens on Ben", async () => {
    const s = await scene();
    expect((await s.ada.store.turnOffInvite(s.folderId))[0]).toBeNull();
    await s.handOver();
    setFakeNodeConnected({ hub: s.hub, node: s.ada.node, connected: false });

    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.cy.store.folders()).asks[0]?.status === "linkOff");
    expect((await s.cy.store.folders()).asks[0]).toMatchObject({ owner: identityOf(s.ben) });
    expect((await s.ben.store.requests()).requests).toEqual([]);
    await s.close();
  }, 40_000);

  it("asked again after a Cancel, reaches Ben", async () => {
    const s = await scene();
    await s.handOver();
    setFakeNodeConnected({ hub: s.hub, node: s.ada.node, connected: false });
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    expect((await s.cy.store.cancelAsk(s.code))[0]).toBeNull();
    await until(async () => (await s.ben.store.requests()).requests.length === 0);
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    await s.close();
  }, 60_000);

  it("is not re-pointed by a phone that is not the new Admin", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    await sleep(300);
    expect((await s.cy.store.folders()).asks[0]!.owner).toBe(identityOf(s.ada));
    await s.close();
  }, 20_000);
  it("an ask filed before this update (no sealedFor) is sealed again for the new Admin", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    // As a build without `sealedFor` saved it: drop the field, restart Cy's phone.
    await s.cy.store.close();
    const file = join(s.cy.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const asks = (saved.asks ?? saved.state?.asks) as Array<Record<string, unknown>>;
    expect(asks[0]!.sealedFor).toBe(identityOf(s.ada));
    for (const a of asks) delete a.sealedFor;
    writeFileSync(file, JSON.stringify(saved));
    const cy = { ...s.cy, store: createPhotoStore(restarted(s.cy.deps)) };
    await cy.store.ready();
    s.cy.store = cy.store;
    await s.handOver();
    await until(async () => (await s.ben.store.requests()).requests.length === 1);
    await s.close();
  }, 40_000);

  it("keeps the ask sealed for Ada when the new Admin's sealing key cannot be read", async () => {
    const s = await scene();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    const [openErr, benDrive] = await s.cy.deps.drives.open(identityOf(s.ben), {
      timeoutMs: 2_000,
    });
    expect(openErr).toBeNull();
    const readSmall = benDrive!.readSmall.bind(benDrive!) as (
      ...a: unknown[]
    ) => Promise<string | null>;
    // Only the ask's own read (no options) loses the key; identity checks read it whole.
    benDrive!.readSmall = (async (...args: unknown[]) => {
      const text = await readSmall(...args);
      if (args[0] !== "/device.json" || args[2] !== undefined || text === null) return text;
      const { boxKey: _dropped, ...rest } = JSON.parse(text);
      return JSON.stringify(rest);
    }) as typeof benDrive.readSmall;
    await s.handOver();
    await until(async () => (await s.cy.store.folders()).asks[0]?.owner === identityOf(s.ben));
    await sleep(500);
    const [err, outbox] = await s.cy.deps.drives.open(identityOf(s.cy), { timeoutMs: 1_000 });
    expect(err).toBeNull();
    const text = (await outbox!.readSmall("/requests.json", 1 << 20)) ?? "";
    expect(JSON.parse(text).requests[`invite:${s.code}`].sealedKey).toBeTypeOf("string");
    await s.close();
  }, 40_000);

  it("is not re-pointed by a handover whose chain a phone signed itself", async () => {
    const s = await scene();
    const dan = phone(s.hub, "Dan");
    const events: PeerEvent[] = [];
    const start = dan.deps.network.start.bind(dan.deps.network);
    dan.deps.network.start = (...[identity, onEvent, protocol]: Parameters<typeof start>) =>
      start(identity, (e: PeerEvent) => (events.push(e), onEvent(e)), protocol);
    await dan.store.ready();
    await s.cy.store.ask({ code: s.code, owner: identityOf(s.ada) });
    await until(async () => (await s.ada.store.requests()).requests.length === 1);
    dan.deps.network.join(inviteTopic(s.code, { createHash } as never).toString("hex"), {
      server: false,
    });
    await until(() =>
      events.some((e) => e.type === "identified" && e.identityKey === identityOf(s.cy)),
    );
    const conn = events.find(
      (e): e is Extract<PeerEvent, { type: "identified" }> =>
        e.type === "identified" && e.identityKey === identityOf(s.cy),
    )!.conn;
    const forged = {
      from: identityOf(s.ada),
      to: identityOf(dan),
      publicKey: "03".repeat(32),
      signature: "04".repeat(64),
    };
    expect(
      dan.deps.network.sendAnswer(conn, { code: s.code, answer: "handedOver", chain: [forged] }),
    ).toBe(true);
    await sleep(1_000);
    expect((await s.cy.store.folders()).asks[0]!.owner).toBe(identityOf(s.ada));
    await dan.store.close();
    await s.close();
  }, 30_000);
});
