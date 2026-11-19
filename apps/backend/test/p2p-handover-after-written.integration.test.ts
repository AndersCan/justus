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

/** Who asks with the owner's invite and is let in as a Collaborator; returns the asker's key. */
async function letIn(owner: Peer, who: Peer, folderId: string, code: string) {
  const owned = (owner.store.debugState() as { identityDrive: string }).identityDrive;
  await ok(who.store.ask({ code, owner: owned }));
  const { requests } = await eventually(
    () => owner.store.requests(),
    (r) => r.requests.some((q) => q.requesterName === who.name),
    `${who.name}'s ask on ${owner.name}`,
  );
  const key = requests.find((q) => q.requesterName === who.name)!.requesterKey;
  await ok(owner.store.respond(folderId, key, true, "member"));
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

describe("after the handover is written", () => {
  it("a photo Ada adds before her phone lets the album go is refused or reaches Ben", async () => {
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
      async () => ada.events.some((e) => e.event === "handover.written"),
      (written) => written,
      "the handover written on Ada's phone",
      30_000,
    );
    const [lateErr] = await ada.store.addBytes("late.jpg", Buffer.alloc(200_000, 99), folderId);
    await eventually(
      async () => (await ada.store.folders()).folders.length,
      (n) => n === 0,
      "the album left Ada's phone",
      60_000,
    );
    await ada.stop();

    const onCy = await ok(cy.drives.open(shareKey, { timeoutMs: 10_000 }));
    const paths = await listed(onCy, lateErr ? 6 : 7);
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
});
