import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { peopleMachine } from "./people-machine";

const make = recordRuns(peopleMachine);

test("Anna opens People, removes Nils, takes back invite to Kim", async () => {
  const actor = make.create();
  actor.send({ type: "OPEN" });
  await actor.settled();
  actor.send({ type: "REMOVE_MEMBER", payload: { folderId: "trip", memberKey: "nils" } });
  actor.inject({ type: "REMOVED" });
  await actor.settled();
  actor.send({
    type: "TAKE_BACK_INVITE",
    payload: { folderId: "trip", identity: "kim", name: "Kim" },
  });
  actor.inject({ type: "INVITE_TAKEN_BACK", payload: { gone: false } });
  await actor.settled();
  expect(actor.state.name).toBe("showingPeople");
});
