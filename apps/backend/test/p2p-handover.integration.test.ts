/**
 * After Ada hands an album to Ben, Ben's phone serves her photos with her phone
 * off. Real Corestore and Hyperswarm, because a fake world lets any holder
 * refill a block. It stages photos with node:fs, so it cannot live in the
 * Bare-shared `p2p-scenarios.ts`.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Drive } from "../src/ports/drive-store.ts";
import { eventually, realNet, type Net } from "./real-peers.ts";
import type { Peer } from "./p2p-scenarios.ts";

const nets: Net[] = [];
afterEach(async () => {
  for (const net of nets.splice(0)) await net.destroy();
});

async function ok<T>(result: Promise<readonly [{ message: string } | null, T | null]>): Promise<T> {
  const [err, value] = await result;
  if (err) throw new Error(err.message);
  return value as T;
}

async function addPhoto(peer: Peer, folderId: string, name: string, seed: number) {
  const cache = join(peer.storageDir, "cache");
  mkdirSync(cache, { recursive: true });
  const display = join(cache, `${name}-display.jpg`);
  const thumb = join(cache, `${name}-thumb.jpg`);
  writeFileSync(display, new Uint8Array(200_000).fill(seed));
  writeFileSync(thumb, new Uint8Array(20_000).fill(seed + 1));
  await ok(peer.store.add(display, name, folderId, { thumb }));
}

/** Who asks with the owner's invite and is let in as a Collaborator unless `role` says otherwise; returns the asker's key. */
async function letIn(
  owner: Peer,
  who: Peer,
  folderId: string,
  code: string,
  role: "member" | "reader" = "member",
) {
  const owned = (owner.store.debugState() as { identityDrive: string }).identityDrive;
  await ok(who.store.ask({ code, owner: owned }));
  const { requests } = await eventually(
    () => owner.store.requests(),
    (r) => r.requests.some((q) => q.requesterName === who.name),
    `${who.name}'s ask on ${owner.name}`,
  );
  const key = requests.find((q) => q.requesterName === who.name)!.requesterKey;
  await ok(owner.store.respond(folderId, key, true, role));
  return key;
}

/** Every photo and preview path `drive` lists. */
async function listed(drive: Drive, count: number) {
  return eventually(
    async () => {
      await drive.update();
      const paths: string[] = [];
      for (const dir of ["/photos", "/thumbs"]) {
        for await (const e of drive.list(dir)) paths.push(e.path);
      }
      return paths;
    },
    (paths) => paths.length >= count,
    "Ada's photos listed",
    20_000,
  );
}

describe("after a handover", () => {
  it("Ben's phone serves Ada's photos after she hands Summer over and her phone is off", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const cy = await net.peer("Cy");

    const created = await ok(ada.store.createFolder("Summer"));
    const { id: folderId, shareKey, invite } = created.folder;
    await ok(ada.store.setActive(folderId));
    const benKey = await letIn(ada, ben, folderId, invite!.code);
    await letIn(ada, cy, folderId, invite!.code);
    for (const [i, name] of ["one.jpg", "two.jpg", "three.jpg"].entries()) {
      await addPhoto(ada, folderId, name, 10 + i * 20);
    }

    await ok(ada.store.handOver(folderId, benKey));
    await eventually(
      async () => (await ada.store.folders()).folders.length,
      (n) => n === 0,
      "the album left Ada's phone",
      60_000,
    );
    await ada.stop();

    for (const peer of [ben, cy]) {
      const folder = (await peer.store.folders()).folders[0]!;
      await ok(peer.store.setActive(folder.id));
      const shown = await eventually(
        () => peer.store.list(),
        (photos) => photos.length === 3,
        `Ada's 3 photos on ${peer.name}`,
        60_000,
      );
      expect(shown.every((p) => p.member?.name === "Ada")).toBe(true);
    }

    const onCy = await ok(cy.drives.open(shareKey, { timeoutMs: 10_000 }));
    const paths = await listed(onCy, 6);
    expect(paths).toHaveLength(6);
    for (const path of paths) {
      expect(await onCy.download(path, { timeoutMs: 8_000 })).toBe("here");
    }

    await ben.stop();
    const again = await net.peer("Ben", ben.storageDir);
    const onBen = await ok(again.drives.open(shareKey, { timeoutMs: 10_000 }));
    for (const path of paths) {
      expect(await onBen.download(path, { timeoutMs: 5_000 })).toBe("here");
    }
  }, 120_000);

  it("Dee still adds photos everyone sees after Ben, handed Summer, removes Cy", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const cy = await net.peer("Cy");
    const dee = await net.peer("Dee");
    const eve = await net.peer("Eve");

    const created = await ok(ada.store.createFolder("Summer"));
    const { id: folderId, shareKey, invite } = created.folder;
    await ok(ada.store.setActive(folderId));
    const benKey = await letIn(ada, ben, folderId, invite!.code);
    const cyKey = await letIn(ada, cy, folderId, invite!.code);
    await letIn(ada, dee, folderId, invite!.code);
    await letIn(ada, eve, folderId, invite!.code, "reader");
    await addPhoto(ada, folderId, "one.jpg", 10);

    for (const peer of [ben, cy, dee]) {
      await eventually(
        async () => (await peer.store.folders()).folders.find((f) => f.shareKey === shareKey),
        (f) => f?.role === "member",
        `${peer.name} a Collaborator`,
        60_000,
      );
    }
    await eventually(
      async () => (await eve.store.folders()).folders.find((f) => f.shareKey === shareKey),
      (f) => f !== undefined,
      "Eve's album",
      60_000,
    );

    await ok(ada.store.handOver(folderId, benKey));
    await eventually(
      async () => (await ada.store.folders()).folders.length,
      (n) => n === 0,
      "the album left Ada's phone",
      60_000,
    );
    await ada.stop();
    const onBen = await eventually(
      async () => (await ben.store.folders()).folders[0],
      (f) => f?.role === "creator",
      "Ben the creator",
      60_000,
    );

    await ok(ben.store.removeMember(onBen!.id, cyKey));
    const newKey = (await ben.store.folders()).folders[0]!.shareKey;
    expect(newKey).not.toBe(shareKey);

    const onDee = (await dee.store.folders()).folders[0]!;
    await eventually(
      async () => (await dee.store.folders()).folders.find((f) => f.id === onDee.id),
      (f) => f?.shareKey === newKey && f.role === "member",
      "Dee a Collaborator on the new key",
      60_000,
    );
    await ok(dee.store.setActive(onDee.id));
    await addPhoto(dee, onDee.id, "dee.jpg", 70);

    for (const peer of [ben, eve]) {
      const folder = (await peer.store.folders()).folders[0]!;
      await ok(peer.store.setActive(folder.id));
      const shown = await eventually(
        () => peer.store.list(),
        (photos) => photos.some((p) => p.name === "dee.jpg"),
        `dee.jpg on ${peer.name}`,
        30_000,
      );
      expect(shown.find((p) => p.name === "dee.jpg")?.member?.name).toBe("Dee");
    }
    const onEve = (await eve.store.folders()).folders[0]!;
    expect(onEve.shareKey).toBe(newKey);
    expect(onEve.role).toBe("reader");

    const seenByCy = await cy.store.list({ all: true });
    expect(seenByCy.some((p) => p.name === "dee.jpg")).toBe(false);

    await dee.stop();
    const deeAgain = await net.peer("Dee", dee.storageDir);
    await eventually(
      async () => (await deeAgain.store.folders()).folders.find((f) => f.id === onDee.id),
      (f) => f?.shareKey === newKey && f.role === "member",
      "Dee a Collaborator on the new key after a restart",
      30_000,
    );
  }, 180_000);
});
