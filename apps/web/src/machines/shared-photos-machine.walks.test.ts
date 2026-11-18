import { recordRuns } from "@mantaq/inspect/record";
import { expect, test, vi } from "vite-plus/test";
import type { SharedBatch } from "@justus/core";
import {
  sharedPhotosMachine,
  sharedPhotosViewOf,
  type SharedPhotosPort,
} from "./shared-photos-machine";

const make = recordRuns(sharedPhotosMachine);

const batch = (id: string, n: number): SharedBatch => ({
  id,
  receivedAt: "2026-11-18T00:00:00Z",
  photos: Array.from({ length: n }, (_, i) => ({
    name: `${id}-${i}.jpg`,
    size: 1,
    mime: "image/jpeg",
  })) as never,
});
const okPort = () =>
  ({ remove: vi.fn(async () => [null, { removed: 1 }]) }) as never as {
    remove: ReturnType<typeof vi.fn>;
  } & SharedPhotosPort;
const listed = (batches: SharedBatch[]) =>
  ({ type: "SHARED_PHOTOS_LISTED", payload: { batches } }) as never;

test("Ada shares three photos from Google Photos and adds them to Summer", async () => {
  const port = okPort();
  const actor = make.create({ port });
  actor.send(listed([batch("a", 3)]));
  expect(actor.state.name).toBe("choosingAlbumForSharedPhotos");
  expect(sharedPhotosViewOf(actor.snapshot()).count).toBe(3);
  actor.send({ type: "ADD_STARTED", payload: { folderId: "summer" } });
  actor.send({ type: "ADD_ENDED", payload: { failed: 0 } });
  await actor.settled();
  expect(port.remove).toHaveBeenCalledWith(["a"]);
  expect(actor.state.name).toBe("noSharedPhotos");
});

test("Ada closes the sheet, and the shared copies are removed", async () => {
  const port = okPort();
  const actor = make.create({ port });
  actor.send(listed([batch("a", 3)]));
  actor.send({ type: "NOT_NOW" });
  await actor.settled();
  expect(port.remove).toHaveBeenCalledWith(["a"]);
  expect(actor.state.name).toBe("noSharedPhotos");
});

test("Ada shares two more while the sheet is open, and the sheet asks for those after", async () => {
  const port = okPort();
  const actor = make.create({ port });
  actor.send(listed([batch("a", 3)]));
  actor.send(listed([batch("a", 3), batch("b", 2)]));
  actor.send({ type: "NOT_NOW" });
  await actor.settled();
  expect(actor.state.name).toBe("choosingAlbumForSharedPhotos");
  expect(sharedPhotosViewOf(actor.snapshot()).count).toBe(2);
});

test("A share on a new phone waits until the welcome is done", async () => {
  const actor = make.create({ port: okPort() });
  actor.send({ type: "PAGE_SHOWN", payload: { welcome: true } });
  actor.send(listed([batch("a", 3)]));
  expect(actor.state.name).toBe("noSharedPhotos");
  actor.send({ type: "PAGE_SHOWN", payload: { welcome: false } });
  expect(actor.state.name).toBe("choosingAlbumForSharedPhotos");
});

test("One photo fails to add, so the shared photos stay in the inbox", async () => {
  const port = okPort();
  const actor = make.create({ port });
  actor.send(listed([batch("a", 3)]));
  actor.send({ type: "ADD_STARTED", payload: { folderId: "summer" } });
  actor.send({ type: "ADD_ENDED", payload: { failed: 1 } });
  await actor.settled();
  expect(port.remove).not.toHaveBeenCalled();
  expect(actor.state.name).toBe("noSharedPhotos");
});
