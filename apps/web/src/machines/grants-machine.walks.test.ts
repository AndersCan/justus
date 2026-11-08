import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createGrantsActor } from "./grants-machine";

const make = recordRuns(createGrantsActor);

test("Anna lets Nils see her photos", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "REFRESH" });
  actor.inject({
    type: "SHARE_LIST_LOADED",
    payload: { records: [{ peerId: "nils", serveTo: "undecided" }], due: [] },
  });
  await actor.settled();
  actor.send({ type: "SHARE_CHOICE_MADE", payload: { peerId: "nils", kind: "grant" } });
  actor.inject({ type: "SHARE_CHOICE_SAVED" });
  actor.inject({
    type: "SHARE_LIST_LOADED",
    payload: { records: [{ peerId: "nils", serveTo: "granted" }], due: [] },
  });
  await actor.settled();
  expect(actor.state.name).toBe("showingShareList");
});
