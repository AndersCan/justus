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
