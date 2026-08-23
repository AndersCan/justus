import { describe, expect, test } from "vite-plus/test";
import { Readable } from "node:stream";
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeOs from "node:os";
import { pumpStream } from "./pump";

/** Builds a pausable source from in-memory chunks, counting pause() calls so
 * we can assert the backpressure path actually engaged. */
function pausableSource(chunks: Buffer[]) {
  const src = Readable.from(
    (async function* () {
      for (const c of chunks) yield c;
    })(),
  );
  let pauses = 0;
  const origPause = src.pause.bind(src);
  src.pause = () => {
    pauses += 1;
    return origPause();
  };
  return { src, pauses: () => pauses };
}

describe("pumpStream", () => {
  test("pumps a source to a file with the exact byte count", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pump-"));
    const tmp = nodePath.join(dir, "out.bin");
    const payload = Buffer.from("hello justus stream");
    const { src } = pausableSource([payload]);
    const bytes = await pumpStream(src, { createWriter: () => nodeFs.createWriteStream(tmp) });
    expect(bytes).toBe(payload.length);
    expect(nodeFs.readFileSync(tmp)).toEqual(payload);
    src.destroy();
  });

  test("honors writer backpressure — pauses the source when the buffer is full (#53)", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pump-"));
    const tmp = nodePath.join(dir, "big.bin");
    const CHUNK = 16 * 1024;
    const N = 64; // ~1 MB
    const chunks: Buffer[] = [];
    for (let i = 0; i < N; i++) chunks.push(Buffer.alloc(CHUNK, i & 0xff));
    const { src, pauses } = pausableSource(chunks);
    const bytes = await pumpStream(src, {
      createWriter: () => nodeFs.createWriteStream(tmp, { highWaterMark: 1024 }),
    });
    expect(bytes).toBe(N * CHUNK);
    expect(pauses()).toBeGreaterThan(0); // backpressure path was exercised
    // No truncation: the file holds exactly the bytes that were pumped.
    expect(nodeFs.statSync(tmp).size).toBe(N * CHUNK);
    src.destroy();
  });

  test("rejects and destroys the writer when the stream exceeds maxBytes (#57)", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pump-"));
    const tmp = nodePath.join(dir, "cap.bin");
    const chunks: Buffer[] = [];
    for (let i = 0; i < 200; i++) chunks.push(Buffer.alloc(1024, 7)); // 200 KB
    const { src } = pausableSource(chunks);
    let destroyed = false;
    const writer = nodeFs.createWriteStream(tmp, { highWaterMark: 1024 });
    const origDestroy = writer.destroy.bind(writer);
    writer.destroy = (...args: unknown[]) => {
      destroyed = true;
      return origDestroy(...(args as []));
    };
    await expect(
      pumpStream(src, { createWriter: () => writer, maxBytes: 50 * 1024 }),
    ).rejects.toThrow(/stream too large/);
    expect(destroyed).toBe(true);
    src.destroy();
  });
});
