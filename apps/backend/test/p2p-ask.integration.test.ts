/**
 * Delivery of an Admin's answer over a real swarm, against a device that lies
 * about who it is. The greeting only *claims* an identity drive; the Admin
 * sends the album's key to a connection only when that drive's `/device.json`
 * names the connection's own noise key.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, rmSync } from "node:fs";
import Corestore from "corestore";
import Hyperdrive from "hyperdrive";
import Hyperswarm from "hyperswarm";
import createTestnet from "hyperdht/testnet";
import { greetPeer } from "../src/adapters/peer-identity.ts";
import { openAnswers } from "../src/adapters/peer-answer.ts";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";
import { eventually } from "./p2p-scenarios.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function device(
  name: string,
  bootstrap: unknown[],
  extra: { claim?: () => string; received?: unknown[] } = {},
) {
  const deps = makeFakeDeps({
    deviceName: name,
    makeCorestore: (dir) => new Corestore(dir),
    makeDrive: (cs, key) => new Hyperdrive(cs, key),
    makeSwarm: () => new Hyperswarm({ bootstrap }),
    greetPeer: extra.claim
      ? (conn: unknown, own: Uint8Array, onIdentity: (key: Uint8Array) => void) =>
          greetPeer(
            conn,
            Buffer.from(extra.claim!() || Buffer.from(own).toString("hex"), "hex"),
            onIdentity,
          )
      : undefined,
    openAnswers: (conn: unknown, onAnswer: (value: unknown) => void) =>
      openAnswers(conn, (value) => {
        extra.received?.push(value);
        onAnswer(value);
      }),
    driveOpenTimeoutMs: 10_000,
  });
  mkdirSync(deps.cacheDir, { recursive: true });
  const store = createPhotoStore(deps);
  cleanups.push(async () => {
    await store.close();
    rmSync(deps.storageDir, { recursive: true, force: true });
  });
  const identity = () => (store.debugState() as { identityDrive: string }).identityDrive;
  return { store, identity };
}

describe("answer delivery", () => {
  it("never reaches a device that only claims the asker's identity", async () => {
    const net = await createTestnet(5);
    cleanups.push(() => net.destroy());
    const admin = device("Admin", net.bootstrap);
    const joiner = device("Joiner", net.bootstrap);
    const stolen: string[] = [];
    const received: unknown[] = [];
    const impostor = device("Impostor", net.bootstrap, {
      claim: () => stolen[0] ?? "",
      received,
    });
    await Promise.all([admin.store, joiner.store, impostor.store].map((s) => s.ready()));
    stolen.push(joiner.identity());

    const created = await admin.store.createFolder("Trip");
    const { id: folderId, shareKey, invite } = created[1]!.folder;
    const ask = { code: invite!.code, owner: admin.identity(), albumName: "Trip" };
    expect((await joiner.store.ask(ask))[0]).toBeNull();
    expect((await impostor.store.ask(ask))[0]).toBeNull();

    const { requests } = await eventually(
      () => admin.store.requests(),
      (r) => r.requests.length === 1,
      "the joiner's ask on the Admin",
      30_000,
    );
    // Both connections claim the joiner's identity: the lie is really in play.
    await eventually(
      async () =>
        (
          admin.store.debugState() as { connections: { identityKey: string | null }[] }
        ).connections.filter((c) => c.identityKey === joiner.identity()).length,
      (n) => n >= 2,
      "two connections claiming the joiner's identity",
      30_000,
    );
    expect((await admin.store.respond(folderId, requests[0].requesterKey, true))[0]).toBeNull();

    await eventually(
      async () => (await joiner.store.folders()).folders.find((f) => f.shareKey === shareKey),
      (f) => f?.role === "member",
      "the real joiner becomes a member",
      30_000,
    );
    // Give the Admin time to (wrongly) answer the impostor as well.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(received).toEqual([]);
    expect(JSON.stringify(await impostor.store.folders())).not.toContain(shareKey);
    expect((await impostor.store.folders()).asks.map((a) => a.status)).toEqual(["waiting"]);
  }, 90_000);
});
