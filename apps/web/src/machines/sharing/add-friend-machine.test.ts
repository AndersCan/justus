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

const ok: [unknown, unknown] = [null, { ok: true }];
const waiting: [unknown, unknown] = [null, { ok: true, waiting: true }];

async function openAndTick(s: ReturnType<typeof setup>, identities: string[]) {
  await s.send("openPicker", OPEN);
  for (const identity of identities) await s.send("toggleFriend", { identity });
}

const ticked = (s: ReturnType<typeof setup>) => s.actor.snapshot().context.ticked;

describe("openPicker", () => {
  test("lists friends who are not members, sorted by name, none ticked", async () => {
    const s = setup();
    await s.send("openPicker", { ...OPEN, memberIdentities: [OLE] });
    expect(s.actor.state.name).toBe("choosingFriends");
    expect(choices(s).map((c) => c.name)).toEqual(["Ånna", "Kari"]);
    expect(ticked(s)).toEqual([]);
  });

  test("one choice is not ticked either", async () => {
    const s = setup();
    await s.send("openPicker", { ...OPEN, memberIdentities: [OLE, ANNA] });
    expect(choices(s)).toHaveLength(1);
    expect(ticked(s)).toEqual([]);
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

  test("opens a fresh list from showingWhoWasAsked", async () => {
    const s = setup({ offerAlbum: async () => waiting });
    await openAndTick(s, [KARI]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("showingWhoWasAsked");
    await s.send("openPicker", OPEN);
    expect(s.actor.state.name).toBe("choosingFriends");
    expect(ticked(s)).toEqual([]);
  });
});

describe("toggleFriend", () => {
  test("ticks, then unticks", async () => {
    const s = setup();
    await openAndTick(s, [KARI]);
    expect(ticked(s)).toEqual([KARI]);
    await s.send("toggleFriend", { identity: OLE });
    expect(ticked(s)).toEqual([KARI, OLE]);
    await s.send("toggleFriend", { identity: KARI });
    expect(ticked(s)).toEqual([OLE]);
  });

  test("an unknown identity changes nothing", async () => {
    const s = setup();
    await openAndTick(s, [KARI]);
    await s.send("toggleFriend", { identity: "x".repeat(64) });
    expect(s.actor.state.name).toBe("choosingFriends");
    expect(ticked(s)).toEqual([KARI]);
    expect(choices(s)).toHaveLength(3);
  });
});

describe("pickRole", () => {
  test("with nobody ticked stays on the list and asks no one", async () => {
    const calls: unknown[][] = [];
    const s = setup({
      offerAlbum: async (...args) => {
        calls.push(args);
        return ok;
      },
    });
    await openAndTick(s, []);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("choosingFriends");
    expect(calls).toEqual([]);
  });

  test("untick back to nobody asks no one", async () => {
    const calls: unknown[][] = [];
    const s = setup({
      offerAlbum: async (...args) => {
        calls.push(args);
        return ok;
      },
    });
    await openAndTick(s, [KARI, KARI]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("choosingFriends");
    expect(calls).toEqual([]);
  });

  test("two ticked friends are both asked before either answers, then one output", async () => {
    const starts: unknown[][] = [];
    const releases: ((v: [unknown, unknown]) => void)[] = [];
    const s = setup({
      offerAlbum: (...args) => {
        starts.push(args);
        return new Promise((r) => releases.push(r));
      },
    });
    await openAndTick(s, [OLE, KARI]);
    s.actor.send({ type: "pickRole", payload: { role: "member" } } as never);
    await Promise.resolve();
    expect(s.actor.state.name).toBe("askingFriends");
    expect(starts).toEqual([
      ["f1", KARI, "member"],
      ["f1", OLE, "member"],
    ]);
    for (const release of releases) release(ok);
    await s.actor.settled();
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
    expect(s.outputs).toEqual([
      { type: "friendsAsked", payload: { names: ["Kari", "ole"], role: "member" } },
    ]);
  });

  test("a Viewer is asked with reader and the output names the role", async () => {
    const calls: unknown[][] = [];
    const s = setup({
      offerAlbum: async (...args) => {
        calls.push(args);
        return ok;
      },
    });
    await openAndTick(s, [KARI]);
    await s.send("pickRole", { role: "reader" });
    expect(calls).toEqual([["f1", KARI, "reader"]]);
    expect(s.outputs).toEqual([
      { type: "friendsAsked", payload: { names: ["Kari"], role: "reader" } },
    ]);
  });

  test("one asked and one waiting shows both, with no output", async () => {
    const s = setup({ offerAlbum: async (_f, identity) => (identity === KARI ? ok : waiting) });
    await openAndTick(s, [KARI, OLE]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("showingWhoWasAsked");
    expect(s.actor.snapshot().payload).toMatchObject({
      role: "member",
      answers: [
        { identity: KARI, name: "Kari", outcome: "asked" },
        { identity: OLE, name: "ole", outcome: "waiting" },
      ],
    });
    expect(s.outputs).toEqual([]);
  });

  test("waiting: false still counts as asked", async () => {
    const s = setup({ offerAlbum: async () => [null, { ok: true, waiting: false }] });
    await openAndTick(s, [KARI]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
    expect(s.outputs).toEqual([
      { type: "friendsAsked", payload: { names: ["Kari"], role: "member" } },
    ]);
  });

  test("an error wins over waiting", async () => {
    const s = setup({ offerAlbum: async () => [new Error("no"), { waiting: true }] });
    await openAndTick(s, [KARI]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.snapshot().payload).toMatchObject({
      answers: [{ outcome: "unreachable" }],
    });
  });

  test("a refusal says refused for that friend only", async () => {
    const s = setup({
      offerAlbum: async (_f, identity) =>
        identity === KARI
          ? [Object.assign(new Error("no"), { code: FRIEND_REFUSED_CODE }), null]
          : ok,
    });
    await openAndTick(s, [KARI, OLE]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("showingWhoWasAsked");
    expect(s.actor.snapshot().payload).toMatchObject({
      answers: [
        { name: "Kari", outcome: "refused" },
        { name: "ole", outcome: "asked" },
      ],
    });
    expect(s.outputs).toEqual([]);
  });

  test.each([["justus.photos/friend-unreachable"], ["something-else"], [undefined]])(
    "error %s says unreachable",
    async (code) => {
      const s = setup(failing(code));
      await openAndTick(s, [KARI]);
      await s.send("pickRole", { role: "member" });
      expect(s.actor.snapshot().payload).toMatchObject({
        answers: [{ outcome: "unreachable" }],
      });
    },
  );

  test("a thrown invoke says unreachable for that friend", async () => {
    const s = setup({
      offerAlbum: async (_f, identity) => {
        if (identity === KARI) throw new Error("boom");
        return ok;
      },
    });
    await openAndTick(s, [KARI, OLE]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.snapshot().payload).toMatchObject({
      answers: [
        { name: "Kari", outcome: "unreachable" },
        { name: "ole", outcome: "asked" },
      ],
    });
  });
});

describe("closePicker", () => {
  test("closes from choosingFriends", async () => {
    const s = setup();
    await openAndTick(s, []);
    await s.send("closePicker");
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });

  test("closes from showingWhoWasAsked", async () => {
    const s = setup(failing());
    await openAndTick(s, [KARI]);
    await s.send("pickRole", { role: "member" });
    expect(s.actor.state.name).toBe("showingWhoWasAsked");
    await s.send("closePicker");
    expect(s.actor.state.name).toBe("showingPeopleWithAddFriend");
  });

  test("is ignored while the friends are being asked", async () => {
    const s = setup({ offerAlbum: () => new Promise(() => {}) });
    await openAndTick(s, [KARI]);
    s.actor.send({ type: "pickRole", payload: { role: "member" } } as never);
    await Promise.resolve();
    s.actor.send({ type: "closePicker" } as never);
    await Promise.resolve();
    expect(s.actor.state.name).toBe("askingFriends");
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
      toggleFriend: [{ identity: KARI }, { identity: OLE }],
      pickRole: [{ role: "member" }, { role: "reader" }],
      friendsAnswered: [
        { answers: [{ identity: KARI, name: "Kari", outcome: "asked" }] },
        {
          answers: [
            { identity: KARI, name: "Kari", outcome: "asked" },
            { identity: OLE, name: "ole", outcome: "waiting" },
          ],
        },
      ],
    },
  });
  test("has no design errors", () => {
    expectNoDesignErrors(target());
  });
  test("reaches every state", () => {
    expectAllStatesReached({
      ...target(),
      tests: [
        {
          name: "Nils ticks Kari and Ole; Ole's phone is off",
          steps: [
            { kind: "event" as const, event: "openPicker", payload: OPEN },
            { kind: "event" as const, event: "toggleFriend", payload: { identity: KARI } },
            { kind: "event" as const, event: "toggleFriend", payload: { identity: OLE } },
            { kind: "event" as const, event: "pickRole", payload: { role: "member" } },
          ],
        },
      ],
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
