import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import { describe, expect, test } from "vite-plus/test";
import {
  JOIN_WAIT_MS,
  OFFER_GONE_CODE,
  createFriendOfferActor,
  type FriendOffer,
  type FriendOfferPort,
} from "./friend-offer-machine";

const OFFER: FriendOffer = {
  code: "c".repeat(64),
  owner: "n".repeat(64),
  albumName: "Lisbon trip",
  ownerName: "Nils",
};

const make = recordRuns(createFriendOfferActor);

function setup(port?: FriendOfferPort) {
  const clock = VirtualClock();
  const actor = make({ clock, port });
  const outputs: { type: string; payload?: unknown }[] = [];
  onOutput(actor, (e) =>
    outputs.push({ type: e.type, payload: (e as { payload?: unknown }).payload }),
  );
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  return { clock, actor, outputs, send };
}

const sent = (code?: string): FriendOfferPort => ({
  joinOffer: async () =>
    code === undefined ? [null, { ok: true }] : [Object.assign(new Error("e"), { code }), null],
});

test("Join sends the code and owner and shows Joining", async () => {
  const calls: unknown[][] = [];
  const s = setup({
    joinOffer: async (...args) => {
      calls.push(args);
      return [null, { ok: true }];
    },
  });
  await s.send("join", { offer: OFFER });
  expect(s.actor.state.name).toBe("joiningFriendsAlbum");
  expect(calls).toEqual([[OFFER.code, OFFER.owner]]);
});

test("the Admin's accept opens the album", async () => {
  const s = setup(sent());
  await s.send("join", { offer: OFFER });
  await s.send("askAnswered", { code: OFFER.code, answer: "accepted", folderId: "f9" });
  expect(s.actor.state.name).toBe("showingFriendOffers");
  expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
});

test.each([
  ["another invite's answer", { code: "z".repeat(64), answer: "accepted", folderId: "f9" }],
  ["a decline", { code: OFFER.code, answer: "declined" }],
  ["an accept with no album", { code: OFFER.code, answer: "accepted" }],
])("%s keeps waiting", async (_n, answer) => {
  const s = setup(sent());
  await s.send("join", { offer: OFFER });
  await s.send("askAnswered", answer);
  expect(s.actor.state.name).toBe("joiningFriendsAlbum");
  expect(s.outputs).toEqual([]);
});

test("an answer with no join in progress is ignored", async () => {
  const s = setup();
  await s.send("askAnswered", { code: OFFER.code, answer: "accepted", folderId: "f9" });
  expect(s.actor.state.name).toBe("showingFriendOffers");
  expect(s.outputs).toEqual([]);
});

test("OFFER_GONE returns to the list with no message", async () => {
  const s = setup(sent(OFFER_GONE_CODE));
  await s.send("join", { offer: OFFER });
  expect(s.actor.state.name).toBe("showingFriendOffers");
  expect(s.outputs).toEqual([]);
});

test.each([["other-error"], [""]])("error %j returns with couldNotJoin", async (code) => {
  const s = setup(sent(code));
  await s.send("join", { offer: OFFER });
  expect(s.actor.state.name).toBe("showingFriendOffers");
  expect(s.outputs).toEqual([
    { type: "couldNotJoin", payload: { albumName: "Lisbon trip", ownerName: "Nils" } },
  ]);
});

test("a thrown invoke returns with couldNotJoin", async () => {
  const s = setup({
    joinOffer: async () => {
      throw new Error("boom");
    },
  });
  await s.send("join", { offer: OFFER });
  expect(s.outputs.map((o) => o.type)).toEqual(["couldNotJoin"]);
});

test("30 seconds with no answer returns with couldNotJoin", async () => {
  const s = setup(sent());
  await s.send("join", { offer: OFFER });
  s.clock.advance(JOIN_WAIT_MS - 1);
  await s.actor.settled();
  expect(s.actor.state.name).toBe("joiningFriendsAlbum");
  s.clock.advance(1);
  await s.actor.settled();
  expect(s.actor.state.name).toBe("showingFriendOffers");
  expect(s.outputs.map((o) => o.type)).toEqual(["couldNotJoin"]);
});

test("an answer inside 30 seconds cancels the timeout", async () => {
  const s = setup(sent());
  await s.send("join", { offer: OFFER });
  s.clock.advance(10_000);
  await s.send("askAnswered", { code: OFFER.code, answer: "accepted", folderId: "f9" });
  s.clock.advance(JOIN_WAIT_MS);
  await s.actor.settled();
  expect(s.outputs.map((o) => o.type)).toEqual(["openAlbum"]);
});

test("Join again after a timeout works", async () => {
  const s = setup(sent());
  await s.send("join", { offer: OFFER });
  s.clock.advance(JOIN_WAIT_MS);
  await s.actor.settled();
  await s.send("join", { offer: OFFER });
  expect(s.actor.state.name).toBe("joiningFriendsAlbum");
});

test("join is ignored while joining", async () => {
  const s = setup(sent());
  await s.send("join", { offer: OFFER });
  await s.send("join", { offer: { ...OFFER, albumName: "Other" } });
  expect(s.actor.snapshot().payload).toEqual({ offer: OFFER });
});

describe("friend offer design", () => {
  const target = (port?: FriendOfferPort) => ({
    id: "friendOffer",
    create: () => createFriendOfferActor({ clock: VirtualClock(), port }),
    payloads: {
      join: [{ offer: OFFER }],
      askAnswered: [{ code: OFFER.code, answer: "accepted" as const, folderId: "f9" }],
    },
  });
  test("has no design errors", () => {
    expectNoDesignErrors(target());
  });
  test("reaches every state", () => {
    expectAllStatesReached(target());
  });
});
