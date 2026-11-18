import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import type { AddSource } from "./gallery-machine";
import { pickedPhotosMachine, pickedPhotosViewOf } from "./picked-photos-machine";

const make = recordRuns(pickedPhotosMachine);

function path(name: string): AddSource {
  return { kind: "path", path: `/cache/${name}`, name };
}
const five = ["p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg", "p5.jpg"].map(path);

test("Ada picks 5 photos on Photos and adds them to Summer", async () => {
  const actor = make.create();
  actor.send({ type: "PHOTOS_PICKED", payload: { photos: five } });
  await actor.settled();
  expect(actor.state.name).toBe("choosingAlbumForPickedPhotos");
  expect(pickedPhotosViewOf(actor.snapshot()).count).toBe(5);
  expect(actor.snapshot().context.photos).toEqual(five);
  actor.send({ type: "ADD_STARTED" });
  await actor.settled();
  expect(actor.state.name).toBe("noPickedPhotos");
  expect(actor.snapshot().context.photos).toEqual([]);
});

test("Ada picks photos, then closes the sheet", async () => {
  const actor = make.create();
  actor.send({ type: "PHOTOS_PICKED", payload: { photos: five.slice(0, 2) } });
  actor.send({ type: "CANCEL" });
  await actor.settled();
  expect(actor.state.name).toBe("noPickedPhotos");
  expect(actor.snapshot().context.photos).toEqual([]);
});

test("A pick with no photos opens no sheet", async () => {
  const actor = make.create();
  actor.send({ type: "PHOTOS_PICKED", payload: { photos: [] } });
  await actor.settled();
  expect(actor.state.name).toBe("noPickedPhotos");
});
