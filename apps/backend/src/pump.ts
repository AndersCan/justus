/**
 * Stream-pump primitives shared by the upload route and the photo spooler.
 *
 * This module deliberately imports NO `bare-*` package so the backpressure and
 * size-cap logic stays unit-testable: production injects a `bare-fs` writer,
 * tests inject a Node `fs` writer. Both satisfy the tiny {@link PumpWriter}
 * shape.
 */

export type PumpSource = {
  on(event: "data" | "end" | "error", listener: (...args: any[]) => void): unknown;
  /** Optional: a pausable source (most streams) lets us honor backpressure. */
  pause?(): void;
  resume?(): void;
};

export type PumpWriter = {
  write(chunk: Uint8Array): boolean;
  end(cb?: () => void): void;
  on(event: "drain" | "error", listener: (...args: any[]) => void): unknown;
  once(event: "drain" | "error", listener: (...args: any[]) => void): unknown;
  destroy?(): void;
};

export type PumpOptions = {
  /** Creates the destination writer for this pump (called exactly once). */
  createWriter: () => PumpWriter;
  /**
   * Optional byte ceiling. The pump rejects (and destroys the writer) the
   * moment the running count would exceed it, capping device-storage use
   * against an oversized or malicious upload.
   */
  maxBytes?: number;
};

/**
 * Pumps `source` into a writer created by `createWriter`.
 *
 * - Honors backpressure: when `write()` returns `false` the source is paused
 *   until the writer emits `drain`, so memory stays bounded on large uploads.
 *   (Previously the return value was ignored, letting the kernel buffer grow
 *   unbounded and, in some runtimes, truncating the file — issue #53.)
 * - Enforces `maxBytes`: an oversized stream fails fast instead of exhausting
 *   storage (issue #57).
 *
 * Resolves with the total bytes written.
 */
export function pumpStream(source: PumpSource, opts: PumpOptions): Promise<number> {
  const { createWriter, maxBytes } = opts;
  return new Promise((resolve, reject) => {
    const out = createWriter();
    let size = 0;
    let done = false;
    let paused = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      try {
        out.destroy?.();
      } catch {
        // already torn down
      }
      reject(err);
    };
    source.on("data", (chunk: unknown) => {
      if (done) return;
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (maxBytes !== undefined && size > maxBytes) {
        fail(new Error(`stream too large (>${maxBytes} bytes)`));
        return;
      }
      const ok = out.write(bytes);
      if (!ok && !paused) {
        // Kernel buffer full — stop pulling from the source until it drains.
        // `once` so the listener is one-shot and can't stack across pauses.
        paused = true;
        source.pause?.();
        out.once("drain", () => {
          paused = false;
          source.resume?.();
        });
      }
    });
    source.on("end", () => {
      if (done) return;
      out.end(() => {
        if (done) return;
        done = true;
        resolve(size);
      });
    });
    source.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    out.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * Pump a source into a writer produced by `createWriter`, with an optional
 * byte cap. Convenience wrapper around {@link pumpStream}.
 */
export function pumpToFile(
  source: PumpSource,
  createWriter: () => PumpWriter,
  maxBytes?: number,
): Promise<number> {
  return pumpStream(source, { createWriter, maxBytes });
}
