import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import { describe, expect, test } from "vite-plus/test";
import {
  FRIEND_REFUSED_CODE,
  createAddFriendActor,
  friendChoices,
  type AddFriendPort,
} from "./add-friend-machine";

const KARI = "k".repeat(64);
const OLE = "o".repeat(64);
const ANNA = "a".repeat(64);
const FRIENDS = [
  { identity: KARI, name: "Kari" },
  { identity: OLE, name: "ole" },
  { identity: ANNA, name: "Ånna" },
];
const OPEN = { folderId: "f1", albumName: "Lisbon trip", friends: FRIENDS, memberIdentities: [] };

const make = recordRuns(createAddFriendActor);

function setup(port?: AddFriendPort) {
  const actor = make({ clock: VirtualClock(), port });
  const outputs: { type: string; payload?: unknown }[] = [];
  onOutput(actor, (e) =>
    outputs.push({ type: e.type, payload: (e as { payload?: unknown }).payload }),
  );
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  return { actor, outputs, send };
}

const choices = (s: ReturnType<typeof setup>) =>
  (s.actor.snapshot().payload as { choices: { identity: string; name: string }[] }).choices;

const failing = (code?: string): AddFriendPort => ({
  offerAlbum: async () => [Object.assign(new Error("no"), { code }), null],
});

describe("openPicker", () => {
  test("lists friends who are not members, sorted by name", async () => {
    const s = setup();
    await s.send("openPicker", { ...OPEN, memberIdentities: [OLE] });
    expect(s.actor.state.name).toBe("choosingFriend");
    expect(choices(s).map((c) => c.name)).toEqual(["Ånna", "Kari"]);
  });

  test("sorts ignoring case", async () => {
    const s = setup();
    await s.send("openPicker", OPEN);
    expect(choices(s).map((c) => c.name)).toEqual(["Ånna", "Kari", "ole"]);
  });

  test("friendChoices drops members and sorts", () => {
    expect(friendChoices(FRIENDS, [OLE]).map((c) => c.name)).toEqual(["Ånna", "Kari"]);
    expect(friendChoices([], [OLE])).toEqual([]);
  });

  test("no friends leaves the actor in showingPeopleWithAddFriend", async () => {
    const s = setup();
    await s.send("openPicker", { ...OPEN, friends: [] });
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });

  test("every friend already a member leaves the actor in showingPeopleWithAddFriend", async () => {
    const s = setup();
    await s.send("openPicker", { ...OPEN, memberIdentities: [KARI, OLE, ANNA] });
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });

  test("opens again from inviteWaitingForFriend", async () => {
    const s = setup({ offerAlbum: async () => [null, { ok: true, waiting: true }] });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    await s.send("openPicker", OPEN);
    expect(s.actor.state.name).toBe("choosingFriend");
  });

  test("opens again from couldNotReachFriend", async () => {
    const s = setup(failing());
    await s.send("openPicker", OPEN);
    expect(s.actor.state.name).toBe("choosingFriend");
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("couldNotReachFriend");
    await s.send("openPicker", OPEN);
    expect(s.actor.state.name).toBe("choosingFriend");
  });
});

describe("pickFriend", () => {
  test("asks the friend's phone and closes with a toast output on success", async () => {
    const calls: unknown[][] = [];
    const s = setup({
      offerAlbum: async (...args) => {
        calls.push(args);
        return [null, { ok: true }];
      },
    });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(calls).toEqual([["f1", KARI, "member"]]);
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
    expect(s.outputs).toEqual([{ type: "friendAsked", payload: { name: "Kari", role: "member" } }]);
  });

  test("picking a friend asks for the role before anyone is asked", async () => {
    const calls: unknown[][] = [];
    const s = setup({
      offerAlbum: async (...args) => {
        calls.push(args);
        return [null, { ok: true }];
      },
    });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    expect(s.actor.state.name).toBe("choosingFriendRole");
    expect(s.actor.snapshot().payload).toMatchObject({ identity: KARI, name: "Kari" });
    expect(calls).toEqual([]);
  });

  test("a Viewer is asked with reader and the output names the role", async () => {
    const calls: unknown[][] = [];
    const s = setup({
      offerAlbum: async (...args) => {
        calls.push(args);
        return [null, { ok: true }];
      },
    });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "reader" });
    expect(calls).toEqual([["f1", KARI, "reader"]]);
    expect(s.outputs).toEqual([{ type: "friendAsked", payload: { name: "Kari", role: "reader" } }]);
  });

  test("a kept invite lands in inviteWaitingForFriend with no toast", async () => {
    const s = setup({ offerAlbum: async () => [null, { ok: true, waiting: true }] });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("inviteWaitingForFriend");
    expect(s.actor.snapshot().payload).toMatchObject({ identity: KARI, name: "Kari" });
    expect(s.outputs).toEqual([]);
  });

  test("waiting: false still counts as asked", async () => {
    const s = setup({ offerAlbum: async () => [null, { ok: true, waiting: false }] });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
    expect(s.outputs).toEqual([{ type: "friendAsked", payload: { name: "Kari", role: "member" } }]);
  });

  test("an error wins over waiting", async () => {
    const s = setup({ offerAlbum: async () => [new Error("no"), { waiting: true }] });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("couldNotReachFriend");
  });

  test("shows lookingForFriend while the phone is asked", async () => {
    let release: (v: [unknown, unknown]) => void = () => {};
    const s = setup({ offerAlbum: () => new Promise((r) => (release = r)) });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    s.actor.send({ type: "pickRole", payload: { role: "member" } } as never);
    await Promise.resolve();
    expect(s.actor.state.name).toBe("lookingForFriend");
    expect(s.actor.snapshot().payload).toMatchObject({ identity: KARI, name: "Kari" });
    release([null, { ok: true }]);
    await s.actor.settled();
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });

  test("an unknown identity is ignored", async () => {
    const s = setup();
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: "x".repeat(64) });
    expect(s.actor.state.name).toBe("choosingFriend");
    expect(choices(s)).toHaveLength(3);
  });

  test("a refusal says refused", async () => {
    const s = setup(failing(FRIEND_REFUSED_CODE));
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("couldNotReachFriend");
    expect(s.actor.snapshot().payload).toMatchObject({ reason: "refused", name: "Kari" });
    expect(s.outputs).toEqual([]);
  });

  test.each([["justus.photos/friend-unreachable"], ["something-else"], [undefined]])(
    "error %s says unreachable",
    async (code) => {
      const s = setup(failing(code));
      await s.send("openPicker", OPEN);
      await s.send("pickFriend", { identity: KARI });
      await s.send("pickRole", { role: "member" });
      expect(s.actor.snapshot().payload).toMatchObject({ reason: "unreachable" });
    },
  );

  test("a thrown invoke says unreachable", async () => {
    const s = setup({
      offerAlbum: async () => {
        throw new Error("boom");
      },
    });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    expect(s.actor.snapshot().payload).toMatchObject({ reason: "unreachable" });
  });
});

describe("closePicker", () => {
  test.each(["choosingFriend", "choosingFriendRole", "couldNotReachFriend"] as const)(
    "closes from %s",
    async (name) => {
      const s = setup(failing());
      await s.send("openPicker", OPEN);
      if (name !== "choosingFriend") await s.send("pickFriend", { identity: KARI });
      if (name === "couldNotReachFriend") await s.send("pickRole", { role: "member" });
      expect(s.actor.state.name).toBe(name);
      await s.send("closePicker");
      expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
    },
  );

  test("closes from inviteWaitingForFriend", async () => {
    const s = setup({ offerAlbum: async () => [null, { ok: true, waiting: true }] });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    await s.send("pickRole", { role: "member" });
    await s.send("closePicker");
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });

  test("is ignored while the friend is being asked", async () => {
    const s = setup({ offerAlbum: () => new Promise(() => {}) });
    await s.send("openPicker", OPEN);
    await s.send("pickFriend", { identity: KARI });
    s.actor.send({ type: "pickRole", payload: { role: "member" } } as never);
    await Promise.resolve();
    s.actor.send({ type: "closePicker" } as never);
    await Promise.resolve();
    expect(s.actor.state.name).toBe("lookingForFriend");
  });

  test("is ignored when nothing is open", async () => {
    const s = setup();
    await s.send("closePicker");
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });
});

describe("choices (property)", () => {
  test("are exactly the non-members, sorted by name", async () => {
    const ids = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));
    const names = ["kari", "Kari", "ole", "Ånna", "anna", "Zed", "b"];
    let seed = 167;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 100; run++) {
      const friends = ids
        .filter(() => next(2) === 0)
        .map((identity) => ({ identity, name: names[next(names.length)] }));
      const memberIdentities = ids.filter(() => next(2) === 0);
      const s = setup();
      await s.send("openPicker", { ...OPEN, friends, memberIdentities });
      const expected = friends.filter((f) => !memberIdentities.includes(f.identity));
      if (expected.length === 0) {
        expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
        continue;
      }
      const got = choices(s);
      expect(got.map((c) => c.identity).sort()).toEqual(expected.map((c) => c.identity).sort());
      for (let k = 1; k < got.length; k++) {
        expect(
          got[k - 1].name.localeCompare(got[k].name, undefined, { sensitivity: "base" }),
        ).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe("add friend design", () => {
  const target = () => ({
    id: "addFriend",
    create: () => createAddFriendActor({ clock: VirtualClock() }),
    payloads: {
      openPicker: [OPEN, { ...OPEN, friends: [] }],
      pickFriend: [{ identity: KARI }],
      pickRole: [{ role: "member" }, { role: "reader" }],
    },
  });
  test("has no design errors", () => {
    expectNoDesignErrors(target());
  });
  test("reaches every state", () => {
    expectAllStatesReached({
      ...target(),
      create: () =>
        createAddFriendActor({
          clock: VirtualClock(),
          port: {
            offerAlbum: async (_f, identity) =>
              identity === KARI ? [new Error("x"), null] : [null, { ok: true, waiting: true }],
          },
        }),
    });
  });
});
