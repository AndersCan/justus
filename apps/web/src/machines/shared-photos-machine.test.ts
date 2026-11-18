import { describe, expect, test, vi } from "vite-plus/test";
import type { SharedBatch } from "@justus/core";
import {
  sharedPhotosMachine,
  sharedPhotosViewOf,
  type SharedPhotosPort,
} from "./shared-photos-machine";

vi.mock("../gateway", () => ({ gateway: { sharedIn: { remove: vi.fn() } } }));

const batch = (id: string, n: number): SharedBatch => ({
  id,
  receivedAt: "2026-11-18T00:00:00Z",
  photos: Array.from({ length: n }, (_, i) => ({
    name: `${id}-${i}.jpg`,
    size: 1,
    mime: "image/jpeg",
  })) as never,
});

function setup(
  remove: SharedPhotosPort["remove"] = vi.fn(async () => [null, { removed: 1 }]) as never,
) {
  const actor = sharedPhotosMachine.create({ port: { remove } });
  return { actor, remove: remove as ReturnType<typeof vi.fn> };
}
const listed = (batches: SharedBatch[]) =>
  ({ type: "SHARED_PHOTOS_LISTED", payload: { batches } }) as never;
const shown = (welcome: boolean) => ({ type: "PAGE_SHOWN", payload: { welcome } }) as never;
const started = { type: "ADD_STARTED", payload: { folderId: "f" } } as never;
const ended = (failed: number) => ({ type: "ADD_ENDED", payload: { failed } }) as never;
const notNow = { type: "NOT_NOW" } as never;

describe("sharedPhotos", () => {
  test("an empty list never asks", async () => {
    const { actor } = setup();
    actor.send(listed([]));
    await actor.settled();
    expect(actor.state.name).toBe("noSharedPhotos");
  });

  test("a list while choosing does not change the count", async () => {
    const { actor } = setup();
    actor.send(listed([batch("a", 3)]));
    actor.send(listed([batch("a", 3), batch("b", 2)]));
    await actor.settled();
    expect(sharedPhotosViewOf(actor.snapshot()).count).toBe(3);
  });

  test("Not now removes exactly the shown batches", async () => {
    const { actor, remove } = setup();
    actor.send(listed([batch("a", 3)]));
    actor.send(listed([batch("a", 3), batch("b", 2)]));
    actor.send(notNow);
    await actor.settled();
    expect(remove).toHaveBeenCalledWith(["a"]);
    expect(actor.state.name).toBe("choosingAlbumForSharedPhotos");
    expect(sharedPhotosViewOf(actor.snapshot()).batches.map((b) => b.id)).toEqual(["b"]);
  });

  test("a share during the add is asked about after the inbox is cleared", async () => {
    const { actor, remove } = setup();
    actor.send(listed([batch("a", 3)]));
    actor.send(started);
    actor.send(listed([batch("a", 3), batch("b", 2)]));
    actor.send(ended(0));
    await actor.settled();
    expect(remove).toHaveBeenCalledWith(["a"]);
    expect(actor.state.name).toBe("choosingAlbumForSharedPhotos");
    expect(sharedPhotosViewOf(actor.snapshot()).batches.map((b) => b.id)).toEqual(["b"]);
  });

  test("a share during the add waits for the welcome to end", async () => {
    const { actor } = setup();
    actor.send(listed([batch("a", 3)]));
    actor.send(started);
    actor.send(shown(true));
    actor.send(listed([batch("a", 3), batch("b", 2)]));
    actor.send(ended(0));
    await actor.settled();
    expect(actor.state.name).toBe("noSharedPhotos");
    actor.send(shown(false));
    await actor.settled();
    expect(actor.state.name).toBe("choosingAlbumForSharedPhotos");
  });

  test("a failed add removes nothing and does not ask again until the next list", async () => {
    const { actor, remove } = setup();
    actor.send(listed([batch("a", 3)]));
    actor.send(started);
    actor.send(ended(1));
    actor.send(shown(false));
    await actor.settled();
    expect(remove).not.toHaveBeenCalled();
    expect(actor.state.name).toBe("noSharedPhotos");
  });

  test("a page shown while no welcome is up opens nothing when nothing waits", async () => {
    const { actor } = setup();
    actor.send(shown(false));
    await actor.settled();
    expect(actor.state.name).toBe("noSharedPhotos");
  });

  test("events outside their state are ignored", async () => {
    const { actor, remove } = setup();
    actor.send(ended(0));
    actor.send(notNow);
    await actor.settled();
    expect(actor.state.name).toBe("noSharedPhotos");
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("sharedPhotos errors", () => {
  test.each([
    ["an error", async () => [new Error("boom"), null]],
    ["a throw", async () => Promise.reject(new Error("boom"))],
  ])("a remove that fails with %s warns and ends without asking again", async (_n, remove) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { actor } = setup(remove as never);
    actor.send(listed([batch("a", 3)]));
    actor.send(notNow);
    await actor.settled();
    actor.send(shown(false));
    await actor.settled();
    expect(warn).toHaveBeenCalledWith("justus:share-in.remove-failed", "boom");
    expect(actor.state.name).toBe("noSharedPhotos");
    expect(sharedPhotosViewOf(actor.snapshot()).asking).toBe(false);
    warn.mockRestore();
  });

  test("a failed add warns with the count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { actor } = setup();
    actor.send(listed([batch("a", 3)]));
    actor.send(started);
    actor.send(ended(2));
    await actor.settled();
    expect(warn).toHaveBeenCalledWith("justus:share-in.add-failed", 2);
    warn.mockRestore();
  });
});
