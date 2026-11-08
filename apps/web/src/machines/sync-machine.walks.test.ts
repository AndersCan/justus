import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createSyncActor } from "./sync-machine";

const make = recordRuns(createSyncActor);

test("Anna opens Trip's Invite & members page and it is up to date", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "REFRESH" });
  actor.inject({
    type: "ALBUM_CHECKED",
    payload: {
      status: {
        folder: { id: "trip", role: "creator" },
        members: [{ key: "anna", name: "Anna", admin: true, connected: true }],
      } as never,
    },
  });
  await actor.settled();
  expect(actor.state.name).toBe("showingAlbum");
});
