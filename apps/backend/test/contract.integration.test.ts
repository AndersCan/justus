/**
 * Backend -> web contract, proven with REAL backend output (two devices on a
 * real swarm, driven through the real `justus.photos` plugin).
 *
 * Every invoke result and `photos.changed` push the scenario produces must pass
 * the `@justus/core` validators, and its (canonicalised) shape must be covered
 * by the checked-in fixture `packages/core/fixtures/backend-payloads.json`,
 * which the web tests replay through the machines. A backend shape change
 * therefore fails here until the fixture is regenerated and the web consumers
 * are exercised against the new shape:
 *
 *   JUSTUS_UPDATE_FIXTURES=1 vp test run apps/backend/test/contract.integration.test.ts
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkPhotoChanged, checkPhotoResult, photoResultSchemas } from "../src/contract.ts";
import { createPhotosPlugin } from "../src/photos-plugin.ts";
import type { PhotoStore } from "../src/photo-store.ts";
import { eventually, realNet } from "./real-peers.ts";

const FIXTURE = fileURLToPath(
  new URL("../../../packages/core/fixtures/backend-payloads.json", import.meta.url),
);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Captured = Record<string, unknown[]>;

/** Stable stand-ins for values that differ per run, so a fixture is diffable. */
function canonicalise(value: unknown, seen: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/[0-9a-f]{64}/g, (m) => {
      if (!seen.has(m)) seen.set(m, (seen.size + 1).toString(16).padStart(2, "0").repeat(32));
      return seen.get(m)!;
    });
  }
  if (typeof value === "number") return value > 1e11 ? 1_700_000_000_000 : value;
  if (Array.isArray(value)) return value.map((v) => canonicalise(v, seen));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonicalise(v, seen)]));
  }
  return value;
}

/** `path:type` lines; array indices collapse so list length is irrelevant. */
function shapeOf(value: unknown, path = "$", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    out.add(`${path}:array`);
    for (const v of value) shapeOf(v, `${path}[]`, out);
  } else if (value && typeof value === "object") {
    out.add(`${path}:object`);
    for (const [k, v] of Object.entries(value)) shapeOf(v, `${path}.${k}`, out);
  } else out.add(`${path}:${value === null ? "null" : typeof value}`);
  return out;
}

describe("backend -> web contract, from real backend output", () => {
  it("every payload passes the core validators and matches the checked-in fixture", async () => {
    const net = await realNet();
    cleanups.push(() => net.destroy());
    const admin = await net.peer("Phone");
    const joiner = await net.peer("Desktop");
    const asker = await net.peer("Tablet");
    const watcher = await net.peer("Watcher");

    const captured: Captured = {};
    const plugin = (store: PhotoStore) => {
      const bare = createPhotosPlugin({ store, checkContract: true }).runtimes!.bare!;
      return async (name: string, args: Record<string, unknown> = {}, payload?: Uint8Array) => {
        const [err, result] = (await bare.invoke!(name, args, { payload } as never)) as [
          Error | null,
          unknown,
        ];
        // The plugin already asserts (checkContract): surface its message.
        expect(err?.message ?? null, name).toBeNull();
        expect(checkPhotoResult(name, result), name).toBeNull();
        (captured[name] ??= []).push(result);
        return result as any;
      };
    };
    const a = plugin(admin.store);
    const b = plugin(joiner.store);
    const c = plugin(asker.store);
    const w = plugin(watcher.store);

    // A fresh device: no folders, and an empty (not null) active id.
    await a("photos.folders");
    const { folder } = await a("photos.createFolder", { name: "Contract" });
    await a("photos.setActive", { folderId: folder.id });
    await a("photos.setName", { name: "Phone" });
    const photo = await a(
      "photos.add",
      { name: "a.jpg", folderId: folder.id },
      new Uint8Array([211, 2, 3]),
    );
    await a("photos.list", { all: true });
    await a("photos.status");
    await a("photos.folders");

    await b("photos.join", { key: folder.shareKey, name: "From invite" });
    await eventually(
      () => b("photos.list"),
      (l: any) => l.photos.length === 1,
      "the Admin's photo on the joiner",
    );
    await b("photos.status");
    await b("photos.folders");
    const { requests } = await eventually(
      () => a("photos.requests"),
      (r: any) => r.requests.length === 1,
      "the join request on the Admin",
    );
    await a("photos.respond", {
      folderId: folder.id,
      requesterKey: requests[0].requesterKey,
      approve: true,
    });
    await eventually(
      () => b("photos.folders"),
      (r: any) => r.folders[0]?.role === "member" && !r.folders[0]?.pending,
      "the joiner's upgrade to member",
    );
    await a("photos.status");
    await a("photos.remove", { id: photo.id, folderId: folder.id });
    await a("photos.removeMember", { folderId: folder.id, memberKey: requests[0].requesterKey });
    // The removed phone takes the album off itself.
    const joinerAlbum = (await b("photos.folders")).folders[0];
    await b("photos.leaveAlbum", { folderId: joinerAlbum.id });

    const { folders } = await a("photos.folders");
    const invite = folders[0].invite;
    expect(invite, "the creator's folder carries its invite").toBeDefined();
    // A Viewer asks through the invite code, then the Admin lets them add photos.
    await w("photos.ask", {
      code: invite.code,
      owner: invite.owner,
      albumName: "Contract",
      ownerName: "Phone",
    });
    const viewerAsk = await eventually(
      () => a("photos.requests"),
      (r: any) => r.requests.length === 1,
      "the Viewer's ask on the Admin",
    );
    await a("photos.respond", {
      folderId: folder.id,
      requesterKey: viewerAsk.requests[0].requesterKey,
      approve: true,
      role: "reader",
    });
    await a("photos.makeMember", {
      folderId: folder.id,
      memberKey: viewerAsk.requests[0].requesterKey,
    });
    await a("photos.makeViewer", {
      folderId: folder.id,
      memberKey: viewerAsk.requests[0].requesterKey,
    });

    // A stranger asks, is declined, taps OK, and the same link asks again.
    const ask = {
      code: invite.code,
      owner: invite.owner,
      albumName: "Contract",
      ownerName: "Phone",
    };
    await c("photos.ask", ask);
    const first = await eventually(
      () => a("photos.requests"),
      (r: any) => r.requests.length === 1,
      "the stranger's first ask on the Admin",
    );
    await a("photos.respond", {
      folderId: folder.id,
      requesterKey: first.requests[0].requesterKey,
      approve: false,
    });
    await eventually(
      () => c("photos.folders"),
      (r: any) => r.asks[0]?.status === "declined",
      "the decline on the asker",
    );
    await c("photos.dismissDeclinedAsk", { code: invite.code });
    expect((await c("photos.folders")).asks).toEqual([]);
    // A stranger asks through the album's invite code.
    await c("photos.ask", {
      code: invite.code,
      owner: invite.owner,
      albumName: "Contract",
      ownerName: "Phone",
    });
    await c("photos.folders");
    // The Admin invites the asker's phone by its key.
    await a("photos.offerAlbum", {
      folderId: folder.id,
      identity: (asker.store.debugState() as { identityDrive: string }).identityDrive,
    });
    // The asker taps Join on it and lands in the album.
    const { offers } = await eventually(
      () => c("photos.folders"),
      (r: any) => r.offers.length === 1,
      "the invite on the asker",
    );
    await c("photos.joinOffer", { code: offers[0].code, owner: offers[0].owner });
    await eventually(
      () => c("photos.folders"),
      (r: any) => r.folders.length === 1 && !r.folders[0].pending,
      "the asker in the album",
    );
    // The Admin turns the links off and the album carries a new code.
    await a("photos.turnOffInvite", { folderId: folder.id });

    // The Admin archives the album and brings it back, then deletes it for everyone.
    await a("photos.archiveAlbum", { folderId: folder.id });
    await a("photos.folders");
    await a("photos.restoreAlbum", { folderId: folder.id });
    await a("photos.deleteAlbum", { folderId: folder.id });
    const { deleted } = await eventually(
      () => c("photos.folders"),
      (r: any) => r.deleted.length === 1,
      "the delete notice on the asker",
    );
    await c("photos.dismissAlbumNotice", { folderId: deleted[0].id });

    // Every result the web reads was exercised, except the legacy direct enroll.
    const untested = Object.keys(photoResultSchemas).filter((n) => !captured[n]);
    expect(untested).toEqual(["photos.enroll"]);

    const pushes = [...admin.changes, ...joiner.changes];
    expect(pushes.length).toBeGreaterThan(0);
    for (const p of pushes) expect(checkPhotoChanged(p), JSON.stringify(p)).toBeNull();

    const fresh = canonicalise({ results: captured, pushes }, new Map()) as {
      results: Captured;
      pushes: unknown[];
    };

    if (process.env.JUSTUS_UPDATE_FIXTURES) {
      // One push per distinct cause is enough for the web replay.
      const byCause = new Map<unknown, unknown>();
      for (const p of fresh.pushes) byCause.set((p as { cause: string }).cause, p);
      const out = { results: fresh.results, pushes: [...byCause.values()] };
      writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + "\n");
      return;
    }

    const have = shapeOf(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const missing = [...shapeOf(fresh)].filter((line) => !have.has(line));
    expect(
      missing,
      "backend output has fields the web fixture lacks: regenerate with JUSTUS_UPDATE_FIXTURES=1 and check the web consumers",
    ).toEqual([]);
  }, 90_000);
});
