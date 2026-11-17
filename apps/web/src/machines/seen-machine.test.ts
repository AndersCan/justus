import { describe, expect, test, vi } from "vite-plus/test";
import type { SeenRecord } from "@justus/core";
import { seenMachine, isNewPhoto, newCount, seenReady, type SeenPort } from "./seen-machine";

vi.mock("../gateway", () => ({ gateway: { seen: { read: vi.fn(), write: vi.fn() } } }));

const record = (known: Record<string, string[]> = {}, lastAlbum?: string): SeenRecord => ({
  version: 1,
  known,
  ...(lastAlbum === undefined ? {} : { lastAlbum }),
});

async function setup(initial: SeenRecord | Error = record()) {
  const port = {
    read: vi.fn(async () =>
      initial instanceof Error ? [initial, null] : [null, { seen: initial }],
    ),
    write: vi.fn(async () => [null, {}]),
  };
  const actor = seenMachine.create({ port: port as unknown as SeenPort });
  await actor.settled();
  return { actor, port };
}

const listed = (albums: { albumId: string; photoIds: string[] }[]) =>
  ({ type: "ALBUMS_LISTED", payload: { albums } }) as never;
const opened = (albumId: string) => ({ type: "ALBUM_OPENED", payload: { albumId } }) as never;
const looked = (photos: { albumId: string; photoId: string }[]) =>
  ({ type: "PHOTOS_LOOKED", payload: { photos } }) as never;
const ended = () => ({ type: "VISIT_ENDED" }) as never;
const ctxOf = (a: Awaited<ReturnType<typeof setup>>["actor"]) => a.snapshot().context;

describe("seen machine", () => {
  test("reads the saved record on start", async () => {
    const { actor } = await setup(record({ f1: ["a"] }, "f1"));
    expect(seenReady(actor.snapshot())).toBe("ready");
    expect(ctxOf(actor).lastAlbum).toBe("f1");
    expect(ctxOf(actor).knownAtVisitStart).toEqual({ f1: ["a"] });
  });

  test("an album listed with no photos makes no record and no write", async () => {
    const { actor, port } = await setup();
    actor.send(listed([{ albumId: "f1", photoIds: [] }]));
    expect(ctxOf(actor).known).toEqual({});
    expect(port.write).not.toHaveBeenCalled();
  });

  test("a listed album's photos are not new, an id added later is", async () => {
    const { actor, port } = await setup();
    actor.send(listed([{ albumId: "f1", photoIds: ["a"] }]));
    expect(port.write).toHaveBeenCalledWith(record({ f1: ["a"] }));
    const ctx = ctxOf(actor);
    expect(isNewPhoto(ctx, { id: "a", folderId: "f1" })).toBe(false);
    expect(isNewPhoto(ctx, { id: "b", folderId: "f1" })).toBe(true);
    actor.send(listed([{ albumId: "f1", photoIds: ["a", "b"] }]));
    expect(port.write).toHaveBeenCalledTimes(1);
    expect(isNewPhoto(ctxOf(actor), { id: "b", folderId: "f1" })).toBe(true);
  });

  test("the person's own photos and photos of unlisted albums are never new", async () => {
    const { actor } = await setup(record({ f1: ["a"] }));
    const ctx = ctxOf(actor);
    expect(isNewPhoto(ctx, { id: "b", folderId: "f1", mine: true })).toBe(false);
    expect(isNewPhoto(ctx, { id: "b", folderId: "f2" })).toBe(false);
    expect(isNewPhoto(ctx, { id: "b" })).toBe(false);
  });

  test("looking keeps the mark until the visit ends, and saves at once", async () => {
    const { actor, port } = await setup(record({ f1: ["a"] }));
    actor.send(looked([{ albumId: "f1", photoId: "b" }]));
    expect(port.write).toHaveBeenCalledWith(record({ f1: ["a", "b"] }));
    expect(isNewPhoto(ctxOf(actor), { id: "b", folderId: "f1" })).toBe(true);
    actor.send(ended());
    expect(isNewPhoto(ctxOf(actor), { id: "b", folderId: "f1" })).toBe(false);
  });

  test("looking at a photo of an album with no record changes nothing and writes nothing", async () => {
    const { actor, port } = await setup();
    actor.send(looked([{ albumId: "f9", photoId: "x" }]));
    expect(ctxOf(actor).known).toEqual({});
    expect(port.write).not.toHaveBeenCalled();
  });

  test("looking at a known photo writes nothing", async () => {
    const { actor, port } = await setup(record({ f1: ["a"] }));
    actor.send(looked([{ albumId: "f1", photoId: "a" }]));
    expect(port.write).not.toHaveBeenCalled();
  });

  test("opening an album remembers it once", async () => {
    const { actor, port } = await setup();
    actor.send(opened("f1"));
    actor.send(opened("f1"));
    expect(port.write).toHaveBeenCalledTimes(1);
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(port.write).toHaveBeenCalledWith(record({}, "f1"));
    expect(ctxOf(actor).lastAlbum).toBe("f1");
  });

  test("a failed save is logged and the next change writes the full record", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { actor, port } = await setup(record({ f1: ["a"] }));
    port.write.mockResolvedValueOnce([new Error("disk"), null] as never);
    actor.send(looked([{ albumId: "f1", photoId: "b" }]));
    await actor.settled();
    await Promise.resolve();
    actor.send(looked([{ albumId: "f1", photoId: "c" }]));
    expect(port.write).toHaveBeenLastCalledWith(record({ f1: ["a", "b", "c"] }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a rejected save is logged and the next change still writes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { actor, port } = await setup(record({ f1: ["a"] }));
    port.write.mockRejectedValueOnce(new Error("gone"));
    actor.send(looked([{ albumId: "f1", photoId: "b" }]));
    await actor.settled();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith("seen: could not save", expect.any(Error));
    actor.send(looked([{ albumId: "f1", photoId: "c" }]));
    expect(port.write).toHaveBeenLastCalledWith(record({ f1: ["a", "b", "c"] }));
    spy.mockRestore();
  });

  test("inputs wait while the record is being read", () => {
    const port = { read: vi.fn(() => new Promise(() => {})), write: vi.fn() };
    const actor = seenMachine.create({ port: port as unknown as SeenPort });
    actor.send(opened("f1"));
    expect(seenReady(actor.snapshot())).toBe("reading");
    expect(port.write).not.toHaveBeenCalled();
  });

  test("a record that cannot be read marks nothing and is never written", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { actor, port } = await setup(new Error("disk"));
    expect(seenReady(actor.snapshot())).toBe("unreadable");
    actor.send(listed([{ albumId: "f1", photoIds: ["a"] }]));
    actor.send(opened("f1"));
    actor.send(looked([{ albumId: "f1", photoId: "a" }]));
    expect(port.write).not.toHaveBeenCalled();
    expect(isNewPhoto(ctxOf(actor), { id: "b", folderId: "f1" })).toBe(false);
    spy.mockRestore();
  });

  test("newCount counts everywhere, or only in the given albums", async () => {
    const { actor } = await setup(record({ f1: ["a"], f2: [] }));
    const ctx = ctxOf(actor);
    const photos = [
      { id: "b", folderId: "f1" },
      { id: "c", folderId: "f2" },
      { id: "d", folderId: "f2", mine: true },
      { id: "e", folderId: "f3" },
    ];
    expect(newCount(ctx, photos)).toBe(2);
    expect(newCount(ctx, photos, ["f1"])).toBe(1);
    expect(newCount(ctx, photos, [])).toBe(0);
  });
});
