/**
 * Regression test for leaked `.tmp` staging files when a spool fails
 * (issues #90/#92).
 *
 * `spoolToFile` stages a photo to `<spoolName>.<ts>.<rand>.tmp` and atomically
 * renames it into place. If the spool fails (oversized/capped photo, disk
 * error, ...), the staging file must be removed — otherwise the cache spool
 * dir accumulates orphan `*.tmp` files. Before the fix the failure path left
 * the tmp behind.
 */
import { describe, it, expect } from "vite-plus/test";
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createPhotoStore } from "../src/photo-store.ts";
import { makeFakeDeps } from "./fake-drive.ts";
import type { PhotoStoreDeps } from "../src/photo-store.ts";

/** An `fs` whose `createWriteStream` opens the file but fails the first write,
 * modelling a disk-full / write-error mid-spool. The tmp file is created on
 * disk (so a leak is observable) but the pump then rejects. */
function failingWriteFs(): typeof import("bare-fs") {
  return {
    ...(nodeFs as any),
    createWriteStream(p: string) {
      const ws = (nodeFs as any).createWriteStream(p);
      const orig = ws.write.bind(ws);
      let fired = false;
      ws.write = (chunk: Uint8Array, ...args: any[]) => {
        if (!fired) {
          fired = true;
          // Defer so the write actually lands on disk before the error fires.
          setImmediate(() => ws.emit("error", new Error("simulated write failure")));
        }
        return orig(chunk, ...args);
      };
      return ws;
    },
  } as unknown as typeof import("bare-fs");
}

describe("#90/#92 a failed spool must not leak a .tmp staging file", () => {
  it("removes the staging tmp when the spool write fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "justus-spoolleak-"));
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Wrap the fake deps so the read stream yields a byte (so the failing
    // writer actually performs a write) while keeping drive identity stable.
    const base = makeFakeDeps({
      storageDir: dir,
      cacheDir,
      fs: failingWriteFs(),
      seedOnEmpty: false,
    }) as PhotoStoreDeps & { makeDrive: (cs: unknown, key?: Buffer) => any };
    const innerMakeDrive = base.makeDrive;
    base.makeDrive = (cs: unknown, key?: Buffer) => {
      const d = innerMakeDrive(cs, key);
      d.createReadStream = () => Readable.from(Buffer.from([1, 2, 3, 4, 5]));
      return d;
    };

    const store = createPhotoStore(base);
    await store.ready();

    const created = await store.createFolder("Holidays");
    expect(created[0]).toBeNull();
    const folderId = created[1]!.folder.id;
    await store.setActive(folderId);

    // The add itself succeeds (bytes land on the drive); only the cache spool
    // fails under the failing fs. `list()` then re-spools and fails again — in
    // both cases the staging tmp must be cleaned up.
    const added = await store.addBytes("sunset.jpg", new Uint8Array([1, 2, 3, 4, 5]));
    expect(added[0]).toBeNull();
    const listed = await store.list();
    expect(listed).toHaveLength(0); // every spool failed

    const spoolDir = join(cacheDir, "photos", folderId);
    const leftovers = existsSync(spoolDir)
      ? readdirSync(spoolDir).filter((f) => f.endsWith(".tmp"))
      : [];
    expect(leftovers).toHaveLength(0);

    await store.close();
  });
});
