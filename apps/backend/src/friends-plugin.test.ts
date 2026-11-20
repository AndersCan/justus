import { describe, expect, test } from "vite-plus/test";
import { CoreError } from "@ekrooh/bare/core";
import { createFriendsPlugin } from "./friends-plugin";
import { createHash } from "node:crypto";
import type { FriendsStore } from "./friends-store";

const crypto = { createHash } as unknown as Parameters<typeof createFriendsPlugin>[0]["crypto"];
const A = "a".repeat(64);
const B = "b".repeat(64);

function invoke(
  plugin: ReturnType<typeof createFriendsPlugin>,
  event: string,
  args: Record<string, unknown>,
) {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error("no invoke adapter");
  return adapter.invoke(event, args, { runtime: "bare", payload: new Uint8Array() });
}

describe("justus.friends plugin", () => {
  test("list and add round-trip through the store", async () => {
    const stored: { identity: string; name: string }[] = [];
    const store: FriendsStore = {
      list: () => [null, stored],
      add: async (identity, name) => {
        stored.push({ identity, name });
        return [null, { identity, name }];
      },
      rename: async (identity, name) => {
        const f = stored.find((x) => x.identity === identity);
        if (!f) return [new CoreError("justus.friends/not-found", "no"), null];
        f.name = name;
        return [null, { identity, name }];
      },
      remove: async (identity) => {
        const at = stored.findIndex((f) => f.identity === identity);
        if (at >= 0) stored.splice(at, 1);
        return [null, { removed: at >= 0 }];
      },
    };
    const plugin = createFriendsPlugin({ store, ownIdentity: () => B, crypto });
    expect(await invoke(plugin, "friends.add", { identity: A, name: "Sam" })).toEqual([
      null,
      { friend: { identity: A, name: "Sam" } },
    ]);
    expect(await invoke(plugin, "friends.list", {})).toEqual([
      null,
      { friends: [{ identity: A, name: "Sam" }] },
    ]);
    expect(await invoke(plugin, "friends.rename", { identity: A, name: "Samuel" })).toEqual([
      null,
      { friend: { identity: A, name: "Samuel" } },
    ]);
    const [renameErr] = await invoke(plugin, "friends.rename", {
      identity: "b".repeat(64),
      name: "X",
    });
    expect(renameErr?.code).toBe("justus.friends/not-found");
    expect(await invoke(plugin, "friends.remove", { identity: A })).toEqual([
      null,
      { removed: true },
    ]);
    expect(await invoke(plugin, "friends.list", {})).toEqual([null, { friends: [] }]);
  });

  describe("friends.words", () => {
    const store = {} as FriendsStore;
    const as = (own: string | undefined) =>
      createFriendsPlugin({ store, ownIdentity: () => own, crypto });

    test("both phones get the same words", async () => {
      const [, ab] = await invoke(as(A), "friends.words", { identity: B });
      const [, ba] = await invoke(as(B), "friends.words", { identity: A });
      expect((ab as { words: string }).words).toMatch(/^[a-z]+( [a-z]+){3}$/);
      expect(ab).toEqual(ba);
    });

    test("uppercase identity gives the same words", async () => {
      const [, lower] = await invoke(as(A), "friends.words", { identity: B });
      const [, upper] = await invoke(as(A), "friends.words", { identity: B.toUpperCase() });
      expect(upper).toEqual(lower);
    });

    test("a non-hex identity is refused", async () => {
      const [e] = await invoke(as(A), "friends.words", { identity: "nope" });
      expect(e?.code).toBe("justus.friends/invalid-key");
    });

    test("no words before the own identity is known, or for the own identity", async () => {
      expect(await invoke(as(undefined), "friends.words", { identity: B })).toEqual([null, {}]);
      expect(await invoke(as(A), "friends.words", { identity: A })).toEqual([null, {}]);
    });
  });
});
