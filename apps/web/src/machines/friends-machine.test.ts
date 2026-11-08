import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import {
  SAVE_FAILED_COPY,
  friendSheetOf,
  createFriendsActor,
  friends,
  friendsActor,
  savedFriends,
  type FriendsPort,
} from "./friends-machine";

vi.mock("../gateway", () => ({
  gateway: {
    friends: {
      list: vi.fn(async () => [null, { friends: [] }]),
      add: vi.fn(async (identity: string, name: string) => [null, { friend: { identity, name } }]),
      rename: vi.fn(async (identity: string, name: string) => [
        null,
        { friend: { identity, name } },
      ]),
      remove: vi.fn(async () => [null, { removed: true }]),
    },
  },
}));

type Reply = () => Promise<[unknown, unknown]>;

const open = (identity = "k1", ownName = "Kim") =>
  ({ type: "OPEN", payload: { target: { identity, ownName } } }) as never;
const add = () => ({ type: "ADD" }) as never;
const type = (text: string) => ({ type: "TYPE", payload: { text } }) as never;
const save = () => ({ type: "SAVE" }) as never;
const close = () => ({ type: "CLOSE" }) as never;

async function setup(options: { list?: Reply; add?: Reply; rename?: Reply; remove?: Reply } = {}) {
  const port = {
    list: vi.fn(options.list ?? (async () => [null, { friends: [] }])),
    add: vi.fn(
      options.add ??
        (async (identity: string, name: string) => [null, { identity, name }] as [null, unknown]),
    ),
    rename: vi.fn(
      options.rename ??
        (async (identity: string, name: string) =>
          [null, { friend: { identity, name } }] as [null, unknown]),
    ),
    remove: vi.fn(options.remove ?? (async () => [null, { removed: true }] as [null, unknown])),
  };
  const actor = createFriendsActor({ clock: VirtualClock(), port: port as unknown as FriendsPort });
  const outputs: unknown[] = [];
  actor.on("output", { fn: (e: unknown) => outputs.push(e) } as never);
  await actor.settled();
  return { actor, port, outputs };
}

describe("friends machine", () => {
  test("loads the friends on start", async () => {
    const { actor, port } = await setup({
      list: async () => [null, { friends: [{ identity: "k9", name: "Sam" }] }],
    });
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.friends).toEqual({ k9: "Sam" });
  });

  test("a failed load leaves the sheet closed with no friends and no error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { actor } = await setup({ list: async () => [new Error("disk"), null] });
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.friends).toEqual({});
    expect(actor.snapshot().context.error).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("OPEN is ignored while loading", () => {
    const port = { list: vi.fn(() => new Promise(() => {})), add: vi.fn() };
    const actor = createFriendsActor({
      clock: VirtualClock(),
      port: port as unknown as FriendsPort,
    });
    actor.send(open());
    expect(actor.state.name).toBe("loadingFriends");
  });

  test("the full add path stores the name and says so", async () => {
    const { actor, port, outputs } = await setup();
    actor.send(open());
    expect(actor.state.name).toBe("showingMember");
    actor.send(add());
    expect(actor.state.name).toBe("namingFriend");
    expect(actor.snapshot().payload).toEqual({
      identity: "k1",
      ownName: "Kim",
      draft: "Kim",
    });
    actor.send(type("  Kimmy  "));
    actor.send(save());
    expect(actor.state.name).toBe("savingFriend");
    await actor.settled();
    expect(port.add).toHaveBeenCalledWith("k1", "Kimmy");
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.friends).toEqual({ k1: "Kimmy" });
    expect(outputs).toEqual([
      expect.objectContaining({ type: "FRIEND_SAVED", payload: { name: "Kimmy" } }),
    ]);
  });

  test("typing cuts the draft to 40 characters", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(add());
    actor.send(type("x".repeat(60)));
    expect((actor.snapshot().payload as { draft: string }).draft).toBe("x".repeat(40));
  });

  test("SAVE with a blank draft is ignored", async () => {
    const { actor, port } = await setup();
    actor.send(open());
    actor.send(add());
    actor.send(type("   "));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("namingFriend");
    expect(port.add).not.toHaveBeenCalled();
  });

  test("ADD on an existing friend does nothing", async () => {
    const { actor } = await setup({
      list: async () => [null, { friends: [{ identity: "k1", name: "Kimmy" }] }],
    });
    actor.send(open());
    actor.send(add());
    expect(actor.state.name).toBe("showingMember");
  });

  test("a failed save returns to naming with the draft and the error", async () => {
    const { actor, outputs } = await setup({ add: async () => [new Error("full"), null] });
    actor.send(open());
    actor.send(add());
    actor.send(type("Kimmy"));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("namingFriend");
    expect((actor.snapshot().payload as { draft: string }).draft).toBe("Kimmy");
    expect(actor.snapshot().context.error).toBe(SAVE_FAILED_COPY);
    expect(outputs).toEqual([]);
    actor.send(type("Kimmy2"));
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("CLOSE from viewing and naming closes the sheet and clears the error", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(close());
    expect(actor.state.name).toBe("friendSheetClosed");
    actor.send(open());
    actor.send(add());
    actor.send(close());
    expect(actor.state.name).toBe("friendSheetClosed");
  });

  test("the draft is kept at exactly 40 characters and cut at 41", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(add());
    actor.send(type("y".repeat(40)));
    expect((actor.snapshot().payload as { draft: string }).draft).toBe("y".repeat(40));
    actor.send(type("y".repeat(41)));
    expect((actor.snapshot().payload as { draft: string }).draft).toBe("y".repeat(40));
  });

  test("OPEN and CLOSE are ignored while saving, which waits on the port", async () => {
    const { actor } = await setup({ add: () => new Promise(() => {}) });
    actor.send(open());
    actor.send(add());
    actor.send(save());
    expect(actor.state.name).toBe("savingFriend");
    actor.send(close());
    actor.send(open("k2", "Zed"));
    await Promise.resolve();
    expect(actor.state.name).toBe("savingFriend");
    expect((actor.snapshot().payload as { identity: string }).identity).toBe("k1");
  });
});

const rename = () => ({ type: "RENAME" }) as never;
const kimmy = async () =>
  [null, { friends: [{ identity: "k1", name: "Kimmy" }] }] as [null, unknown];

describe("renaming a friend", () => {
  test("RENAME on a saved friend opens naming with the saved name", async () => {
    const { actor } = await setup({ list: kimmy });
    actor.send(open());
    actor.send(rename());
    expect(actor.state.name).toBe("namingFriend");
    expect(actor.snapshot().payload).toEqual({
      identity: "k1",
      ownName: "Kim",
      draft: "Kimmy",
      renaming: true,
    });
  });

  test("RENAME on someone who is not a friend stays on the member view", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(rename());
    expect(actor.state.name).toBe("showingMember");
  });

  test("Save renames, updates the name and announces nothing", async () => {
    const { actor, port, outputs } = await setup({ list: kimmy });
    actor.send(open());
    actor.send(rename());
    actor.send(type("  Kim B  "));
    actor.send(save());
    await actor.settled();
    expect(port.rename).toHaveBeenCalledWith("k1", "Kim B");
    expect(port.add).not.toHaveBeenCalled();
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.friends).toEqual({ k1: "Kim B" });
    expect(outputs).toEqual([]);
  });

  test("Save with the saved name closes the sheet and calls nothing", async () => {
    const { actor, port } = await setup({ list: kimmy });
    actor.send(open());
    actor.send(rename());
    actor.send(type(" Kimmy "));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(port.rename).not.toHaveBeenCalled();
    expect(port.add).not.toHaveBeenCalled();
  });

  test("a failed rename keeps the draft and error, and Try again renames", async () => {
    let fail = true;
    const { actor, port } = await setup({
      list: kimmy,
      rename: async (identity: unknown, name: unknown) =>
        fail ? [new Error("full"), null] : [null, { friend: { identity, name } }],
    } as never);
    actor.send(open());
    actor.send(rename());
    actor.send(type("Kim B"));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("namingFriend");
    expect(actor.snapshot().payload).toMatchObject({ draft: "Kim B", renaming: true });
    expect(actor.snapshot().context.error).toBe(SAVE_FAILED_COPY);
    expect(actor.snapshot().context.friends).toEqual({ k1: "Kimmy" });
    fail = false;
    actor.send(save());
    await actor.settled();
    expect(port.rename).toHaveBeenCalledTimes(2);
    expect(port.add).not.toHaveBeenCalled();
    expect(actor.snapshot().context.friends).toEqual({ k1: "Kim B" });
  });

  test("a friend removed meanwhile closes the sheet quietly", async () => {
    const { actor, outputs } = await setup({
      list: kimmy,
      rename: async () => [
        Object.assign(new Error("gone"), { code: "justus.friends/not-found" }),
        null,
      ],
    });
    actor.send(open());
    actor.send(rename());
    actor.send(type("Kim B"));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.error).toBeNull();
    expect(actor.snapshot().context.friends).toEqual({});
    expect(outputs).toEqual([]);
  });
});

const remove = (identity: string) => ({ type: "REMOVE", payload: { identity } }) as never;
const sam = async () => [null, { friends: [{ identity: "k9", name: "Sam" }] }] as [null, unknown];

describe("removing a friend", () => {
  test("REMOVE takes the friend off the list and says so", async () => {
    const { actor, port, outputs } = await setup({ list: sam });
    actor.send(remove("k9"));
    expect(actor.state.name).toBe("removingFriend");
    await actor.settled();
    expect(port.remove).toHaveBeenCalledWith("k9");
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.friends).toEqual({});
    expect(outputs).toEqual([
      expect.objectContaining({ type: "FRIEND_REMOVED", payload: { name: "Sam" } }),
    ]);
  });

  test("a failed removal keeps the friend and says so", async () => {
    const { actor, outputs } = await setup({
      list: sam,
      remove: async () => [new Error("disk"), null],
    });
    actor.send(remove("k9"));
    await actor.settled();
    expect(actor.state.name).toBe("friendSheetClosed");
    expect(actor.snapshot().context.friends).toEqual({ k9: "Sam" });
    expect(outputs).toEqual([
      expect.objectContaining({ type: "FRIEND_NOT_REMOVED", payload: { name: "Sam" } }),
    ]);
  });

  test("REMOVE of someone not on the list does nothing", async () => {
    const { actor, port } = await setup({ list: sam });
    actor.send(remove("k1"));
    await actor.settled();
    expect(port.remove).not.toHaveBeenCalled();
    expect(actor.state.name).toBe("friendSheetClosed");
  });

  test("savedFriends sorts by name", () => {
    expect(savedFriends({ b: "Sam", a: "Ben", c: "adam" }).map((f) => f.name)).toEqual([
      "adam",
      "Ben",
      "Sam",
    ]);
  });
});

describe("friends singleton", () => {
  test("the sheet follows the machine through open, add, type and save", async () => {
    await friendsActor.settled();
    expect(friendSheetOf(friendsActor.snapshot()).state).toBe("friendSheetClosed");
    expect(friendsActor.snapshot().context.friends).toEqual({});

    friends.open({ identity: "k1", ownName: "Kim" });
    expect(friendSheetOf(friendsActor.snapshot())).toEqual({
      state: "showingMember",
      target: { identity: "k1", ownName: "Kim" },
      draft: "",
      error: null,
      canSave: false,
    });

    friends.add();
    expect(friendSheetOf(friendsActor.snapshot())).toMatchObject({
      state: "namingFriend",
      draft: "Kim",
      canSave: true,
    });

    friends.type("   ");
    expect(friendSheetOf(friendsActor.snapshot())).toMatchObject({
      state: "namingFriend",
      draft: "   ",
      canSave: false,
    });

    friends.type("Kimmy");
    expect(friendSheetOf(friendsActor.snapshot())).toMatchObject({ draft: "Kimmy", canSave: true });

    friends.save();
    expect(friendSheetOf(friendsActor.snapshot())).toMatchObject({
      state: "savingFriend",
      draft: "Kimmy",
      canSave: false,
    });
    await friendsActor.settled();
    expect(friendSheetOf(friendsActor.snapshot())).toMatchObject({
      state: "friendSheetClosed",
      error: null,
    });
    expect(friendsActor.snapshot().context.friends).toEqual({ k1: "Kimmy" });
  });
});

describe("friendSheetOf", () => {
  test("initial snapshot is the loading sheet", async () => {
    const { actor } = await setup();
    expect(friendSheetOf(actor.snapshot())).toMatchObject({
      state: "friendSheetClosed",
      target: null,
    });
  });

  test("naming carries the target and the draft, and canSave follows the draft", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(add());
    expect(friendSheetOf(actor.snapshot())).toMatchObject({
      state: "namingFriend",
      target: { identity: "k1", ownName: "Kim" },
      draft: "Kim",
      canSave: true,
    });
    actor.send(type("  "));
    expect(friendSheetOf(actor.snapshot())).toMatchObject({ canSave: false });
    actor.send(type("Kimmy"));
    expect(friendSheetOf(actor.snapshot())).toMatchObject({ draft: "Kimmy", canSave: true });
  });

  test("saving is a busy state with the draft kept", async () => {
    const { actor } = await setup({ add: () => new Promise(() => {}) });
    actor.send(open());
    actor.send(add());
    actor.send(type("Kimmy"));
    actor.send(save());
    expect(friendSheetOf(actor.snapshot())).toMatchObject({
      state: "savingFriend",
      draft: "Kimmy",
      canSave: false,
    });
  });
});
