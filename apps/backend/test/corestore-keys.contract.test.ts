/** Facts that CONTEXT.md "Device keys" relies on: where corestore and hypercore keep the seed and secret keys.
 * If one fails after a bump, revisit wrapping the seed (justus#358) before updating the doc. */
import Corestore from "corestore";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? filesUnder(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]),
    ),
  );
  return nested.flat();
}

async function dirContains({ dir, needle }: { dir: string; needle: Uint8Array }): Promise<boolean> {
  const target = Buffer.from(needle);
  const files = await filesUnder(dir);
  const contents = await Promise.all(files.map((file) => readFile(file)));
  return contents.some((bytes) => bytes.includes(target));
}

async function withStore<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "corestore-keys-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeCore(dir: string) {
  const store = new Corestore(dir);
  const core = store.get({ name: "db" });
  await core.ready();
  await core.append(Buffer.from("hello"));
  const seed = Buffer.from(store.primaryKey);
  const secret = Buffer.from(core.keyPair.secretKey.subarray(0, 32));
  await core.close();
  await store.close();
  return { seed, secret };
}

describe("corestore key storage", () => {
  it(
    "corestore keeps the seed in its own database",
    () =>
      withStore(async (dir) => {
        const { seed } = await writeCore(dir);
        expect(await dirContains({ dir, needle: seed })).toBe(true);
      }),
    30_000,
  );

  it(
    "hypercore keeps each writable core's secret key in the database",
    () =>
      withStore(async (dir) => {
        const { secret } = await writeCore(dir);
        expect(await dirContains({ dir, needle: secret })).toBe(true);
      }),
    30_000,
  );

  it(
    "a seed passed in is stored again",
    () =>
      withStore(async (dir) => {
        const { seed } = await writeCore(dir);
        const first = new Corestore(dir);
        await first.ready();
        await first.storage.setSeed(null);
        await first.close();
        const second = new Corestore(dir, { primaryKey: seed, unsafe: true });
        await second.ready();
        const stored = await second.storage.getSeed();
        await second.close();
        expect(Buffer.from(stored).equals(seed)).toBe(true);
      }),
    30_000,
  );
});
