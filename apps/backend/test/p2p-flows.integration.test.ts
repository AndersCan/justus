/**
 * Every multi-device flow over a real swarm (#200). Each case starts from an
 * approved two-device album (`sharedAlbum`) and checks one flow end to end,
 * against the real libraries rather than our model of them.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  albumIn,
  eventually,
  realNet,
  sharedAlbum,
  type Net,
  type SyncStatus,
} from "./real-peers.ts";

type Member = SyncStatus["members"][number];

let net: Net | undefined;
afterEach(async () => {
  await net?.destroy();
  net = undefined;
});

const T = 60_000;

describe("p2p flows over a real swarm", () => {
  it(
    "a Member's photo reaches the Admin",
    async () => {
      net = await realNet();
      const { admin, joiner, joinerFolderId } = await sharedAlbum(net);
      const added = await joiner.store.addBytes("b.jpg", new Uint8Array([9, 9, 9]), joinerFolderId);
      expect(added[0]).toBeNull();
      const seen = await eventually(
        () => admin.store.list(),
        (l) => l.some((p) => p.name === "b.jpg"),
        "the Member's photo on the Admin",
      );
      expect(seen.map((p) => p.name).sort()).toEqual(["a.jpg", "b.jpg"]);
      expect(admin.changes.some((c) => c.cause === "add")).toBe(true);

      // The same flow must be diagnosable from logs alone (#200): a connection,
      // the identity exchange and the drive change each left an event.
      const opened = admin.events.filter((e) => e.event === "conn.open");
      expect(opened.length).toBeGreaterThan(0);
      const conn = opened[0].fields.conn;
      expect(conn).toEqual(expect.any(Number));
      const identity = admin.events.find(
        (e) => e.event === "identity.learned" && e.fields.new === true,
      );
      expect(identity?.fields.conn).toEqual(expect.any(Number));
      expect(identity?.fields.identity).toMatch(/^[0-9a-f]{8}$/);
      expect(
        admin.events.some((e) => e.event === "drive.change" && Number(e.fields.length) > 0),
      ).toBe(true);
      expect(admin.events.some((e) => e.event === "drive.open.ready")).toBe(true);
      // The state dump names the live connection and its learned identity.
      const dump = admin.store.debugState() as {
        connections: { conn: number; identityKey: string | null }[];
      };
      expect(dump.connections.some((c) => c.identityKey !== null)).toBe(true);
    },
    T,
  );

  it(
    "a photo the Admin adds after the join reaches the Member",
    async () => {
      net = await realNet();
      const { admin, joiner } = await sharedAlbum(net);
      expect((await admin.store.addBytes("c.jpg", new Uint8Array([7, 7])))[0]).toBeNull();
      await eventually(
        () => joiner.store.list(),
        (l) => l.some((p) => p.name === "c.jpg"),
        "the Admin's new photo on the Member",
      );
    },
    T,
  );

  it(
    "a removal on the Admin reaches the Member",
    async () => {
      net = await realNet();
      const { admin, joiner } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list(),
        (l) => l.length === 1,
        "the Admin's photo on the Member",
      );
      const [photo] = await admin.store.list();
      expect((await admin.store.remove(photo.id))[0]).toBeNull();
      await eventually(
        () => joiner.store.list(),
        (l) => l.length === 0,
        "the removal on the Member",
      );
      // A replicated change is pushed as a refresh; the web layer reloads on
      // any cause but "presence" (handle-message.ts), so the cause is not "remove".
      expect(joiner.changes.some((c) => c.cause !== "presence")).toBe(true);
    },
    T,
  );

  it(
    "presence: each side sees the other connected, then not once it leaves",
    async () => {
      net = await realNet();
      const { admin, joiner, joinerFolderId } = await sharedAlbum(net);
      expect((await joiner.store.setActive(joinerFolderId))[0]).toBeNull();
      const other = (s: Awaited<ReturnType<typeof admin.store.status>>, self: string) =>
        s.members.find((m: Member) => m.key !== self);
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
      expect(other(after, after.driveKey)?.lastSeenAt).toBeTypeOf("number");
    },
    T,
  );

  it(
    "restart: a Member comes back with its album, role and photos, and keeps syncing",
    async () => {
      net = await realNet();
      const { admin, joiner, shareKey } = await sharedAlbum(net);
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.length === 1,
        "first sync",
      );
      await joiner.stop();

      const again = await net.peer("Desktop", joiner.storageDir);
      const album = await albumIn(again.store, shareKey);
      expect(album?.role).toBe("member");
      expect(album?.pending).toBeFalsy();
      expect(album?.name).toBe("Shared");
      expect((await again.store.list({ all: true })).map((p) => p.name)).toEqual(["a.jpg"]);

      expect((await admin.store.addBytes("d.jpg", new Uint8Array([4, 4])))[0]).toBeNull();
      await eventually(
        () => again.store.list({ all: true }),
        (l) => l.some((p) => p.name === "d.jpg"),
        "a photo added while restarting reaches the restarted Member",
      );
    },
    T,
  );

  it(
    "restart: presence follows a peer whose connection key changed",
    async () => {
      net = await realNet();
      const { admin, joiner } = await sharedAlbum(net);
      const other = (s: Awaited<ReturnType<typeof admin.store.status>>) =>
        s.members.find((m: Member) => m.key !== s.driveKey);
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
    T,
  );

  it(
    "restart: the Admin comes back and still serves its album",
    async () => {
      net = await realNet();
      const { admin, joiner, folderId } = await sharedAlbum(net);
      await admin.stop();
      const again = await net.peer("Phone", admin.storageDir);
      expect((await again.store.setActive(folderId))[0]).toBeNull();
      expect((await again.store.addBytes("e.jpg", new Uint8Array([5])))[0]).toBeNull();
      await eventually(
        () => joiner.store.list({ all: true }),
        (l) => l.some((p) => p.name === "e.jpg"),
        "a photo from the restarted Admin on the Member",
      );
    },
    T,
  );

  it(
    "a declined request leaves the joiner a pending reader and clears the inbox",
    async () => {
      net = await realNet();
      const admin = await net.peer("Phone");
      const joiner = await net.peer("Desktop");
      const created = await admin.store.createFolder("Private");
      expect(created[0]).toBeNull();
      const { id: folderId, shareKey } = created[1]!.folder;
      expect((await joiner.store.join(shareKey))[0]).toBeNull();
      const { requests } = await eventually(
        () => admin.store.requests(),
        (r) => r.requests.length === 1,
        "the join request",
      );
      expect((await admin.store.respond(folderId, requests[0].requesterKey, false))[0]).toBeNull();
      expect((await admin.store.requests()).requests).toEqual([]);
      // Nothing upgrades the joiner: give replication a moment to prove it.
      await new Promise((r) => setTimeout(r, 1500));
      const album = await albumIn(joiner.store, shareKey);
      expect(album?.role).not.toBe("member");
    },
    T,
  );
});
