/**
 * #19 shared parity harness.
 *
 * The "Fake port provides parity" acceptance criterion says a stand-in
 * synchronizer and the real hyperdrive-file seam must behave identically on
 * their read path. This module holds that read-path contract in one place so
 * both `createFakeSynchronizer` (today) and the real `HyperdriveSynchronizer`
 * (slice 3) run the *same* assertions — a behavior change to one fails the
 * other, which is exactly what keeps the seam swap safe.
 *
 * Pure Node: no Bare/swarm, so it runs under plain vitest as well as CI.
 */

import type { SynchronizerPort } from "./synchronizer-port.js";
import { expect } from "vite-plus/test";

/** A drive key with no leading slash, long enough to look like a real hex key. */
export const PARITY_KEY = "aa".repeat(32);

/** A second drive key so the write-path contract runs on a fresh drive. */
export const PARITY_KEY_WRITE = "bb".repeat(32);

/** Assert the read-path contract of `SynchronizerPort` holds for `sync`. */
export async function assertSynchronizerReadParity(sync: SynchronizerPort): Promise<void> {
  await sync.put(PARITY_KEY, { path: "/photos/a.jpg", data: Buffer.from("hello") });
  const handle = await sync.open(PARITY_KEY);
  expect(await handle.read("/photos/a.jpg")).toEqual(Buffer.from("hello"));

  await sync.put(PARITY_KEY, { path: "blob.bin", data: Buffer.from("0123456789") });
  expect(await handle.readRange("blob.bin", { start: 2, end: 5 })).toEqual(Buffer.from("234"));
  expect(await handle.readRange("blob.bin", { start: 0, end: 10 })).toEqual(
    Buffer.from("0123456789"),
  );

  await expect(handle.readRange("blob.bin", { start: 0, end: 99 })).rejects.toThrow();
  await expect(handle.readRange("blob.bin", { start: 5, end: 2 })).rejects.toThrow();

  await sync.put(PARITY_KEY, { path: "/photos/b.jpg", data: Buffer.from("bb"), mtime: 20 });
  await sync.put(PARITY_KEY, { path: "/photos/a.jpg", data: Buffer.from("a"), mtime: 10 });
  await sync.put(PARITY_KEY, { path: "/meta.json", data: Buffer.from("{}"), mtime: 5 });
  const photos = await handle.list("/photos");
  expect(photos.map((e) => e.name)).toEqual(["photos/a.jpg", "photos/b.jpg"]);
  expect(photos[0]).toMatchObject({ size: 1, mtime: 10 });

  await sync.put(PARITY_KEY, { path: "/x", data: Buffer.from("abcd"), mtime: 42 });
  expect(await handle.stat("/x")).toMatchObject({ name: "x", size: 4, mtime: 42 });
  await expect(handle.stat("/nope")).rejects.toThrow();
  await expect(handle.read("/nope")).rejects.toThrow();
}

/**
 * Assert the write-path + mirror contract of `SynchronizerPort` holds for `sync`.
 *
 * The real hyperdrive seam and the fake must agree on these too, because the
 * store mirrors a peer's drive by listing + reading, never by deleting: a re-put
 * replaces the object in place (same name, new bytes/mtime), and list() returns
 * every object under a prefix so a sparse client can fetch only what it lacks.
 */
export async function assertSynchronizerWriteParity(sync: SynchronizerPort): Promise<void> {
  const handle = await sync.open(PARITY_KEY_WRITE);

  // A re-put replaces the object in place: same name, new bytes and mtime.
  await sync.put(PARITY_KEY_WRITE, { path: "/photos/a.jpg", data: Buffer.from("v1"), mtime: 1 });
  await sync.put(PARITY_KEY_WRITE, { path: "/photos/a.jpg", data: Buffer.from("v2"), mtime: 2 });
  expect(await handle.read("/photos/a.jpg")).toEqual(Buffer.from("v2"));
  expect(await handle.stat("/photos/a.jpg")).toMatchObject({
    name: "photos/a.jpg",
    size: 2,
    mtime: 2,
  });
  const rootAfterA = await handle.list("");
  expect(rootAfterA.filter((entry) => entry.name === "photos/a.jpg")).toHaveLength(1);

  // An explicit mtime wins over the default clock; the contract preserves it.
  await sync.put(PARITY_KEY_WRITE, { path: "/photos/b.jpg", data: Buffer.from("bb"), mtime: 7 });
  expect(await handle.stat("/photos/b.jpg")).toMatchObject({
    name: "photos/b.jpg",
    size: 2,
    mtime: 7,
  });

  // Sparse mirror: a peer holding a subset lists the full set and reads every object.
  const full = ["m/1.bin", "m/2.bin", "m/3.bin"];
  await Promise.all(
    full.map((name) => sync.put(PARITY_KEY_WRITE, { path: "/" + name, data: Buffer.from(name) })),
  );
  const listed = (await handle.list("")).map((entry) => entry.name);
  listed.sort();
  expect(listed).toEqual([...full, "photos/a.jpg", "photos/b.jpg"].sort());
  const bodies = await Promise.all(full.map((name) => handle.read("/" + name)));
  for (const [index, name] of full.entries()) {
    expect(bodies[index]).toEqual(Buffer.from(name));
  }

  await sync.put(PARITY_KEY_WRITE, { path: "/dup/x", data: Buffer.from("same") });
  await sync.put(PARITY_KEY_WRITE, { path: "/dup/y", data: Buffer.from("same") });
  expect(await handle.read("/dup/x")).toEqual(await handle.read("/dup/y"));
  expect((await handle.list("/dup")).map((entry) => entry.name)).toEqual(["dup/x", "dup/y"]);
}

/** Assert the complete read + write + mirror contract holds for `sync`. */
export async function assertSynchronizerParity(sync: SynchronizerPort): Promise<void> {
  await assertSynchronizerReadParity(sync);
  await assertSynchronizerWriteParity(sync);
}
