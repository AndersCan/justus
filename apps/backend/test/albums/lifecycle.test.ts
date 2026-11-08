/**
 * Archive, restore and delete for everyone, over the checked fake drives: what the
 * store shows, what it removes, and what a restart finishes.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPhotoStore, type PhotoStore } from "../../src/photo-store.ts";
import {
  adminDroppedYou,
  adminListsYou,
  clearLeftNote,
  deleteOwnPhotos,
  listedWithin,
  parseDeleteNote,
  parseLeftNote,
} from "../../src/albums/lifecycle.ts";
import { inviteTopic } from "../../src/membership/invite.ts";
import type { Drive } from "../../src/ports/drive-store.ts";
import { createFakeHub } from "../fakes/fake-world.ts";
import { fakeStoreDeps, joinAsMember, restarted } from "../fakes/fake-store-deps.ts";
type SyncMember = Awaited<ReturnType<PhotoStore["status"]>>["members"][number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function device(name: string, hub = createFakeHub()) {
  const deps = fakeStoreDeps({ hub, deviceName: name });
  mkdirSync(deps.cacheDir, { recursive: true });
  return { deps, store: createPhotoStore(deps) };
}

/** Opens a drive on the store's own drives, which hands back the object the store uses. */
async function driveOf(deps: ReturnType<typeof device>["deps"], key: string): Promise<Drive> {
  const [error, drive] = await deps.drives.open(key, { timeoutMs: 1_000 });
  if (error) throw error;
  return drive;
}

async function albumWithPhoto(name: string) {
  const admin = device("Nils");
  await admin.store.ready();
  const created = await admin.store.createFolder(name);
  const album = created[1]!.folder;
  await admin.store.addBytes("a.jpg", new Uint8Array([1, 2, 3]), album.id);
  return { admin, album };
}

describe("archive", () => {
  it("keeps the album out of folders and the timeline, on this phone only", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const member = device("Maya", admin.deps.hub);
    await member.store.ready();
    await joinAsMember(admin.store, album.id, member.store, album.shareKey);
    const mine = (await member.store.folders()).folders.find((f) => f.shareKey === album.shareKey)!;

    expect((await member.store.archiveAlbum(mine.id))[0]).toBeNull();
    const archivedView = await member.store.folders();
    expect(archivedView.folders).toEqual([]);
    expect(archivedView.archived.map((f) => f.id)).toEqual([mine.id]);
    expect(await member.store.list({ all: true })).toEqual([]);
    // The Admin's phone does not change.
    expect((await admin.store.folders()).folders.map((f) => f.id)).toEqual([album.id]);

    // It keeps syncing: a photo the Admin adds while archived is there on restore.
    await admin.store.addBytes("b.jpg", new Uint8Array([4, 5, 6]), album.id);
    await sleep(600);
    expect((await member.store.restoreAlbum(mine.id))[0]).toBeNull();
    const restored = await member.store.folders();
    expect(restored.archived).toEqual([]);
    expect(restored.folders.map((f) => f.id)).toEqual([mine.id]);
    expect((await member.store.list({ all: true })).map((p) => p.name).sort()).toEqual([
      "a.jpg",
      "b.jpg",
    ]);
  });

  it("opens the next shown album when the active one is archived", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const other = (await admin.store.createFolder("Summer"))[1]!.folder;
    await admin.store.setActive(album.id);
    await admin.store.archiveAlbum(album.id);
    expect((await admin.store.folders()).activeFolderId).toBe(other.id);
    await admin.store.archiveAlbum(other.id);
    expect((await admin.store.folders()).activeFolderId).toBe("");
  });

  it("is saved: an archived album is still archived after a restart", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    await admin.store.archiveAlbum(album.id);
    const again = createPhotoStore(restarted(admin.deps));
    const view = await (async () => {
      await again.ready();
      return again.folders();
    })();
    expect(view.folders).toEqual([]);
    expect(view.archived.map((f) => f.id)).toEqual([album.id]);
  });
});

describe("delete for everyone", () => {
  it("removes the album and its photos from the Admin, and keeps a note to offer", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    expect((await admin.store.deleteAlbum(album.id))[0]).toBeNull();
    const view = await admin.store.folders();
    expect([...view.folders, ...view.archived]).toEqual([]);
    expect(view.deleted).toEqual([]);
    expect(await admin.store.list({ all: true })).toEqual([]);
    const state = admin.store.debugState() as { gone: Array<{ kind: string }> };
    expect(state.gone.map((g) => g.kind)).toEqual(["deletedForEveryone"]);
  });

  it("forgets the deleted album's photos, so they no longer count as duplicates", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const indexed = () => (admin.store.debugState() as { indexedPhotos: number }).indexedPhotos;
    expect(indexed()).toBe(1);
    expect((await admin.store.deleteAlbum(album.id))[0]).toBeNull();
    expect(indexed()).toBe(0);
    const other = (await admin.store.createFolder("Ny"))[1]!.folder;
    const [error, added] = await admin.store.addBytes("a.jpg", new Uint8Array([1, 2, 3]), other.id);
    expect(error).toBeNull();
    expect(added?.folderId).toBe(other.id);
    expect(indexed()).toBe(1);
  });

  it("removes nothing when the delete note cannot be written", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const drive = await driveOf(admin.deps, album.shareKey);
    const put = drive.put.bind(drive);
    vi.spyOn(drive, "put").mockImplementation((p, ...rest) =>
      p === "/deleted.json" ? Promise.reject(new Error("disk full")) : put(p, ...rest),
    );
    try {
      const [error] = await admin.store.deleteAlbum(album.id);
      expect(error?.code).toBe("justus.photos/album-not-changed");
      expect(error?.message).toContain("disk full");
    } finally {
      vi.restoreAllMocks();
    }
    expect((await admin.store.folders()).folders.map((f) => f.id)).toEqual([album.id]);
    expect((await admin.store.list({ all: true })).map((p) => p.name)).toEqual(["a.jpg"]);
  });

  it("resumes after a crash that left the album marked as deleting", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const file = join(admin.deps.storageDir, "justus.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.folders[0].lifecycle = "deleting";
    writeFileSync(file, JSON.stringify(saved));
    const again = createPhotoStore(restarted(admin.deps));
    await again.ready();
    const view = await again.folders();
    expect([...view.folders, ...view.archived]).toEqual([]);
    expect(await again.list({ all: true })).toEqual([]);
    const state = again.debugState() as { gone: Array<{ id: string; kind: string }> };
    expect(state.gone).toMatchObject([{ id: album.id, kind: "deletedForEveryone" }]);
  });

  it("refuses to delete an album that is not the Admin's, or is archived", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const member = device("Maya", admin.deps.hub);
    await member.store.ready();
    await joinAsMember(admin.store, album.id, member.store, album.shareKey);
    const mine = (await member.store.folders()).folders.find((f) => f.shareKey === album.shareKey)!;
    expect((await member.store.deleteAlbum(mine.id))[0]?.code).toBe("justus.photos/not-creator");
    await admin.store.archiveAlbum(album.id);
    expect((await admin.store.deleteAlbum(album.id))[0]?.code).toBe("justus.photos/album-archived");
    expect((await admin.store.deleteAlbum("nope"))[0]?.code).toBe("justus.photos/folder-not-found");
  });
});

describe("delete note", () => {
  it("names the Admin", () => {
    expect(parseDeleteNote(JSON.stringify({ version: 1, adminName: "Nils", at: 1 }))).toEqual({
      adminName: "Nils",
    });
  });

  it("ignores text that is not an object", () => {
    for (const text of [null, "", "nope", "[]", "7", "null", '"x"']) {
      expect(parseDeleteNote(text)).toBeUndefined();
    }
  });

  it("counts a note of an unknown version as deleted, and clips the name", () => {
    expect(parseDeleteNote(JSON.stringify({ version: 9, adminName: "N".repeat(500) }))).toEqual({
      adminName: "N".repeat(80),
    });
    expect(parseDeleteNote(JSON.stringify({ version: 9 }))).toEqual({ adminName: "the Admin" });
  });
});

describe("delete clears what it should", () => {
  it("clears the Admin's photo bytes and leaves the delete note", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const drive = await driveOf(admin.deps, album.shareKey);
    const photos: string[] = [];
    for await (const entry of drive.list("/photos")) photos.push(entry.path);
    expect(photos.length).toBeGreaterThan(0);
    const clear = vi.spyOn(drive, "clear");
    expect((await admin.store.deleteAlbum(album.id))[0]).toBeNull();
    expect(clear.mock.calls.some((c) => c[0].startsWith("/photos/"))).toBe(true);
    for (const path of photos) expect(await drive.readBytes(path)).toBeUndefined();
    expect(await drive.readSmall("/deleted.json", 1 << 20)).toBeDefined();
  });

<<<<<<< HEAD
  it("purges the other drives and keeps the invite topic of the album", async () => {
=======
  async function listed(drive: Drive): Promise<string[]> {
    const paths: string[] = [];
    for await (const entry of drive.list("/")) paths.push(entry.path);
    return paths;
  }

  it("leaves only the delete note in the album, with no older version to read", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const before = (await driveOf(admin.deps, album.shareKey)).version();
    expect((await admin.store.deleteAlbum(album.id))[0]).toBeNull();
    const kim = device("Kim", admin.deps.hub);
    const drive = await driveOf(kim.deps, album.shareKey);
    expect(await listed(drive)).toEqual(["/deleted.json"]);
    expect(parseDeleteNote((await drive.readSmall("/deleted.json", 1 << 20)) ?? null)).toEqual({
      adminName: "Nils",
    });
    const [error, old] = await kim.deps.drives.openAt(album.shareKey, before, { timeoutMs: 1_000 });
    expect(error ? [] : await listed(old)).toEqual([]);
  });

  it("clears an album deleted before this update at the next start", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const before = (await driveOf(admin.deps, album.shareKey)).version();
    expect((await admin.store.deleteAlbum(album.id))[0]).toBeNull();
    const adminDrive = await driveOf(admin.deps, album.shareKey);
    await adminDrive.put("/folder.json", Buffer.from("{}"));
    const again = createPhotoStore(restarted(admin.deps));
    await again.ready();
    const kim = device("Kim", admin.deps.hub);
    const drive = await driveOf(kim.deps, album.shareKey);
    expect(await listed(drive)).toEqual(["/deleted.json"]);
    const [error, old] = await kim.deps.drives.openAt(album.shareKey, before, { timeoutMs: 1_000 });
    expect(error ? [] : await listed(old)).toEqual([]);
    const version = (await driveOf(admin.deps, album.shareKey)).version();
    const third = createPhotoStore(restarted(admin.deps));
    await third.ready();
    expect((await driveOf(admin.deps, album.shareKey)).version()).toBe(version);
  });
  it("purges the other drives and leaves the invite topic of the album", async () => {
>>>>>>> d76eb62 (Deleting an album for everyone leaves only the delete note and drops older versions)
    const { admin, album } = await albumWithPhoto("Hytta");
    const member = device("Maya", admin.deps.hub);
    await member.store.ready();
    const memberKey = await joinAsMember(admin.store, album.id, member.store, album.shareKey);
    const saved = JSON.parse(readFileSync(join(admin.deps.storageDir, "justus.json"), "utf8"));
    const code: string = saved.folders[0].invite.code;
    const leave = vi.spyOn(admin.deps.network, "leave");
    const purge = vi.spyOn(admin.deps.drives, "purge");
    expect((await admin.store.deleteAlbum(album.id))[0]).toBeNull();
    expect(purge.mock.calls.map((c: unknown[]) => c[0])).toContain(memberKey);
    expect(admin.deps.node.replicas.has(memberKey)).toBe(false);
    const left = leave.mock.calls.map((call: unknown[]) => call[0]);
    expect(left).not.toContain(inviteTopic(code, admin.deps.crypto).toString("hex"));
  });
});

describe("deleteOwnPhotos", () => {
  function stub(paths: string[], failOn?: string) {
    const files = new Set(paths);
    const cleared: string[] = [];
    const drive = {
      async *list(dir: string) {
        for (const path of Array.from(files)) if (path.startsWith(dir + "/")) yield { path };
      },
      async clear(path: string) {
        if (path === failOn) throw new Error("boom");
        cleared.push(path);
      },
      async del(path: string) {
        files.delete(path);
      },
    } as unknown as Drive;
    return { drive, files, cleared };
  }

  it("clears and deletes photos and thumbs, and keeps everything else", async () => {
    const { drive, files, cleared } = stub(["/photos/a", "/thumbs/a", "/deleted.json", "/x"]);
    await deleteOwnPhotos(drive, { log: () => {} });
    expect([...files].sort()).toEqual(["/deleted.json", "/x"]);
    expect(cleared.sort()).toEqual(["/photos/a", "/thumbs/a"]);
  });

  it("is safe to run twice", async () => {
    const { drive, files } = stub(["/photos/a"]);
    await deleteOwnPhotos(drive, { log: () => {} });
    await deleteOwnPhotos(drive, { log: () => {} });
    expect([...files]).toEqual([]);
  });

  it("logs a file that fails to clear and goes on with the others", async () => {
    const { drive, files } = stub(["/photos/a", "/photos/b"], "/photos/a");
    const log = vi.fn();
    await deleteOwnPhotos(drive, { log });
    expect([...files]).toEqual(["/photos/a"]);
    expect(log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ path: "/photos/a", err: "boom" }),
    );
  });
});

describe("leave", () => {
  async function memberOf(
    album: { id: string; shareKey: string },
    admin: ReturnType<typeof device>,
  ) {
    const member = device("Maya", admin.deps.hub);
    await member.store.ready();
    await joinAsMember(admin.store, album.id, member.store, album.shareKey);
    const mine = (await member.store.folders()).folders.find((f) => f.shareKey === album.shareKey)!;
    // A left note only counts when it is newer than the join: never leave in the millisecond of the approval.
    await sleep(5);
    return { member, mine };
  }

  it("a reader nobody lists tells nobody and keeps nothing", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const viewer = device("Vera", admin.deps.hub);
    await viewer.store.ready();
    await viewer.store.join(album.shareKey);
    const asked = (await viewer.store.folders()).folders.find(
      (f) => f.shareKey === album.shareKey,
    )!;
    expect(asked.role).toBe("reader");
    const puts = [
      vi.spyOn(await driveOf(viewer.deps, asked.driveKey), "put"),
      vi.spyOn(await viewer.deps.drives.openOwn(), "put"),
    ];
    expect((await viewer.store.leaveAlbum(asked.id))[0]).toBeNull();
    for (const put of puts)
      expect(put.mock.calls.some((c: unknown[]) => c[0] === "/left.json")).toBe(false);
    const view = await viewer.store.folders();
    expect([...view.folders, ...view.archived, ...view.deleted]).toEqual([]);
    expect((viewer.store.debugState() as { gone: unknown[] }).gone).toEqual([]);
    expect((await admin.store.folders()).folders.map((f) => f.id)).toEqual([album.id]);
  });

  it("a listed Viewer writes the left note and waits", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const { member, mine } = await memberOf(album, admin);
    expect((await admin.store.makeViewer(album.id, mine.driveKey))[0]).toBeNull();
    const selfDrive = vi.spyOn(await member.deps.drives.openOwn(), "put");
    const albumDrive = vi.spyOn(await driveOf(member.deps, mine.driveKey), "put");
    expect((await member.store.leaveAlbum(mine.id))[0]).toBeNull();
    const gone = (member.store.debugState() as { gone: { kind: string; listedIn?: string }[] })
      .gone;
    expect(gone.map((g) => [g.kind, g.listedIn])).toEqual([
      ["waitingForAdminToSeeYouLeft", "viewers"],
    ]);
    const wrote = [...selfDrive.mock.calls, ...albumDrive.mock.calls].some(
      (c: unknown[]) => c[0] === "/left.json",
    );
    expect(wrote).toBe(true);
  });

  it("a Member who leaves is kept as waiting, and the Admin is the only one who cannot leave", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const { member, mine } = await memberOf(album, admin);
    expect((await member.store.leaveAlbum(mine.id))[0]).toBeNull();
    const state = member.store.debugState() as { gone: Array<{ kind: string }> };
    expect(state.gone.map((g) => g.kind)).toEqual(["waitingForAdminToSeeYouLeft"]);
    expect((await admin.store.leaveAlbum(album.id))[0]?.code).toBe(
      "justus.photos/admin-cannot-leave",
    );
    expect((await member.store.leaveAlbum("nope"))[0]?.code).toBe("justus.photos/folder-not-found");
  });

  it("keeps the album when the left note cannot be written", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const { member, mine } = await memberOf(album, admin);
    const drive = await driveOf(member.deps, mine.driveKey);
    const put = drive.put.bind(drive);
    vi.spyOn(drive, "put").mockImplementation((p, ...rest) =>
      p === "/left.json" ? Promise.reject(new Error("disk full")) : put(p, ...rest),
    );
    try {
      const [error] = await member.store.leaveAlbum(mine.id);
      expect(error?.code).toBe("justus.photos/album-not-changed");
      expect(error?.message).toContain("disk full");
    } finally {
      vi.restoreAllMocks();
    }
    expect((await member.store.folders()).folders.map((f) => f.id)).toEqual([mine.id]);
    expect((member.store.debugState() as { gone: unknown[] }).gone).toEqual([]);
  });

  it("an old left note does not drop a member who joined again", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const { member, mine } = await memberOf(album, admin);
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      expect((await member.store.leaveAlbum(mine.id))[0]).toBeNull();
    } finally {
      now.mockRestore();
    }
    await sleep(1_000);
    const members = (await admin.store.status()).members.filter((m: SyncMember) => !m.admin);
    expect(members.map((m: SyncMember) => m.key)).toEqual([mine.driveKey]);
  });

  async function droppedByAdmin(
    admin: ReturnType<typeof device>,
    member: ReturnType<typeof device>,
    mine: { id: string },
  ) {
    expect((await member.store.leaveAlbum(mine.id))[0]).toBeNull();
    for (let i = 0; i < 100; i++) {
      const members = (await admin.store.status()).members.filter((m: SyncMember) => !m.admin);
      if (members.length === 0) return;
      await sleep(100);
    }
    throw new Error("the Member was not dropped");
  }

  it("joining again after leaving removes the old left note, and the Member stays", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const { member, mine } = await memberOf(album, admin);
    await droppedByAdmin(admin, member, mine);
    const del = vi.spyOn(await driveOf(member.deps, mine.driveKey), "del");
    await joinAsMember(admin.store, album.id, member.store, album.shareKey);
    expect(del.mock.calls.some((c) => c[0] === "/left.json")).toBe(true);
    await sleep(500);
    expect((await admin.store.status()).members.filter((m: SyncMember) => !m.admin)).toHaveLength(
      1,
    );
  }, 20_000);

  it("a Member whose note is newer than the join is dropped", async () => {
    const { admin, album } = await albumWithPhoto("Hytta");
    const { member, mine } = await memberOf(album, admin);
    expect((await member.store.leaveAlbum(mine.id))[0]).toBeNull();
    for (let i = 0; i < 100; i++) {
      const members = (await admin.store.status()).members.filter((m: SyncMember) => !m.admin);
      if (members.length === 0) break;
      await sleep(100);
    }
    expect((await admin.store.status()).members.filter((m: SyncMember) => !m.admin)).toEqual([]);
  });
});

describe("left note", () => {
  it("reads when the member left", () => {
    expect(parseLeftNote(JSON.stringify({ version: 1, leftAt: 5 }))).toEqual({ leftAt: 5 });
  });

  it("ignores a missing, malformed or wrongly typed note", () => {
    for (const text of [null, "", "nope", "[]", "{}", '{"leftAt":"5"}', '{"leftAt":null}']) {
      expect(parseLeftNote(text)).toBeUndefined();
    }
  });
});

describe("clearLeftNote", () => {
  const log = () => {};
  const stub = (files: Map<string, string>, readFails = false) =>
    ({
      readSmall: async (path: string) => {
        if (readFails) throw new Error("boom");
        return files.get(path);
      },
      del: async (path: string) => {
        files.delete(path);
      },
    }) as unknown as Drive;

  it("removes a left note", async () => {
    const files = new Map([["/left.json", '{"version":1,"leftAt":5}']]);
    await clearLeftNote(stub(files), { log });
    expect(files.has("/left.json")).toBe(false);
  });

  it("does nothing when there is no note, and never rejects", async () => {
    const files = new Map([["/other.json", "{}"]]);
    await clearLeftNote(stub(files), { log });
    expect([...files.keys()]).toEqual(["/other.json"]);
    await expect(clearLeftNote(stub(files, true), { log })).resolves.toBeUndefined();
  });
});

describe("adminDroppedYou for the Viewers list", () => {
  const viewers = (keys: string[]) =>
    JSON.stringify({ version: 1, viewers: Object.fromEntries(keys.map((k) => [k, { key: k }])) });

  it("is true only when the viewers list exists and lacks this drive", () => {
    expect(adminDroppedYou(viewers(["b"]), "a", "viewers")).toBe(true);
    expect(adminDroppedYou(viewers(["a", "b"]), "a", "viewers")).toBe(false);
  });

  it("a missing, junk or members-only file is not a drop", () => {
    for (const text of [null, "", "nope", "{}", '{"viewers":[]}', '{"members":{}}']) {
      expect(adminDroppedYou(text, "a", "viewers")).toBe(false);
    }
  });

  it("a members list naming the key does not hide a viewers drop, and the default stays members", () => {
    expect(adminDroppedYou('{"members":{"a":{}},"viewers":{}}', "a", "viewers")).toBe(true);
    expect(adminDroppedYou('{"members":{"a":{}},"viewers":{}}', "a")).toBe(false);
  });
});

describe("adminListsYou", () => {
  it("is true only when the named list parses and holds the key", () => {
    expect(adminListsYou('{"members":{"a":{}}}', "a", "members")).toBe(true);
    expect(adminListsYou('{"viewers":{"a":{}}}', "a", "viewers")).toBe(true);
    expect(adminListsYou('{"viewers":{"a":{}}}', "a", "members")).toBe(false);
    expect(adminListsYou('{"members":{"b":{}}}', "a", "members")).toBe(false);
  });

  it("a missing, junk or array list does not list anyone", () => {
    for (const text of [null, "", "nope", "{}", '{"viewers":["a"]}']) {
      expect(adminListsYou(text, "a", "viewers")).toBe(false);
    }
  });
});

describe("adminDroppedYou", () => {
  const list = (keys: string[]) =>
    JSON.stringify({ version: 1, members: Object.fromEntries(keys.map((k) => [k, { key: k }])) });

  it("is true only when the list exists and lacks this drive", () => {
    expect(adminDroppedYou(list(["b"]), "a")).toBe(true);
    expect(adminDroppedYou(list([]), "a")).toBe(true);
    expect(adminDroppedYou(list(["a", "b"]), "a")).toBe(false);
  });

  it("an empty or missing member list file does not count as the Admin dropping you", () => {
    for (const text of [null, "", "nope", "{}", "[]", '{"members":[]}', '{"members":null}']) {
      expect(adminDroppedYou(text, "a")).toBe(false);
    }
  });
});

describe("listedWithin", () => {
  it("is true as soon as the list names us, without waiting", async () => {
    const sleep = vi.fn(async () => {});
    expect(await listedWithin({ isListed: async () => true, tries: 3, waitMs: 10, sleep })).toBe(
      true,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it("looks again when the list trails, and is true once it catches up", async () => {
    let looks = 0;
    const sleep = vi.fn(async () => {});
    const listed = await listedWithin({
      isListed: async () => ++looks === 3,
      tries: 5,
      waitMs: 10,
      sleep,
    });
    expect(listed).toBe(true);
    expect(looks).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("is false after the last look, with no wait after it", async () => {
    let looks = 0;
    const sleep = vi.fn(async () => {});
    const listed = await listedWithin({
      isListed: async () => (looks++, false),
      tries: 4,
      waitMs: 10,
      sleep,
    });
    expect(listed).toBe(false);
    expect(looks).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
