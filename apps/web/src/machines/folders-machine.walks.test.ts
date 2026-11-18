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

const listed = {
  type: "ALBUMS_LOADED",
  payload: { folders: [], asks: [], offers: [], activeId: null },
} as const;

test("Ada hands the album to Ben and waits for his phone", async () => {
  const actor = make.create();
  actor.send({ type: "REFRESH" });
  actor.inject(listed);
  await actor.settled();
  actor.send({
    type: "HAND_OVER_ALBUM",
    payload: { folderId: "summer", name: "Summer", memberKey: "ben" },
  });
  actor.inject(listed);
  await actor.settled();
  expect(actor.state.name).toBe("showingAlbums");
});

test("Ada taps Stay Admin and the album stays hers", async () => {
  const actor = make.create();
  actor.send({ type: "REFRESH" });
  actor.inject(listed);
  await actor.settled();
  actor.send({ type: "STAY_ADMIN", payload: { folderId: "summer", name: "Summer" } });
  actor.inject(listed);
  await actor.settled();
  expect(actor.state.name).toBe("showingAlbums");
});

test("The hand over fails and the album stays", async () => {
  const actor = make.create();
  actor.send({ type: "REFRESH" });
  actor.inject(listed);
  await actor.settled();
  actor.send({
    type: "HAND_OVER_ALBUM",
    payload: { folderId: "summer", name: "Summer", memberKey: "ben" },
  });
  actor.inject({ type: "ALBUM_CHANGE_FAILED", payload: { message: "no" } });
  await actor.settled();
  expect(actor.state.name).toBe("couldNotChangeAlbum");
});
