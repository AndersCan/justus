import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { LoopbackRouteHandler } from "@ekrooh/bare/runtime";
import { cases } from "./contracts/lazy-media.contract.ts";
import { makeCheck } from "./p2p-scenarios.ts";
import { afterAll, beforeAll, describe, it } from "vite-plus/test";

describe("lazy media over node http", () => {
  let root: string;
  let origin: string;
  const routes = new Map<string, LoopbackRouteHandler>();
  const server = http.createServer((req, res) =>
    routes.get(req.url ?? "")?.(req as never, res as never),
  );

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "justus-lazy-media-"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const c of cases) {
    it(c.name, () =>
      c.run(
        {
          fs: fs as never,
          path,
          dir: fs.mkdtempSync(path.join(root, "case-")),
          server: { registerRoute: (_method, route, handler) => routes.set(route, handler) },
          get: (route, abortAfterBytes) =>
            new Promise((done, fail) => {
              const req = http.get(origin + route, (res) => {
                let bytes = 0;
                res.on("data", (chunk: Uint8Array) => {
                  bytes += chunk.length;
                  if (abortAfterBytes !== undefined && bytes >= abortAfterBytes) {
                    req.destroy();
                    done({ status: res.statusCode ?? 0, bytes, aborted: true });
                  }
                });
                res.on("end", () => done({ status: res.statusCode ?? 0, bytes, aborted: false }));
              });
              req.on("error", (e) => {
                if ((e as { code?: string }).code !== "ECONNRESET") fail(e);
              });
            }),
        },
        makeCheck(),
      ),
    );
  }
});
