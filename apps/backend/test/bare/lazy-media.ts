/**
 * Bare twin of `../lazy-media.contract.test.ts`: the real loopback server
 * (bare-http1) and bare-fs read streams, which is where a client abort surfaces
 * as a read-stream error. Nothing here may import `node:*` or vitest.
 */
import http from "bare-http1";
import { createLoopbackServer } from "@ekrooh/bare/runtime";
import type { LazyMediaWorld } from "../contracts/lazy-media.contract.ts";

export async function bareLazyMedia(): Promise<{
  world(base: Omit<LazyMediaWorld, "server" | "get">): LazyMediaWorld;
  destroy(): Promise<void>;
}> {
  const server = createLoopbackServer({ auth: false, port: 0 });
  const { port } = await server.credentials();
  return {
    world: (base) => ({
      ...base,
      server,
      get: (route, abortAfterBytes) =>
        new Promise((done, fail) => {
          let settled = false;
          const finish = (r: { status: number; bytes: number; aborted: boolean }) => {
            if (settled) return;
            settled = true;
            done(r);
          };
          const req = http.request({ host: "127.0.0.1", port, path: route }, (res) => {
            let bytes = 0;
            res.on("data", (chunk: unknown) => {
              bytes += (chunk as Uint8Array).length;
              if (abortAfterBytes !== undefined && bytes >= abortAfterBytes) {
                req.destroy();
                finish({ status: res.statusCode ?? 0, bytes, aborted: true });
              }
            });
            res.on("end", () => finish({ status: res.statusCode ?? 0, bytes, aborted: false }));
          });
          req.on("error", (e: Error) => {
            if (!settled) fail(e);
          });
          req.end();
        }),
    }),
    destroy: () => new Promise((done) => server.close(() => done())),
  };
}
