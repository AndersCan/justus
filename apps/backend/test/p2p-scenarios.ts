/**
 * Every multi-device flow over a real swarm (#200), written once and run in
 * two runtimes: Node under vitest (`p2p-flows.integration.test.ts`) and the
 * Bare runtime with the real bare-* deps (`scripts/test-bare.mjs`). Sharing the
 * scenarios is what stops "works in Node, breaks in Bare" from drifting.
 *
 * Portable on purpose: no vitest, no `node:*` imports, so esbuild can bundle
 * it for Bare. A runtime supplies a {@link Net} (how peers are built) and a
 * {@link Check} (how assertions fail).
 */
import type { PhotoStore, PhotoStoreDeps } from "../src/photo-store.ts";
import type { P2pEvent } from "../src/p2p-log.ts";
import type { DriveStore } from "../src/ports/drive-store.ts";
import { PEER_PROTOCOL } from "../src/versions.ts";

export type PhotoChanged = Parameters<PhotoStoreDeps["onChanged"]>[0];
export type SyncStatus = Awaited<ReturnType<PhotoStore["status"]>>;

export type Peer = {
  name: string;
  storageDir: string;
  store: PhotoStore;
  /** The device's drive store, for writes the app itself would never make. */
  drives: DriveStore;
  changes: PhotoChanged[];
  /** Every structured p2p event this device logged (`src/p2p-log.ts`). */
  events: P2pEvent[];
  /** Closes the store, keeping its storage (a device going offline). */
  stop(): Promise<void>;
};

export type Net = {
  bootstrap: unknown[];
  /** Boots a device; pass `storageDir` of a stopped peer to restart it. */
  peer(
    name: string,
    storageDir?: string,
    opts?: {
      peerProtocol?: number;
      legacy?: boolean;
      /** Identities this device saved as friends; read on every call, so a list may grow after boot. */
      friends?: string[];
      offerReachMs?: number;
    },
  ): Promise<Peer>;
  destroy(): Promise<void>;
};

/** Minimal assertions: each throws on failure. */
export type Check = {
  ok(cond: unknown, what: string): void;
  /** Deep equality by JSON shape. */
  eq(actual: unknown, expected: unknown, what: string): void;
  /** Asserts a `[error, value]` result carries no error. */
  noErr(result: readonly unknown[], what: string): void;
};

export function makeCheck(): Check {
  const fail = (m: string): never => {
    throw new Error(`assertion failed: ${m}`);
  };
  return {
    ok: (cond, what) => {
      if (!cond) fail(what);
    },
    eq: (actual, expected, what) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) fail(`${what}: expected ${e}, got ${a}`);
    },
    noErr: (result, what) => {
      if (result[0]) fail(`${what}: ${String((result[0] as Error).message ?? result[0])}`);
    },
  };
}

/** Polls `probe` until `ok`, failing with the last value seen. */
export async function eventually<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  what: string,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (ok(v)) return v;
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const albumIn = async (store: PhotoStore, shareKey: string) =>
  (await store.folders()).folders.find((f) => f.shareKey === shareKey);

/** Admin creates an album with one photo; joiner joins and is approved,
 * all over the real swarm. */
export async function sharedAlbum(net: Net, adminName = "Phone", joinerName = "Desktop") {
  const admin = await net.peer(adminName);
  const joiner = await net.peer(joinerName);
  const created = await admin.store.createFolder("Shared");
  if (created[0]) throw created[0];
  const { id: folderId, shareKey } = created[1].folder;
  const setA = await admin.store.setActive(folderId);
  if (setA[0]) throw setA[0];
  const added = await admin.store.addBytes("a.jpg", new Uint8Array([211, 2, 3]));
  if (added[0]) throw added[0];
  const joined = await joiner.store.join(shareKey, "Shared");
  if (joined[0]) throw joined[0];
  const { requests } = await eventually(
    () => admin.store.requests(),
    (r) => r.requests.length === 1,
    "the join request on the Admin",
  );
  const responded = await admin.store.respond(folderId, requests[0].requesterKey, true);
  if (responded[0]) throw responded[0];
  const album = await eventually(
    () => albumIn(joiner.store, shareKey),
    (f) => f?.role === "member" && !f.pending,
    "the joiner's upgrade to member",
  );
  return { admin, joiner, folderId, shareKey, joinerFolderId: album!.id };
}

type Member = SyncStatus["members"][number];

export type Scenario = {
  name: string;
  run(net: Net, t: Check): Promise<void>;
};

export const scenarios: Scenario[] = [
  {
    name: "a Member's photo reaches the Admin",
    async run(net, t) {
      const { admin, joiner, joinerFolderId } = await sharedAlbum(net);
      t.noErr(
        await joiner.store.addBytes("b.jpg", new Uint8Array([9, 9, 9]), joinerFolderId),
        "add",
      );
      const seen = await eventually(
        () => admin.store.list(),
        (l) => l.some((p) => p.name === "b.jpg"),
        "the Member's photo on the Admin",
      );
      t.eq(
        seen.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
        ["a.jpg", "b.jpg"],
        "Admin's photos",
      );
      // Sizes come from the real Hyperdrive entry shape, on both sides.
      t.eq(
        seen.find((p) => p.name === "b.jpg")?.size,
        3,
        "the Member's photo size as listed on the Admin",
      );
      t.ok(
        admin.changes.some((c) => c.cause === "add"),
        "Admin was pushed an add",
      );

      // The same flow must be diagnosable from logs alone (#200): a connection,
      // the identity exchange and the drive change each left an event.
      const opened = admin.events.find((e) => e.event === "conn.open");
      t.ok(typeof opened?.fields.conn === "number", "conn.open event with a conn id");
      const identity = admin.events.find(
        (e) => e.event === "identity.learned" && e.fields.new === true,
      );
      t.ok(typeof identity?.fields.conn === "number", "identity.learned names its conn");
      t.ok(
        /^[0-9a-f]{8}$/.test(String(identity?.fields.identity)),
        "identity.learned carries a short identity key",
      );
      t.ok(
        admin.events.some((e) => e.event === "drive.change" && Number(e.fields.length) > 0),
        "drive.change event with a length",
      );
      t.ok(
        admin.events.some((e) => e.event === "drive.open.ready"),
        "drive.open.ready event",
      );
      // The state dump names the live connection and its learned identity.
      const dump = admin.store.debugState() as {
        connections: { conn: number; identityKey: string | null }[];
      };
      t.ok(
        dump.connections.some((c) => c.identityKey !== null),
        "debugState lists a connection with its identity",
      );
    },
  },
  {
    name: "a photo the Admin adds after the join reaches the Member",
    async run(net, t) {
      const { admin, joiner } = await sharedAlbum(net);
      t.noErr(await admin.store.addBytes("c.jpg", new Uint8Array([7, 7])), "add");
      await eventually(
        () => joiner.store.list(),
        (l) => l.some((p) => p.name === "c.jpg"),
        "the Admin's new photo on the Member",
      );
    },
  },
  {
    name: "a removal on the Admin reaches the Member",
    async run(net, t) {
      const { admin, joiner } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list(),
        (l) => l.length === 1,
        "the Admin's photo on the Member",
      );
      const [photo] = await admin.store.list();
      t.noErr(await admin.store.remove(photo.id), "remove");
      await eventually(
        () => joiner.store.list(),
        (l) => l.length === 0,
        "the removal on the Member",
      );
      // A replicated change is pushed as a refresh; the web layer reloads on
      // any cause but "presence" (handle-message.ts), so the cause is not "remove".
      t.ok(
        joiner.changes.some((c) => c.cause !== "presence"),
        "Member was pushed a refresh",
      );
    },
  },
  {
    name: "presence: each side sees the other connected, then not once it leaves",
    async run(net, t) {
      const { admin, joiner, joinerFolderId } = await sharedAlbum(net);
      t.noErr(await joiner.store.setActive(joinerFolderId), "setActive");
      const other = (s: SyncStatus, self: string) => s.members.find((m: Member) => m.key !== self);
      await eventually(
        () => admin.store.status(),
        (s) => other(s, s.driveKey)?.connected === true,
        "the Member shown connected on the Admin",
      );
      await eventually(
        () => joiner.store.status(),
        (s) => other(s, s.driveKey)?.connected === true,
        "the Admin shown connected on the Member",
      );
      await joiner.stop();
      const after = await eventually(
        () => admin.store.status(),
        (s) => other(s, s.driveKey)?.connected === false,
        "the Member shown offline on the Admin",
      );
      t.ok(typeof other(after, after.driveKey)?.lastSeenAt === "number", "lastSeenAt is a number");
    },
  },
  {
    name: "restart: a Member comes back with its album, role and photos, and keeps syncing",
    async run(net, t) {
      const { admin, joiner, shareKey } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.length === 1,
        "first sync",
      );
      await joiner.stop();

      const again = await net.peer("Desktop", joiner.storageDir);
      const album = await albumIn(again.store, shareKey);
      t.eq(album?.role, "member", "role after restart");
      t.ok(!album?.pending, "not pending after restart");
      t.eq(album?.name, "Shared", "name after restart");
      t.eq(
        (await again.store.list({ all: true })).map((p) => p.name),
        ["a.jpg"],
        "photos after restart",
      );

      t.noErr(await admin.store.addBytes("d.jpg", new Uint8Array([4, 4])), "add");
      await eventually(
        () => again.store.list({ all: true }),
        (l) => l.some((p) => p.name === "d.jpg"),
        "a photo added while restarting reaches the restarted Member",
      );
    },
  },
  {
    name: "identity: a member carries the other device's identity key, the same in two albums",
    async run(net, t) {
      const { admin, joiner, folderId, joinerFolderId } = await sharedAlbum(net);
      const idOf = (p: Peer) => (p.store.debugState() as { identityDrive: string }).identityDrive;
      const other = (s: SyncStatus) => s.members.find((m: Member) => m.key !== s.driveKey);
      const self = (s: SyncStatus) => s.members.find((m: Member) => m.key === s.driveKey);

      const second = await admin.store.createFolder("Second");
      t.noErr(second, "createFolder");
      const { id: secondId, shareKey: secondKey } = second[1]!.folder;
      t.noErr(await joiner.store.join(secondKey, "Second"), "join second");
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.some((q) => q.shareKey === secondKey),
        "the second join request on the Admin",
      );
      const request = requests.find((q) => q.shareKey === secondKey)!;
      t.noErr(await admin.store.respond(secondId, request.requesterKey, true), "respond");
      const upgraded = await eventually(
        () => albumIn(joiner.store, secondKey),
        (f) => f?.role === "member" && !f.pending,
        "the joiner's upgrade to member of the second album",
      );

      for (const [folder, joinerFolder] of [
        [folderId, joinerFolderId],
        [secondId, upgraded!.id],
      ]) {
        t.noErr(await admin.store.setActive(folder), "admin setActive");
        t.noErr(await joiner.store.setActive(joinerFolder), "joiner setActive");
        await eventually(
          () => admin.store.status(),
          (s) => other(s)?.identity === idOf(joiner),
          "the joiner's identity on the Admin",
        );
        await eventually(
          () => joiner.store.status(),
          (s) => other(s)?.identity === idOf(admin),
          "the Admin's identity on the joiner",
        );
        t.eq((await admin.store.status()).members.length, 2, "two members");
        t.eq(self(await admin.store.status())?.identity, idOf(admin), "Admin self identity");
        t.eq(self(await joiner.store.status())?.identity, idOf(joiner), "joiner self identity");
      }
    },
  },
  {
    name: "restart: presence follows a peer whose connection key changed",
    async run(net) {
      const { admin, joiner } = await sharedAlbum(net);
      const other = (s: SyncStatus) => s.members.find((m: Member) => m.key !== s.driveKey);
      await eventually(
        () => admin.store.status(),
        (s) => other(s)?.connected === true,
        "online",
      );
      await joiner.stop();
      await eventually(
        () => admin.store.status(),
        (s) => other(s)?.connected === false,
        "offline",
      );
      await net.peer("Desktop", joiner.storageDir);
      await eventually(
        () => admin.store.status(),
        (s) => other(s)?.connected === true,
        "the restarted Member shown connected again",
      );
    },
  },
  {
    name: "restart: the Admin comes back and still serves its album",
    async run(net, t) {
      const { admin, joiner, folderId } = await sharedAlbum(net);
      await admin.stop();
      const again = await net.peer("Phone", admin.storageDir);
      t.noErr(await again.store.setActive(folderId), "setActive");
      t.noErr(await again.store.addBytes("e.jpg", new Uint8Array([5])), "add");
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.some((p) => p.name === "e.jpg"),
        "a photo from the restarted Admin on the Member",
      );
    },
  },
  {
    name: "a declined request leaves the joiner a pending reader and clears the inbox",
    async run(net, t) {
      const admin = await net.peer("Phone");
      const joiner = await net.peer("Desktop");
      const created = await admin.store.createFolder("Private");
      t.noErr(created, "createFolder");
      const { id: folderId, shareKey } = created[1]!.folder;
      t.noErr(await joiner.store.join(shareKey), "join");
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the join request",
      );
      t.noErr(await admin.store.respond(folderId, requests[0].requesterKey, false), "respond");
      t.eq((await admin.store.requests()).requests, [], "inbox cleared");
      // Nothing upgrades the joiner: give replication a moment to prove it.
      await new Promise((r) => setTimeout(r, 1500));
      const album = await albumIn(joiner.store, shareKey);
      t.ok(album?.role !== "member", "declined joiner is not a member");
    },
  },
  {
    name: "ask: a stranger gets no key until the Admin accepts, then sees the photo",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey, invite, adminIdentity } = await askedAlbum(net);
      // Nothing the joiner can show holds the album's key.
      const before = JSON.stringify([
        joiner.store.debugState(),
        await joiner.store.folders(),
        await joiner.store.list({ all: true }),
      ]);
      t.ok(!before.includes(shareKey), "no share key on the joiner before the accept");
      t.eq((await joiner.store.folders()).folders, [], "no album yet");
      t.eq(
        (await joiner.store.folders()).asks.map((a) => a.status),
        ["waiting"],
        "one ask",
      );
      t.eq(invite.owner, adminIdentity, "the link names the Admin's identity drive");

      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      t.noErr(await admin.store.respond(folderId, requests[0].requesterKey, true), "accept");
      const album = await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "member" && !f.pending,
        "the joiner becomes a member",
      );
      t.eq(album?.invite?.code, invite.code, "the album remembers the code it came through");
      t.eq((await joiner.store.folders()).asks, [], "the ask is gone");
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.some((p) => p.name === "a.jpg"),
        "the Admin's photo on the joiner",
      );
      t.ok(
        joiner.changes.some((c) => c.cause === "ask" && c.answer === "accepted"),
        "joiner was told the ask was accepted",
      );
    },
  },
  {
    name: "viewer: accepted as a Viewer, sees the Admin's photo, and a photo in their own drive never reaches the Admin",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey, invite } = await askedAlbum(net);
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      t.eq(requests[0].viaInvite, true, "the ask came through the invite link");
      t.noErr(
        await admin.store.respond(folderId, requests[0].requesterKey, true, "reader"),
        "accept as a Viewer",
      );
      const album = await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "reader" && !f.pending && f.members === 2,
        "the joiner is a Viewer",
      );
      t.eq(album?.role, "reader", "a Viewer, not a Collaborator");
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.some((p) => p.name === "a.jpg"),
        "the Admin's photo on the Viewer",
      );
      const refused = await joiner.store.addBytes("v.jpg", new Uint8Array([7, 7, 7]), album!.id);
      t.ok(refused[0], "a Viewer cannot add a photo");

      const status = await eventually(
        () => admin.store.status(),
        (s) => s.members.some((m: Member) => m.viewer),
        "the Viewer on the Admin's list",
      );
      t.eq(
        status.members.map((m: Member) => Boolean(m.viewer)),
        [false, true],
        "Admin, then the Viewer",
      );
      t.eq((await admin.store.folders()).folders[0].members, 2, "the Admin counts the Viewer");
      await eventually(
        () => admin.store.status(),
        (s) => s.members.some((m: Member) => m.viewer && m.connected),
        "the Viewer connected on the Admin's phone",
      );

      // A modified app can still put a file in its own drive. Nobody reads it.
      const own = await joiner.drives.openOwn(`ask/${invite.code}`);
      await own.put("/photos/forged.jpg", new Uint8Array([6, 6, 6]), {
        metadata: { addedAt: Date.now(), name: "forged.jpg", mime: "image/jpeg" },
      });
      await new Promise((r) => setTimeout(r, 1500));
      const seen = await admin.store.list({ all: true });
      t.eq(
        seen.map((p) => p.name),
        ["a.jpg"],
        "the Viewer's file never shows on the Admin",
      );
    },
  },
  {
    name: "viewer: made a Collaborator, adds a photo the Admin sees, without a restart",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey } = await askedAlbum(net);
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      const key = requests[0].requesterKey;
      t.noErr(await admin.store.respond(folderId, key, true, "reader"), "accept as a Viewer");
      const album = await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "reader" && !f.pending,
        "the joiner is a Viewer",
      );
      t.noErr(await admin.store.makeMember(folderId, key), "let the Viewer add photos");
      await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "member",
        "the joiner's album becomes a Collaborator's",
      );
      await eventually(
        async () => joiner.store.addBytes("c.jpg", new Uint8Array([4, 4, 4]), album!.id),
        (r) => r[0] === null,
        "the Collaborator adds a photo",
      );
      await eventually(
        () => admin.store.list({ all: true }),
        (l) => l.some((p) => p.name === "c.jpg"),
        "the Admin sees the photo",
      );
      const status = await admin.store.status();
      t.ok(!status.members.some((m: Member) => m.viewer), "no Viewer left on the Admin's list");
    },
  },
  {
    name: "ask: after a No the joiner asks again, across a restart, and a yes lets them in",
    async run(net, t) {
      const { admin, joiner, folderId, invite } = await askedAlbum(net);
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      t.noErr(await admin.store.respond(folderId, requests[0].requesterKey, false), "decline");
      const declined = await eventually(
        () => joiner.store.folders(),
        (f) => f.asks[0]?.status === "declined",
        "the joiner hears no",
      );
      t.eq(declined.folders, [], "still no album");
      t.eq((await admin.store.requests()).requests, [], "the inbox is clear");

      await joiner.stop();
      const again = await net.peer("Desktop", joiner.storageDir);
      t.eq(
        (await again.store.folders()).asks.map((a) => a.status),
        ["declined"],
        "kept",
      );
      const second = await again.store.ask({ code: invite.code, owner: invite.owner });
      t.noErr(second, "ask again");
      t.eq(second[1]?.ask.status, "waiting", "asking again files a new ask");
      const [fresh] = (
        await eventually(
          () => admin.store.requests(),
          (r) => r.requests.length === 1,
          "the new ask on the Admin",
        )
      ).requests;
      await new Promise((r) => setTimeout(r, 1500));
      t.eq(
        (await again.store.folders()).asks.map((a) => a.status),
        ["waiting"],
        "the stale No did not land",
      );
      t.noErr(await admin.store.respond(folderId, fresh.requesterKey, true), "accept");
      const joined = await eventually(
        () => again.store.folders(),
        (f) => f.folders.length === 1,
        "the joiner is in",
      );
      t.ok(!joined.folders[0].pending, "not pending");
    },
  },
  {
    name: "friend: an invite after a No is a new ask and lets the friend in (#349)",
    async run(net, t) {
      const { admin, joiner, folderId } = await askedAlbum(net);
      const joinerIdentity = (joiner.store.debugState() as { identityDrive: string }).identityDrive;
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      t.noErr(await admin.store.respond(folderId, requests[0].requesterKey, false), "decline");
      await eventually(
        () => joiner.store.folders(),
        (f) => f.asks[0]?.status === "declined",
        "the joiner hears no",
      );
      t.noErr(await admin.store.offerAlbum(folderId, joinerIdentity), "offerAlbum");
      const { offers } = await eventually(
        () => joiner.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the joiner",
      );
      const taken = await joiner.store.joinOffer(offers[0].code, offers[0].owner);
      t.noErr(taken, "joinOffer");
      t.eq(taken[1]?.ask.status, "waiting", "the invite files a new ask");
      const joined = await eventually(
        () => joiner.store.folders(),
        (f) => f.folders.length === 1,
        "the joiner is in the album",
      );
      t.eq(joined.asks, [], "no ask left");
    },
  },
  {
    name: "ask: the Admin was offline, comes back, accepts, and the joiner gets the photo",
    async run(net, t) {
      const admin = await net.peer("Phone");
      const created = await admin.store.createFolder("Lisbon");
      t.noErr(created, "createFolder");
      const { id: folderId, shareKey, invite } = created[1]!.folder;
      t.noErr(await admin.store.addBytes("a.jpg", new Uint8Array([211, 2, 3]), folderId), "add");
      const adminIdentity = (admin.store.debugState() as { identityDrive: string }).identityDrive;
      await admin.stop();

      const joiner = await net.peer("Desktop");
      t.noErr(
        await joiner.store.ask({
          code: invite!.code,
          owner: adminIdentity,
          albumName: "Lisbon",
          ownerName: "Phone",
        }),
        "ask while the Admin is offline",
      );
      const back = await net.peer("Phone", admin.storageDir);
      const { requests } = await eventually(
        () => back.store.requests(),
        (r) => r.requests.length === 1,
        "the ask reaches the restarted Admin",
        40_000,
      );
      t.noErr(await back.store.respond(folderId, requests[0].requesterKey, true), "accept");
      await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "member",
        "the joiner becomes a member",
        40_000,
      );
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.some((p) => p.name === "a.jpg"),
        "the photo on the joiner",
      );
    },
  },
  {
    name: "V1: peers on another version refuse each other and say who must update",
    async run(net, t) {
      // A phone from before the version channel: it greets, but sends no version.
      const behind = await net.peer("Behind", undefined, { legacy: true });
      const current = await net.peer("Current");
      const created = await behind.store.createFolder("Shared");
      if (created[0]) throw created[0];
      const { id: folderId, shareKey } = created[1].folder;
      t.noErr(await behind.store.addBytes("a.jpg", new Uint8Array([211, 2, 3]), folderId), "add");
      current.store.join(shareKey, "Shared").catch(() => {});
      const ahead = await eventually(
        () => current.store.status(),
        (st) => st.peersBehind.length > 0,
        "peersBehind on the current peer",
      );
      t.eq(ahead.peersBehind, ["Behind"], "the current peer names the older one");
      t.ok(
        current.changes.some((c) => c.cause === "version"),
        "the current peer was pushed a version change",
      );
    },
  },
  {
    name: "V1b: a peer on a newer version is refused and flagged",
    async run(net, t) {
      const ahead = await net.peer("Ahead", undefined, { peerProtocol: PEER_PROTOCOL + 1 });
      const current = await net.peer("Current");
      const created = await ahead.store.createFolder("Shared");
      if (created[0]) throw created[0];
      t.noErr(
        await ahead.store.addBytes("a.jpg", new Uint8Array([211, 2, 3]), created[1].folder.id),
        "add",
      );
      current.store.join(created[1].folder.shareKey, "Shared").catch(() => {});
      const status = await eventually(
        () => current.store.status(),
        (st) => st.updateNeeded,
        "updateNeeded on the current peer",
      );
      t.ok(status.updateNeeded, "the current peer is told to update");
      await new Promise((r) => setTimeout(r, 3_000));
      t.eq((await current.store.list({ all: true })).length, 0, "the photo never reaches it");
    },
  },
  {
    name: "friend: an Admin reaches a friend by key alone, with no shared album",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      t.noErr(await admin.store.offerAlbum(folderId, friendIdentity), "offerAlbum");
      const { offers } = await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the friend",
      );
      t.eq(offers[0].albumName, "Lisbon", "the invite names the album");
      t.eq(offers[0].ownerName, "Phone", "the invite names the Admin");
      const adminState = admin.store.debugState() as { folders: { invited: string[] }[] };
      t.eq(adminState.folders[0].invited, [friendIdentity], "the Admin records who was invited");
      t.ok(
        friend.changes.some((c) => c.cause === "offer"),
        "the friend was pushed an offer",
      );
      t.ok(
        !JSON.stringify(await friend.store.folders()).includes(
          (await admin.store.folders()).folders[0].shareKey,
        ),
        "the invite carries no album key",
      );
    },
  },
  {
    name: "friend: the Admin takes back an invite and it leaves the friend's phone",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      t.noErr(await admin.store.offerAlbum(folderId, friendIdentity), "offerAlbum");
      const { offers } = await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the friend",
      );
      const before = await admin.store.folders();
      t.eq(
        before.folders[0].invitedFriends,
        [{ identity: friendIdentity, role: "member" }],
        "the Admin lists the invited friend",
      );
      t.noErr(await admin.store.takeBackOffer(folderId, friendIdentity), "takeBackOffer");
      const after = await admin.store.folders();
      t.eq(after.folders[0].invitedFriends, undefined, "the list is empty");
      await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 0,
        "the invite leaves the friend",
      );
      const [error] = await friend.store.joinOffer(offers[0].code, offers[0].owner);
      t.ok(error?.code === "justus.photos/offer-gone", "Join is OFFER_GONE");
      t.eq(after.folders[0].members, before.folders[0].members, "nobody joined");
    },
  },
  {
    name: "friend: a second invite for the same friend and album is turned away while one waits",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      const first = admin.store.offerAlbum(folderId, friendIdentity);
      const [error] = await admin.store.offerAlbum(folderId, friendIdentity);
      t.ok(error?.code === "justus.photos/offer-pending", "OFFER_PENDING");
      t.noErr(await first, "the first invite still completes");
      await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "one invite on the friend",
      );
    },
  },
  {
    name: "friend: a phone that doesn't know the Admin turns the invite down",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, false);
      const [error] = await admin.store.offerAlbum(folderId, friendIdentity);
      t.ok(error?.code === "justus.photos/friend-refused", "FRIEND_REFUSED");
      t.eq((await friend.store.folders()).offers, [], "the friend holds nothing");
    },
  },
  {
    name: "friend: an invite to a phone that is off waits and arrives when it is back",
    async run(net, t) {
      const friends: string[] = [];
      const admin = await net.peer("Phone", undefined, { offerReachMs: 3000 });
      const away = await net.peer("Kari", undefined, { friends });
      const idOf = (p: Peer) => (p.store.debugState() as { identityDrive: string }).identityDrive;
      const friendIdentity = idOf(away);
      friends.push(idOf(admin));
      await away.stop();
      const created = await admin.store.createFolder("Lisbon");
      if (created[0]) throw created[0];
      const folderId = created[1].folder.id;
      const [error, result] = await admin.store.offerAlbum(folderId, friendIdentity);
      if (error) throw error;
      t.eq(result, { ok: true, waiting: true }, "the invite waits");
      t.eq((await admin.store.folders()).folders[0].waitingFor, [friendIdentity], "waitingFor");
      const waiting = admin.store.debugState() as {
        folders: { invited: string[]; offerOwed: Record<string, number> }[];
      };
      t.eq(waiting.folders[0].invited, [], "not invited yet");
      t.eq(Object.keys(waiting.folders[0].offerOwed), [friendIdentity], "owed");
      const back = await net.peer("Kari", away.storageDir, { friends });
      const { offers } = await eventually(
        () => back.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the returned friend",
        60_000,
      );
      t.eq(offers[0].albumName, "Lisbon", "the invite names the album");
      await eventually(
        async () => (await admin.store.folders()).folders[0].waitingFor,
        (w) => w === undefined,
        "the waiting line to go away",
      );
      const done = admin.store.debugState() as {
        folders: { invited: string[]; offerOwed: Record<string, number> }[];
      };
      t.eq(done.folders[0].invited, [friendIdentity], "invited once it arrived");
      t.eq(done.folders[0].offerOwed, {}, "nothing owed");
      t.noErr(await back.store.joinOffer(offers[0].code, offers[0].owner), "joinOffer");
      await eventually(
        () => back.store.folders(),
        (f) => f.folders.length === 1 && !f.folders[0].pending,
        "the friend is in the album",
      );
    },
  },
  {
    name: "friend: the friend taps Join and is in the album, no Accept on the Admin",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      t.noErr(await admin.store.setActive(folderId), "setActive");
      const added = await admin.store.addBytes("a.jpg", new Uint8Array([1, 2, 3, 4]), folderId);
      if (added[0]) throw added[0];
      t.noErr(await admin.store.offerAlbum(folderId, friendIdentity), "offerAlbum");
      const { offers } = await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the friend",
      );
      t.noErr(await friend.store.joinOffer(offers[0].code, offers[0].owner), "joinOffer");
      let sawRequest = false;
      await eventually(
        async () => {
          if ((await admin.store.requests()).requests.length) sawRequest = true;
          return friend.store.folders();
        },
        (f) => f.folders.length === 1 && !f.folders[0].pending,
        "the friend is in the album",
      );
      t.ok(!sawRequest, "the Admin never saw a request to accept");
      t.eq((await admin.store.requests()).requests, [], "no request is left");
      await eventually(
        () => friend.store.list({ all: true }),
        (l) => l.length === 1,
        "the friend gets the photo",
      );
      const after = await friend.store.folders();
      t.eq(after.offers, [], "the invite is gone");
      t.eq(after.asks, [], "no ask is left");
    },
  },
  {
    name: "friend: a friend added as a Viewer joins as a Viewer",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      t.noErr(await admin.store.offerAlbum(folderId, friendIdentity, "reader"), "offerAlbum");
      const { offers } = await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the friend",
      );
      t.noErr(await friend.store.joinOffer(offers[0].code, offers[0].owner), "joinOffer");
      const joined = await eventually(
        async () => (await friend.store.folders()).folders[0],
        (f) => f?.role === "reader" && !f.pending,
        "the friend is a Viewer",
      );
      t.eq(joined.role, "reader", "a Viewer, not a Collaborator");
      const state = admin.store.debugState() as { folders: { invitedRoles: object }[] };
      t.eq(state.folders[0].invitedRoles, {}, "the saved role is used up");
    },
  },
  {
    name: "friend: a Join tapped while the Admin is off is finished when the Admin is back",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      t.noErr(await admin.store.offerAlbum(folderId, friendIdentity), "offerAlbum");
      const { offers } = await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the friend",
      );
      await admin.stop();
      t.noErr(await friend.store.joinOffer(offers[0].code, offers[0].owner), "joinOffer");
      await net.peer("Phone", admin.storageDir);
      await eventually(
        () => friend.store.folders(),
        (f) => f.folders.length === 1 && !f.folders[0].pending,
        "the friend is in the album",
      );
    },
  },
  {
    name: "friend: turning off links takes back open friend invites",
    async run(net, t) {
      const { admin, friend, folderId, friendIdentity } = await friendSetup(net, true);
      t.noErr(await admin.store.offerAlbum(folderId, friendIdentity), "offerAlbum");
      const { offers } = await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 1,
        "the invite on the friend",
      );
      t.noErr(await admin.store.turnOffInvite(folderId), "turnOffInvite");
      await eventually(
        () => friend.store.folders(),
        (f) => f.offers.length === 0,
        "the invite is taken back",
      );
      const [error] = await friend.store.joinOffer(offers[0].code, offers[0].owner);
      t.ok(error?.code === "justus.photos/offer-gone", "OFFER_GONE");
    },
  },
  {
    name: "delete: the Admin deletes an album and it leaves the Member's phone, photos and all",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey, joinerFolderId } = await sharedAlbum(net);
      t.noErr(
        await joiner.store.addBytes("b.jpg", new Uint8Array([9, 9, 9]), joinerFolderId),
        "joiner adds a photo",
      );
      await eventually(
        () => admin.store.list({ all: true }),
        (photos) => photos.length === 2,
        "the Member's photo on the Admin",
      );
      t.noErr(await admin.store.deleteAlbum(folderId), "deleteAlbum");
      const after = await eventually(
        () => joiner.store.folders(),
        (f) => f.deleted.length === 1,
        "the delete notice on the Member",
      );
      t.ok(!after.folders.some((f) => f.shareKey === shareKey), "album gone from the Member");
      t.eq(
        after.deleted.map((d) => ({ name: d.name, adminName: d.adminName })),
        [{ name: "Shared", adminName: "Phone" }],
        "the notice",
      );
      t.eq(await joiner.store.list({ all: true }), [], "the Member has no photos");
      const adminAlbums = await admin.store.folders();
      t.ok(
        ![...adminAlbums.folders, ...adminAlbums.archived].some((f) => f.shareKey === shareKey),
        "album gone from the Admin",
      );
      t.eq(adminAlbums.deleted, [], "the Admin has no notice");
      t.eq(await admin.store.list({ all: true }), [], "the Admin has no photos");
    },
  },
  {
    name: "delete: a Member who was offline loses the album when it comes back",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list({ all: true }),
        (photos) => photos.length === 1,
        "the first sync",
      );
      await joiner.stop();
      t.noErr(await admin.store.deleteAlbum(folderId), "deleteAlbum");
      const back = await net.peer("Desktop", joiner.storageDir);
      const after = await eventually(
        () => back.store.folders(),
        (f) => f.deleted.length === 1,
        "the delete notice after coming back",
      );
      t.ok(!after.folders.some((f) => f.shareKey === shareKey), "album gone after coming back");
      t.eq(await back.store.list({ all: true }), [], "no photos after coming back");
      await back.stop();
      const again = await net.peer("Desktop", joiner.storageDir);
      const restarted = await again.store.folders();
      t.eq(restarted.folders, [], "still gone after a restart");
      t.eq(restarted.deleted.length, 1, "the notice survives a restart");
      t.noErr(await again.store.dismissAlbumNotice(restarted.deleted[0].id), "dismiss");
      t.eq((await again.store.folders()).deleted, [], "the notice is dismissed");
    },
  },
  {
    name: "delete: a Member who was away hears it from another Member when the Admin's phone is gone",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey } = await sharedAlbum(net);
      const tablet = await net.peer("Tablet");
      t.noErr(await tablet.store.join(shareKey, "Shared"), "tablet join");
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the Tablet's join request on the Admin",
      );
      t.noErr(await admin.store.respond(folderId, requests[0].requesterKey, true), "accept");
      for (const [who, peer] of [
        ["Desktop", joiner],
        ["Tablet", tablet],
      ] as const) {
        await eventually(
          () => peer.store.list({ all: true }),
          (photos) => photos.length === 1,
          `the photo on ${who}`,
        );
      }
      await tablet.stop();
      t.noErr(await admin.store.deleteAlbum(folderId), "deleteAlbum");
      await eventually(
        () => joiner.store.folders(),
        (f) => f.deleted.length === 1,
        "the delete notice on Desktop",
      );
      await admin.stop();
      const back = await net.peer("Tablet", tablet.storageDir);
      const after = await eventually(
        () => back.store.folders(),
        (f) => f.deleted.length === 1,
        "the delete notice on the Tablet from Desktop",
        30_000,
      );
      t.eq(
        after.deleted.map((d) => ({ name: d.name, adminName: d.adminName })),
        [{ name: "Shared", adminName: "Phone" }],
        "the notice",
      );
      t.ok(!after.folders.some((f) => f.shareKey === shareKey), "album gone from the Tablet");
      t.eq(await back.store.list({ all: true }), [], "the Tablet has no photos");
    },
  },
  {
    name: "delete: only the Admin can delete, and an archived album is restored first",
    async run(net, t) {
      const { admin, joiner, folderId, joinerFolderId } = await sharedAlbum(net);
      const [notAdmin] = await joiner.store.deleteAlbum(joinerFolderId);
      t.ok(notAdmin?.code === "justus.photos/not-creator", "NOT_CREATOR");
      t.noErr(await admin.store.archiveAlbum(folderId), "archiveAlbum");
      const [archived] = await admin.store.deleteAlbum(folderId);
      t.ok(archived?.code === "justus.photos/album-archived", "ALBUM_ARCHIVED");
    },
  },
  {
    name: "leave: a Viewer leaves and drops off the Admin's people list",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey } = await askedAlbum(net);
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      const key = requests[0].requesterKey;
      t.noErr(await admin.store.respond(folderId, key, true, "reader"), "accept as a Viewer");
      const album = await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "reader" && !f.pending,
        "the joiner is a Viewer",
      );
      await eventually(
        () => admin.store.status(),
        (s) => s.members.some((m: Member) => m.viewer),
        "the Viewer on the Admin's list",
      );
      t.noErr(await joiner.store.leaveAlbum(album!.id), "leaveAlbum");
      await eventually(
        () => admin.store.status(),
        (s) => !s.members.some((m: Member) => m.viewer),
        "the Viewer off the Admin's list",
      );
      await eventually(
        async () => (joiner.store.debugState() as { gone: unknown[] }).gone,
        (gone) => gone.length === 0,
        "the Viewer's phone has nothing left to wait for",
      );
    },
  },
  {
    name: "leave: a Member leaves, drops off the Admin's people list, and needs a new ask to come back",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey, joinerFolderId } = await sharedAlbum(net);
      const joinerDrive = (await albumIn(joiner.store, shareKey))!.driveKey;
      t.noErr(
        await joiner.store.addBytes("b.jpg", new Uint8Array([9, 9, 9]), joinerFolderId),
        "joiner adds a photo",
      );
      await eventually(
        () => admin.store.list({ all: true }),
        (photos) => photos.length === 2,
        "the Member's photo on the Admin",
      );
      const purged: string[] = [];
      const released: string[] = [];
      const purge = joiner.drives.purge.bind(joiner.drives);
      const release = joiner.drives.release.bind(joiner.drives);
      joiner.drives.purge = (key) => (purged.push(key), purge(key));
      joiner.drives.release = (drive) => (released.push(drive.key), release(drive));
      t.noErr(await joiner.store.leaveAlbum(joinerFolderId), "leaveAlbum");
      const after = await joiner.store.folders();
      t.eq(
        [after.folders.length, after.archived.length, after.deleted.length],
        [0, 0, 0],
        "the album is gone from the Member",
      );
      await eventually(
        () => admin.store.status(),
        (st: SyncStatus) => !st.members.some((m: Member) => m.key === joinerDrive),
        "the Member off the Admin's people list",
      );
      await eventually(
        () => admin.store.list({ all: true }),
        (photos) => photos.length === 1,
        "the Member's photo off the Admin",
      );
      await eventually(
        async () => ((await joiner.store.debugState()) as { gone: unknown[] }).gone,
        (gone) => gone.length === 0,
        "the Member forgets the album",
      );
      t.eq(purged.length, 1, "the album's drive is purged on the Member");
      t.ok(purged[0] !== joinerDrive, "the purged drive is not the Member's own");
      t.ok(released.includes(joinerDrive), "the Member's own drive is released");
      const [cannot] = await admin.store.leaveAlbum(folderId);
      t.ok(cannot?.code === "justus.photos/admin-cannot-leave", "ADMIN_CANNOT_LEAVE");
    },
  },
  {
    name: "leave: after the Admin drops a Member, the old invite link starts a fresh ask the Admin can accept",
    async run(net, t) {
      const { admin, joiner, folderId, shareKey, invite, adminIdentity } = await askedAlbum(net);
      const first = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the ask on the Admin",
      );
      t.noErr(await admin.store.respond(folderId, first.requests[0].requesterKey, true), "accept");
      const album = await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "member" && !f.pending,
        "the joiner is a Member",
      );
      const answers = () =>
        (admin.store.debugState() as { folders: { answers?: Record<string, string> }[] }).folders[0]
          .answers ?? {};
      await eventually(
        async () => Object.values(answers()),
        (v) => v.length === 1 && v[0] === "accepted",
        "the Admin records the answer",
      );
      t.noErr(await joiner.store.leaveAlbum(album!.id), "leaveAlbum");
      await eventually(
        async () => Object.keys(answers()).length,
        (n) => n === 0,
        "the Admin takes back the answer",
      );
      t.noErr(
        await joiner.store.ask({ code: invite.code, owner: adminIdentity }),
        "the old link is used again",
      );
      const again = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "a fresh ask on the Admin",
      );
      t.eq(again.requests[0].viaInvite, true, "the fresh ask came through the old link");
      t.noErr(
        await admin.store.respond(folderId, again.requests[0].requesterKey, true),
        "accept again",
      );
      await eventually(
        () => albumIn(joiner.store, shareKey),
        (f) => f?.role === "member" && !f.pending,
        "the joiner is a Member again",
      );
      await eventually(
        () => joiner.store.list({ all: true }),
        (p) => p.length === 1,
        "the album's photo on the joiner",
      );
    },
  },
  {
    name: "leave: a Member who leaves while the Admin's phone is off is dropped when it comes back",
    async run(net, t) {
      const { admin, joiner, shareKey, joinerFolderId } = await sharedAlbum(net);
      const joinerDrive = (await albumIn(joiner.store, shareKey))!.driveKey;
      await eventually(
        () => joiner.store.list({ all: true }),
        (photos) => photos.length === 1,
        "the first sync",
      );
      const adminDir = admin.storageDir;
      await admin.stop();
      t.noErr(await joiner.store.leaveAlbum(joinerFolderId), "leaveAlbum");
      const waiting = (await joiner.store.debugState()) as { gone: Array<{ kind: string }> };
      t.eq(
        waiting.gone.map((g) => g.kind),
        ["waitingForAdminToSeeYouLeft"],
        "the Member waits for the Admin",
      );
      await joiner.stop();
      const joinerBack = await net.peer("Desktop", joiner.storageDir);
      const stillWaiting = (await joinerBack.store.debugState()) as {
        gone: Array<{ kind: string }>;
      };
      t.eq(
        stillWaiting.gone.map((g) => g.kind),
        ["waitingForAdminToSeeYouLeft"],
        "the waiting survives a restart",
      );
      const adminBack = await net.peer("Phone", adminDir);
      await eventually(
        () => adminBack.store.status(),
        (st: SyncStatus) => !st.members.some((m: Member) => m.key === joinerDrive),
        "the Member dropped once the Admin is back",
      );
      await eventually(
        async () => ((await joinerBack.store.debugState()) as { gone: unknown[] }).gone,
        (gone) => gone.length === 0,
        "the Member forgets the album",
      );
    },
  },
  {
    name: "move: remove a Viewer and the rest follow the album to its new key",
    async run(net, t) {
      const admin = await net.peer("Phone");
      const nils = await net.peer("Nils");
      const vera = await net.peer("Vera");
      const ben = await net.peer("Ben");
      const created = await admin.store.createFolder("Trip");
      if (created[0]) throw created[0];
      const { id: folderId, shareKey, invite } = created[1].folder;
      const adminIdentity = (admin.store.debugState() as { identityDrive: string }).identityDrive;
      const keys: Record<string, string> = {};
      for (const [who, role] of [
        [nils, "member"],
        [vera, "reader"],
        [ben, "reader"],
      ] as const) {
        t.noErr(
          await who.store.ask({
            code: invite!.code,
            owner: adminIdentity,
            albumName: "Trip",
            ownerName: "Phone",
          }),
          `${who.name} asks`,
        );
        const { requests } = await eventually(
          () => admin.store.requests(),
          (r) => r.requests.length === 1,
          `${who.name}'s ask on the Admin`,
        );
        keys[who.name] = requests[0].requesterKey;
        t.noErr(
          await admin.store.respond(folderId, keys[who.name], true, role),
          `accept ${who.name}`,
        );
        await eventually(
          () => albumIn(who.store, shareKey),
          (f) => f?.role === role && !f.pending,
          `${who.name} joined`,
        );
      }
      const photosOf = async (p: Peer, id: string) =>
        (await p.store.list({ all: true })).filter((x) => x.folderId === id);
      const idIn = async (p: Peer) => (await albumIn(p.store, shareKey))!.id;
      const nilsId = await idIn(nils);
      const veraId = await idIn(vera);
      const benId = await idIn(ben);
      t.noErr(await nils.store.addBytes("old.jpg", new Uint8Array([7, 7, 7]), nilsId), "old photo");
      await eventually(
        () => photosOf(admin, folderId),
        (l) => l.some((p) => p.name === "old.jpg"),
        "the old photo on the Admin",
      );
      await eventually(
        () => photosOf(ben, benId),
        (l) => l.some((p) => p.name === "old.jpg"),
        "the old photo on Ben's phone",
      );

      t.noErr(await admin.store.removeMember(folderId, keys.Ben), "remove Ben");
      const moved = (await admin.store.folders()).folders.find((f) => f.id === folderId)!;
      t.ok(moved.shareKey !== shareKey, "the album has a new key");
      for (const [who, id] of [
        [nils, nilsId],
        [vera, veraId],
      ] as const) {
        await eventually(
          async () => (await who.store.folders()).folders.find((f) => f.id === id),
          (f) => f?.shareKey === moved.shareKey,
          `${who.name} followed to the new key`,
          60_000,
        );
      }

      t.noErr(
        await admin.store.addBytes("from-admin.jpg", new Uint8Array([1, 1, 1]), folderId),
        "admin adds",
      );
      const nilsNew = await eventually(
        async () => (await nils.store.folders()).folders.find((f) => f.id === nilsId),
        (f) => f?.role === "member" && !f.pending,
        "Nils is a Collaborator on the new key",
        60_000,
      );
      t.noErr(
        await nils.store.addBytes("from-nils.jpg", new Uint8Array([2, 2, 2]), nilsNew!.id),
        "Nils adds",
      );
      const names = async (p: Peer, id: string) =>
        (await photosOf(p, id)).map((x) => x.name).sort((a, b) => a.localeCompare(b));
      const all = ["from-admin.jpg", "from-nils.jpg", "old.jpg"];
      await eventually(
        () => names(vera, veraId),
        (n) => JSON.stringify(n) === JSON.stringify(all),
        "Vera sees everything once",
        60_000,
      );
      await eventually(
        () => names(admin, folderId),
        (n) => JSON.stringify(n) === JSON.stringify(all),
        "the Admin sees everything once",
        60_000,
      );
      await eventually(
        () => names(nils, nilsId),
        (n) => JSON.stringify(n) === JSON.stringify(all),
        "Nils sees everything once",
        60_000,
      );

      await new Promise((r) => setTimeout(r, 5_000));
      const seenByBen = await names(ben, benId);
      t.ok(
        !seenByBen.includes("from-admin.jpg") && !seenByBen.includes("from-nils.jpg"),
        "Ben sees nothing added after Remove",
      );
      t.ok((await albumIn(ben.store, moved.shareKey)) === undefined, "Ben never holds the new key");
      const benAlbum = await eventually(
        () => albumIn(ben.store, shareKey),
        (f) => f?.notice?.kind === "removed" && f.role === "reader",
        "Ben hears he was removed",
        60_000,
      );
      t.ok(benAlbum?.id === benId, "Ben's removed album is the one he had");
      t.ok((await names(ben, benId)).includes("old.jpg"), "Ben still lists the old photo");

      const old = (await photosOf(nils, nilsId)).find((p) => p.name === "old.jpg")!;
      t.noErr(await nils.store.remove(old.id, nilsId), "Nils deletes the old photo");
      await eventually(
        () => names(nils, nilsId),
        (n) => !n.includes("old.jpg"),
        "the old photo is gone for Nils",
      );
    },
  },
  {
    name: "move: a Collaborator removed while away hears it when back",
    async run(net, t) {
      const admin = await net.peer("Phone");
      const vera = await net.peer("Vera");
      const nils = await net.peer("Nils");
      const created = await admin.store.createFolder("Trip");
      if (created[0]) throw created[0];
      const { id: folderId, shareKey, invite } = created[1].folder;
      const adminIdentity = (admin.store.debugState() as { identityDrive: string }).identityDrive;
      const keys: Record<string, string> = {};
      for (const [who, role] of [
        [vera, "reader"],
        [nils, "member"],
      ] as const) {
        t.noErr(
          await who.store.ask({
            code: invite!.code,
            owner: adminIdentity,
            albumName: "Trip",
            ownerName: "Phone",
          }),
          `${who.name} asks`,
        );
        const { requests } = await eventually(
          () => admin.store.requests(),
          (r) => r.requests.length === 1,
          `${who.name}'s ask on the Admin`,
        );
        keys[who.name] = requests[0].requesterKey;
        t.noErr(
          await admin.store.respond(folderId, keys[who.name], true, role),
          `accept ${who.name}`,
        );
        await eventually(
          () => albumIn(who.store, shareKey),
          (f) => f?.role === role && !f.pending,
          `${who.name} joined`,
        );
      }
      const nilsId = (await albumIn(nils.store, shareKey))!.id;
      const veraId = (await albumIn(vera.store, shareKey))!.id;
      t.noErr(
        await nils.store.addBytes("nils-old.jpg", new Uint8Array([4, 4, 4]), nilsId),
        "Nils adds",
      );
      await eventually(
        async () =>
          (await admin.store.list({ all: true })).filter(
            (x) => x.folderId === folderId && x.name === "nils-old.jpg",
          ),
        (l) => l.length > 0,
        "Nils's photo on the Admin",
      );
      await nils.stop();
      t.noErr(await admin.store.removeMember(folderId, keys.Nils), "remove Nils");
      const moved = (await admin.store.folders()).folders.find((f) => f.id === folderId)!;
      await eventually(
        async () => (await vera.store.folders()).folders.find((f) => f.id === veraId),
        (f) => f?.shareKey === moved.shareKey,
        "Vera followed to the new key",
        60_000,
      );
      await admin.stop();
      await net.peer("Phone", admin.storageDir);
      const back = await net.peer("Nils", nils.storageDir);
      const album = await eventually(
        () => albumIn(back.store, shareKey),
        (f) => f?.notice?.kind === "removed" && f.role === "reader",
        "Nils hears he was removed",
        60_000,
      );
      const listed = (await back.store.list({ all: true })).filter((x) => x.folderId === album!.id);
      t.ok(
        listed.some((x) => x.name === "nils-old.jpg"),
        "Nils still lists his photo",
      );
    },
  },
  {
    name: "remove: someone waiting through the invite link is still listed and gets in on Accept",
    async run(net, t) {
      const admin = await net.peer("Phone");
      const desktop = await net.peer("Desktop");
      const tablet = await net.peer("Tablet");
      const created = await admin.store.createFolder("Trip");
      if (created[0]) throw created[0];
      const { id: folderId, invite } = created[1].folder;
      const adminIdentity = (admin.store.debugState() as { identityDrive: string }).identityDrive;
      const askAs = (who: Peer) =>
        who.store.ask({
          code: invite!.code,
          owner: adminIdentity,
          albumName: "Trip",
          ownerName: "Phone",
        });

      t.noErr(await askAs(desktop), "Desktop asks");
      const first = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "Desktop's ask on the Admin",
      );
      const desktopKey = first.requests[0].requesterKey;
      t.noErr(await admin.store.respond(folderId, desktopKey, true, "member"), "accept Desktop");
      await eventually(
        async () => (await desktop.store.folders()).folders.find((f) => !f.pending),
        (f) => f?.role === "member",
        "Desktop is a Collaborator",
      );

      t.noErr(await askAs(tablet), "Tablet asks");
      const waiting = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "Tablet's ask on the Admin",
      );
      const tabletKey = waiting.requests[0].requesterKey;

      t.noErr(await admin.store.removeMember(folderId, desktopKey), "remove Desktop");
      const moved = (await admin.store.folders()).folders.find((f) => f.id === folderId)!;
      await eventually(
        () => admin.store.requests(),
        (r) => r.requests.some((x) => x.requesterKey === tabletKey),
        "Tablet is still listed after the Remove",
        60_000,
      );

      t.noErr(await admin.store.respond(folderId, tabletKey, true, "reader"), "accept Tablet");
      const album = await eventually(
        async () =>
          (await tablet.store.folders()).folders.find((f) => f.shareKey === moved.shareKey),
        (f) => f?.role === "reader" && !f.pending,
        "Tablet is a Viewer on the new key",
        60_000,
      );
      t.ok(album?.role === "reader", "Tablet got the role the Admin picked");
    },
  },
];

/** An Admin with a one-photo album, and a joiner that has asked through its invite code. */
async function askedAlbum(net: Net) {
  const admin = await net.peer("Phone");
  const joiner = await net.peer("Desktop");
  const created = await admin.store.createFolder("Lisbon");
  if (created[0]) throw created[0];
  const { id: folderId, shareKey, invite } = created[1].folder;
  if (!invite) throw new Error("the creator's album has no invite code");
  const added = await admin.store.addBytes("a.jpg", new Uint8Array([211, 2, 3]), folderId);
  if (added[0]) throw added[0];
  const adminIdentity = (admin.store.debugState() as { identityDrive: string }).identityDrive;
  const asked = await joiner.store.ask({
    code: invite.code,
    owner: adminIdentity,
    albumName: "Lisbon",
    ownerName: "Phone",
  });
  if (asked[0]) throw asked[0];
  return { admin, joiner, folderId, shareKey, invite, adminIdentity };
}

/** An Admin (Phone) with an album and a friend's phone (Kari) that shares no album with it. */
async function friendSetup(net: Net, friendKnowsAdmin: boolean) {
  const friends: string[] = [];
  const admin = await net.peer("Phone");
  const friend = await net.peer("Kari", undefined, { friends });
  const idOf = (p: Peer) => (p.store.debugState() as { identityDrive: string }).identityDrive;
  if (friendKnowsAdmin) friends.push(idOf(admin));
  const created = await admin.store.createFolder("Lisbon");
  if (created[0]) throw created[0];
  return { admin, friend, folderId: created[1].folder.id, friendIdentity: idOf(friend) };
}
