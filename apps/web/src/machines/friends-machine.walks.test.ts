import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createFriendsActor } from "./friends-machine";

const make = recordRuns(createFriendsActor);

test("Anna taps Nils in Trip and saves him as a friend", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.inject({ type: "FRIENDS_LOADED", payload: { friends: [] } });
  await actor.settled();
  actor.send({ type: "OPEN", payload: { target: { identity: "nils", ownName: "Nils" } } });
  actor.send({ type: "ADD" });
  actor.send({ type: "SAVE" });
  actor.inject({
    type: "SAVED",
    payload: { friend: { identity: "nils", name: "Nils" } },
  });
  await actor.settled();
  expect(actor.state.name).toBe("friendSheetClosed");
});

test("Anna removes Nils from her friends", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.inject({
    type: "FRIENDS_LOADED",
    payload: { friends: [{ identity: "nils", name: "Nils" }] },
  });
  await actor.settled();
  actor.send({ type: "REMOVE", payload: { identity: "nils" } });
  actor.inject({ type: "REMOVED" });
  await actor.settled();
  expect(actor.state.name).toBe("friendSheetClosed");
});

test("Anna renames Ben B to Ben", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.inject({
    type: "FRIENDS_LOADED",
    payload: { friends: [{ identity: "ben", name: "Ben B" }] },
  });
  await actor.settled();
  actor.send({ type: "OPEN", payload: { target: { identity: "ben", ownName: "Ben" } } });
  actor.send({ type: "RENAME" });
  actor.send({ type: "TYPE", payload: { text: "Ben" } });
  actor.send({ type: "SAVE" });
  actor.inject({
    type: "SAVED",
    payload: { friend: { identity: "ben", name: "Ben" } },
  });
  await actor.settled();
  expect(actor.state.name).toBe("friendSheetClosed");
});
