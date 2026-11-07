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
    name: "ask: a declined ask stays declined, across a restart and a second ask",
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
      t.eq(second[1]?.ask.status, "declined", "asking again returns declined");
      await new Promise((r) => setTimeout(r, 1500));
      t.eq((await admin.store.requests()).requests, [], "the Admin is not asked again");
      t.eq((await again.store.folders()).folders, [], "never got the album");
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
      const ahead = await net.peer("Ahead", undefined, { peerProtocol: 4 });
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
    name: "friend: an invite to a phone that is off fails and leaves nothing",
    async run(net, t) {
      const admin = await net.peer("Phone", undefined, { offerReachMs: 3000 });
      const away = await net.peer("Kari");
      const friendIdentity = (away.store.debugState() as { identityDrive: string }).identityDrive;
      await away.stop();
      const created = await admin.store.createFolder("Lisbon");
      if (created[0]) throw created[0];
      const folderId = created[1].folder.id;
      const [error] = await admin.store.offerAlbum(folderId, friendIdentity);
      t.ok(error?.code === "justus.photos/friend-unreachable", "FRIEND_UNREACHABLE");
      const folder = admin.store.debugState() as { folders: { invited: string[] }[] };
      t.eq(folder.folders[0].invited, [], "nothing was written");
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
