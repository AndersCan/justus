import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { FriendError } from "@justus/core";
import { createFriendsStore } from "./friends-store";

const A = "a".repeat(64);
const B = "b".repeat(64);

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friends-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = () => createFriendsStore({ dir, files: fs as never, paths: path as never });

describe("friends store", () => {
  test("add then list", async () => {
    const store = open();
    expect(store.list()).toEqual([null, []]);
    expect(await store.add(A, "Sam")).toEqual([null, { identity: A, name: "Sam" }]);
    expect(store.list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("rename changes the name and survives a restart", async () => {
    const store = open();
    await store.add(A, "Ben B");
    expect(await store.rename(A, "  Ben ")).toEqual([null, { identity: A, name: "Ben" }]);
    expect(store.list()).toEqual([null, [{ identity: A, name: "Ben" }]]);
    expect(open().list()).toEqual([null, [{ identity: A, name: "Ben" }]]);
  });

  test("rename accepts an uppercase identity and cuts a long name", async () => {
    const store = open();
    await store.add(A, "Sam");
    const [e, friend] = await store.rename("A".repeat(64), "x".repeat(60));
    expect(e).toBeNull();
    expect(friend).toEqual({ identity: A, name: "x".repeat(40) });
  });

  test("rename errors leave the file unchanged", async () => {
    const store = open();
    await store.add(A, "Sam");
    const file = path.join(dir, "friends.json");
    const before = fs.readFileSync(file, "utf8");
    expect((await store.rename(A, "   "))[0]?.code).toBe(FriendError.NAME_REQUIRED);
    expect((await store.rename("nope", "Ben"))[0]?.code).toBe(FriendError.INVALID_KEY);
    expect((await store.rename(B, "Ben"))[0]?.code).toBe(FriendError.NOT_FOUND);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(store.list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("a failed rename write keeps the old name", async () => {
    const store = createFriendsStore({
      dir,
      files: {
        ...fs,
        renameSync: (from: string, to: string) => {
          if (to.endsWith("friends.json") && fs.existsSync(to)) throw new Error("disk full");
          fs.renameSync(from, to);
        },
      } as never,
      paths: path as never,
    });
    await store.add(A, "Sam");
    expect((await store.rename(A, "Ben"))[0]?.code).toBe(FriendError.WRITE_FAILED);
    expect(store.list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("remove takes a friend off and survives a restart", async () => {
    const store = open();
    await store.add(A, "Sam");
    await store.add(B, "Ben");
    expect(await store.remove(A)).toEqual([null, { removed: true }]);
    expect(store.list()).toEqual([null, [{ identity: B, name: "Ben" }]]);
    expect(open().list()).toEqual([null, [{ identity: B, name: "Ben" }]]);
  });

  test("removing someone not saved is a no-op", async () => {
    const store = open();
    expect(await store.remove(A)).toEqual([null, { removed: false }]);
    expect(fs.existsSync(path.join(dir, "friends.json"))).toBe(false);
  });

  test("remove accepts an uppercase identity", async () => {
    const store = open();
    await store.add(A, "Sam");
    expect(await store.remove("A".repeat(64))).toEqual([null, { removed: true }]);
    expect(store.list()).toEqual([null, []]);
  });

  test("remove with a bad key is INVALID_KEY", async () => {
    const [e] = await open().remove("nope");
    expect(e?.code).toBe(FriendError.INVALID_KEY);
  });

  test("a failed remove write keeps the friend", async () => {
    const store = createFriendsStore({
      dir,
      files: {
        ...fs,
        renameSync: (from: string, to: string) => {
          if (fs.existsSync(to)) throw new Error("disk full");
          fs.renameSync(from, to);
        },
      } as never,
      paths: path as never,
    });
    await store.add(A, "Sam");
    const [e] = await store.remove(A);
    expect(e?.code).toBe(FriendError.WRITE_FAILED);
    expect(store.list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
    expect(open().list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("survives a restart", async () => {
    await open().add(A, "Sam");
    expect(open().list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("trims and truncates to 40", async () => {
    const store = open();
    const [, f1] = await store.add(A, "  Sam  ");
    expect(f1?.name).toBe("Sam");
    const [, f2] = await store.add(B, "x".repeat(60));
    expect(f2?.name).toBe("x".repeat(40));
  });

  test("empty name is NAME_REQUIRED", async () => {
    const [e] = await open().add(A, "   ");
    expect(e?.code).toBe(FriendError.NAME_REQUIRED);
  });

  test("bad identity is INVALID_KEY", async () => {
    const [e] = await open().add("nope", "Sam");
    expect(e?.code).toBe(FriendError.INVALID_KEY);
  });

  test("uppercase identity is stored lowercased", async () => {
    const store = open();
    expect(await store.add("A".repeat(64), "Sam")).toEqual([null, { identity: A, name: "Sam" }]);
  });

  test("adding an existing identity returns the original name", async () => {
    const store = open();
    await store.add(A, "Sam");
    expect(await store.add(A, "Other")).toEqual([null, { identity: A, name: "Sam" }]);
  });

  test("corrupt file lists empty and add writes a valid file", async () => {
    fs.writeFileSync(path.join(dir, "friends.json"), "{not json");
    const store = open();
    expect(store.list()).toEqual([null, []]);
    await store.add(A, "Sam");
    expect(open().list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("entries with a bad identity or name are dropped", () => {
    fs.writeFileSync(
      path.join(dir, "friends.json"),
      JSON.stringify({
        version: 1,
        friends: { bad: { name: "X" }, [A]: { name: "Sam" }, [B]: { name: " " } },
      }),
    );
    expect(open().list()).toEqual([null, [{ identity: A, name: "Sam" }]]);
  });

  test("a failed write is WRITE_FAILED and leaves the list unchanged", async () => {
    const store = createFriendsStore({
      dir,
      files: {
        ...fs,
        existsSync: () => false,
        writeFileSync: () => {
          throw new Error("disk full");
        },
        mkdirSync: () => undefined,
      } as never,
      paths: path as never,
    });
    const [e] = await store.add(A, "Sam");
    expect(e?.code).toBe(FriendError.WRITE_FAILED);
    expect(store.list()).toEqual([null, []]);
  });
});
