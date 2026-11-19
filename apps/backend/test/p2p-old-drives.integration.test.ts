/**
 * After a Remove, the album's old drives serve no photo the removed phone never
 * opened. Real Corestore and Hyperswarm, because a fake world refills a cleared
 * file from any other holder. It stages thumbnails with node:fs, so it cannot
 * live in the Bare-shared `p2p-scenarios.ts`.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Drive } from "../src/ports/drive-store.ts";
import { eventually, realNet, type Net } from "./real-peers.ts";
import { albumIn, type Peer } from "./p2p-scenarios.ts";

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
  writeFileSync(display, new Uint8Array([seed, seed + 1, seed + 2]));
  writeFileSync(thumb, new Uint8Array([seed + 10, seed + 11]));
  await ok(peer.store.add(display, name, folderId, { thumb }));
}

/** Who asks with the owner's invite and is let in as a Collaborator; returns the asker's key. */
async function letIn(owner: Peer, who: Peer, folderId: string, code: string) {
  const owned = (owner.store.debugState() as { identityDrive: string }).identityDrive;
  await ok(who.store.ask({ code, owner: owned }));
  const { requests } = await eventually(
    () => owner.store.requests(),
    (r) => r.requests.length > 0,
    `${who.name}'s ask on ${owner.name}`,
  );
  const key = requests[0].requesterKey;
  await ok(owner.store.respond(folderId, key, true, "member"));
  return key;
}

async function open(peer: Peer, key: string): Promise<Drive> {
  return ok(peer.drives.open(key, { timeoutMs: 10_000 }));
}

/** The photo and preview paths the writer's own drive lists, by file name stem order. */
async function pathsOn(drive: Drive, count: number) {
  const photos: string[] = [];
  await eventually(
    async () => {
      photos.length = 0;
      for await (const e of drive.list("/photos")) photos.push(e.path);
      return photos.length;
    },
    (n) => n >= count,
    "the photos listed",
  );
  photos.sort((a, b) => a.localeCompare(b));
  return photos.map((photo) => ({ photo, thumb: photo.replace("/photos/", "/thumbs/") }));
}

/** What Ben's own node gets from `path` once it knows the entry: the old keys, no app. */
async function ask(drive: Drive, path: string) {
  await eventually(
    async () => {
      await drive.update();
      for await (const e of drive.list("/photos")) if (e.path === path) return true;
      for await (const e of drive.list("/thumbs")) if (e.path === path) return true;
      return false;
    },
    (known) => known,
    `${path} known`,
    10_000,
  );
  return drive.download(path, { timeoutMs: 8_000 });
}

describe("old drives after a Remove", () => {
  it("after a Remove, the old keys open no photo the removed phone never opened", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const cy = await net.peer("Cy");

    const created = await ok(ada.store.createFolder("Trip"));
    const { id: folderId, shareKey, invite } = created.folder;
    await ok(ada.store.setActive(folderId));
    const benKey = await letIn(ada, ben, folderId, invite!.code);
    await letIn(ada, cy, folderId, invite!.code);

    const side = await ok(cy.store.createFolder("Side"));
    await letIn(cy, ben, side.folder.id, side.folder.invite!.code);

    await addPhoto(ada, folderId, "one.jpg", 10);
    await addPhoto(ada, folderId, "two.jpg", 40);

    const cyAlbum = await eventually(
      () => albumIn(cy.store, shareKey),
      (a) => a?.role === "member",
      "Cy a member of the album",
      30_000,
    ).then((a) => a!);
    await ok(cy.store.setActive(cyAlbum.id));
    await addPhoto(cy, cyAlbum.id, "cy.jpg", 100);
    const cyOld = cyAlbum.driveKey;
    const oldOnAda = await open(ada, shareKey);
    const [one, two] = await pathsOn(oldOnAda, 2);
    const cyOnAda = await open(ada, cyOld);
    const [cyPaths] = await pathsOn(cyOnAda, 1);
    expect(await ask(cyOnAda, cyPaths!.photo)).toBe("here");
    expect(await ask(cyOnAda, cyPaths!.thumb)).toBe("here");
    const oldOnBen = await open(ben, shareKey);
    expect(await ask(oldOnBen, one!.photo)).toBe("here");
    expect(await ask(oldOnBen, one!.thumb)).toBe("here");
    const oldOnCy = await open(cy, shareKey);
    expect(await ask(oldOnCy, two!.photo)).toBe("here");
    expect(await ask(oldOnCy, two!.thumb)).toBe("here");

    await ok(ada.store.removeMember(folderId, benKey));
    const moved = (await ada.store.folders()).folders.find((f) => f.id === folderId)!;
    expect(moved.shareKey).not.toBe(shareKey);
    const cleared = (peer: Peer, why: string) =>
      peer.events.some((e) => e.event === "move.cleared" && e.fields.why === why);
    await eventually(
      async () => (await albumIn(cy.store, moved.shareKey))?.role,
      (role) => role === "member",
      "Cy a member on the new key",
      60_000,
    );
    await eventually(
      async () =>
        [
          cleared(ada, "moved"),
          cleared(cy, "followed"),
          cleared(cy, "own"),
          cleared(ada, "copied"),
        ].join(),
      (r) => r === "true,true,true,true",
      "Ada and Cy to clear the old drive",
      60_000,
    );

    await addPhoto(cy, side.folder.id, "control.jpg", 70);
    const sideOnCy = await open(cy, side.folder.shareKey);
    const [control] = await pathsOn(sideOnCy, 1);
    const sideOnBen = await open(ben, side.folder.shareKey);
    await eventually(
      () => ask(sideOnBen, control!.photo),
      (r) => r === "here",
      "Ben reaching Cy after the Remove",
      15_000,
    );

    const cyOnBen = await open(ben, cyOld);
    expect(await ask(cyOnBen, cyPaths!.photo)).toBe("timedOut");
    expect(await ask(cyOnBen, cyPaths!.thumb)).toBe("timedOut");
    expect(await ask(oldOnBen, two!.photo)).toBe("timedOut");
    expect(await ask(oldOnBen, two!.thumb)).toBe("timedOut");
    expect(await ask(oldOnBen, one!.photo)).toBe("here");
    expect(await ask(oldOnBen, one!.thumb)).toBe("here");

    const onCy = await open(cy, moved.shareKey);
    const kept = await pathsOn(onCy, 2);
    expect(kept.map((k) => k.photo)).toEqual([one!.photo, two!.photo]);
    for (const peer of [ada, cy]) {
      const names = (await peer.store.list({ all: true })).map((p) => p.name);
      expect(names).toContain("cy.jpg");
    }
    expect(await ask(onCy, two!.photo)).toBe("here");
  }, 90_000);

  it("an Admin whose phone restarted before it cleared the old drive clears it at the next start", async () => {
    const net = await realNet();
    nets.push(net);
    const ada = await net.peer("Ada");
    const ben = await net.peer("Ben");
    const created = await ok(ada.store.createFolder("Trip"));
    const { id: folderId, shareKey, invite } = created.folder;
    await ok(ada.store.setActive(folderId));
    const benKey = await letIn(ada, ben, folderId, invite!.code);
    await addPhoto(ada, folderId, "one.jpg", 10);

    await ok(ada.store.removeMember(folderId, benKey));
    await eventually(
      async () => ada.events.some((e) => e.event === "move.cleared" && e.fields.why === "moved"),
      Boolean,
      "Ada to clear the old drive",
      60_000,
    );

    // The restart that cut the clear short, as the drive would have been left: the bytes are back.
    const old = await open(ada, shareKey);
    const [one] = await pathsOn(old, 1);
    for await (const e of old.list(one!.photo)) {
      await old.put(e.path, new Uint8Array([10, 11, 12]), { metadata: e.metadata });
    }
    await old.put("/photos/late.jpg", new Uint8Array([9, 9]));
    await ada.stop();
    const back = await net.peer("Ada", ada.storageDir);
    await eventually(
      async () => back.events.some((e) => e.event === "move.cleared" && e.fields.why === "start"),
      Boolean,
      "Ada to clear the old drive at start",
      30_000,
    );
    const after = await open(back, shareKey);
    expect(await ask(after, one!.photo)).toBe("timedOut");
    expect(await ask(after, "/photos/late.jpg")).toBe("here");
  }, 90_000);
});
