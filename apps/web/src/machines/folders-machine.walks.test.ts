import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { foldersMachine } from "./folders-machine";

const make = recordRuns(foldersMachine);

test("Anna creates the album Trip and sees it in her albums", async () => {
  const actor = make.create();
  actor.send({ type: "REFRESH" });
  actor.inject({
    type: "ALBUMS_LOADED",
    payload: { folders: [], asks: [], offers: [], activeId: null },
  });
  await actor.settled();
  actor.send({ type: "CREATE_FOLDER", payload: { name: "Trip" } });
  actor.inject({
    type: "CREATED",
    payload: { folder: { id: "trip", name: "Trip" } as never },
  });
  await actor.settled();
  expect(actor.state.name).toBe("showingAlbums");
});
