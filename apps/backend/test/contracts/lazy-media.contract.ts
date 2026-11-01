/**
 * The lazy-media route contract (#200): a photo route keeps serving after a
 * client drops the connection mid-body (the grid cancels loads as it scrolls).
 * Written once and run against Node http + fs (vitest) and the real loopback
 * server + bare-fs (Bare), where an unhandled read-stream error kills the
 * backend.
 *
 * Portable on purpose: no test-runner or Node built-in imports, so esbuild can bundle
 * it for Bare. A runtime supplies a {@link LazyMediaWorld} and a `Check`.
 */
import type { LoopbackServer } from "@ekrooh/bare/runtime";
import { createLazyMedia } from "../../src/lazy-media.ts";
import type { Files, Paths } from "../../src/ports/files.ts";
import type { Check } from "../p2p-scenarios.ts";

export type LazyMediaWorld = {
  fs: Files;
  path: Paths;
  /** A fresh, empty directory that exists. */
  dir: string;
  server: Pick<LoopbackServer, "registerRoute">;
  /** Fetches `path`; with `abortAfterBytes`, drops the connection once that many body bytes arrived. */
  get(
    path: string,
    abortAfterBytes?: number,
  ): Promise<{ status: number; bytes: number; aborted: boolean }>;
};

export type LazyMediaCase = {
  name: string;
  run(world: LazyMediaWorld, t: Check): Promise<void>;
};

const SIZE = 8 * 1024 * 1024;

export const cases: LazyMediaCase[] = [
  {
    name: "L1 keeps serving after a client aborts mid-body",
    async run(world, t) {
      const { fs, path, dir, server } = world;
      const file = path.join(dir, "big.bin");
      fs.writeFileSync(file, new Uint8Array(SIZE));
      createLazyMedia(server as LoopbackServer, fs).serve("/photo/big", {
        mime: "application/octet-stream",
        open: async () => file,
      });

      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        const cut = await world.get("/photo/big", 64 * 1024);
        t.ok(cut.aborted, "first request was aborted mid-body");
        t.ok(cut.bytes < SIZE, "first request got only part of the body");

        // Give the server time to notice the closed socket and tear the pipe down.
        await new Promise((r) => setTimeout(r, 300));

        const whole = await world.get("/photo/big");
        t.eq([whole.status, whole.bytes], [200, SIZE], "second request served in full");
      } finally {
        console.error = original;
      }
      t.eq(errors, [], "a client abort is not logged");
    },
  },
];
