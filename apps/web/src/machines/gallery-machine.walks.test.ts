import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import { expect, test } from "vite-plus/test";
import { createGalleryActor, galleryViewModel } from "./gallery-machine";

const make = recordRuns(createGalleryActor);

const beach = { id: "p1", name: "beach.jpg", folderId: "trip" };
const picnic = { id: "p2", name: "picnic.jpg", folderId: "trip" };

test("Anna opens Trip and sees its photos", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "LOAD" });
  actor.inject({ type: "PHOTOS_LOADED", payload: { photos: [beach, picnic] } });
  await actor.settled();
  const view = galleryViewModel(actor.snapshot(), null);
  expect(view.state).toBe("showingPhotos");
  expect(view.photos).toEqual([beach, picnic]);
});

test("Anna removes a photo and it is gone", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "LOAD" });
  actor.inject({ type: "PHOTOS_LOADED", payload: { photos: [beach, picnic] } });
  await actor.settled();
  actor.send({ type: "REMOVE", payload: { id: beach.id, folderId: beach.folderId } });
  actor.inject({ type: "REMOVED", payload: { id: beach.id, folderId: beach.folderId } });
  await actor.settled();
  const view = galleryViewModel(actor.snapshot(), null);
  expect(view.state).toBe("showingPhotos");
  expect(view.photos).toEqual([picnic]);
});

test("Anna removes a photo, it fails, and the photo stays", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "LOAD" });
  actor.inject({ type: "PHOTOS_LOADED", payload: { photos: [beach, picnic] } });
  await actor.settled();
  actor.send({ type: "REMOVE", payload: { id: beach.id, folderId: beach.folderId } });
  actor.inject({ type: "REMOVE_FAILED", payload: { message: "The album could not be reached" } });
  await actor.settled();
  const view = galleryViewModel(actor.snapshot(), null);
  expect(view.state).toBe("couldNotRemovePhoto");
  expect(view.photos).toEqual([beach, picnic]);
});
