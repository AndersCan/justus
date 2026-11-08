import { VirtualClock } from "@mantaq/core";
import { recordRuns } from "@mantaq/inspect/record";
import type { Photo } from "@justus/core";
import { expect, test } from "vite-plus/test";
import { createLightboxActor } from "./lightbox-machine";

const make = recordRuns(createLightboxActor);

function photo(id: string, name: string): Photo {
  return {
    id,
    folderId: "trip",
    url: `blob:${id}`,
    name,
    mime: "image/jpeg",
    size: 1,
    addedAt: 0,
    member: { key: "anna", name: "Anna" },
  };
}

const beach = photo("p1", "beach.jpg");
const picnic = photo("p2", "picnic.jpg");
const photos = [beach, picnic];

test("Anna opens a photo and steps to the next one", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "OPEN", payload: { photo: beach, within: photos } });
  actor.send({ type: "STEP", payload: { dir: 1, photos } });
  await actor.settled();
  expect(actor.state.name).toBe("showingPhoto");
  expect(actor.snapshot().context.photo).toEqual(picnic);
});

test("Anna opens Who has this photo, then closes it", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "OPEN", payload: { photo: beach, within: photos } });
  actor.send({ type: "OPEN_HOLDERS" });
  await actor.settled();
  expect(actor.state.name).toBe("showingWhoHasThisPhoto");
  actor.send({ type: "CLOSE_HOLDERS" });
  await actor.settled();
  expect(actor.state.name).toBe("showingPhoto");
  expect(actor.snapshot().context.photo).toEqual(beach);
});

test("The open photo is deleted on another phone, and the viewer closes", async () => {
  const actor = make({ clock: VirtualClock() });
  actor.send({ type: "OPEN", payload: { photo: beach, within: photos } });
  actor.send({ type: "PHOTO_LIST_CHANGED", payload: { photos: [picnic] } });
  await actor.settled();
  expect(actor.state.name).toBe("noPhotoOpen");
  expect(actor.snapshot().context.photo).toBeUndefined();
});
