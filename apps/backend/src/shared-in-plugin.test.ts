import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Writable } from "node:stream";
import type { LoopbackRouteHandler, LoopbackServer } from "@ekrooh/bare/runtime";
import { createLazyMedia } from "./lazy-media";
import { createSharedInPlugin } from "./shared-in-plugin";
import type { Files, Paths } from "./ports/files";

const files = fs as unknown as Files;
const paths = nodePath as unknown as Paths;
const fixture = JSON.parse(
  fs.readFileSync(
    nodePath.join(import.meta.dirname, "../../../packages/core/fixtures/shared-in-batch.v1.json"),
    "utf8",
  ),
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "shared-in-plugin-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeServer() {
  const routes: Record<string, LoopbackRouteHandler> = {};
  const server = {
    registerRoute(m: string, p: string, h: LoopbackRouteHandler) {
      routes[`${m} ${p}`] = h;
    },
  } as unknown as LoopbackServer;
  return { routes, server };
}

function invokeRemove(plugin: ReturnType<typeof createSharedInPlugin>, ids: unknown) {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error("no invoke adapter");
  return adapter.invoke("sharedIn.remove", { ids }, { runtime: "bare", payload: new Uint8Array() });
}

function invokeList(plugin: ReturnType<typeof createSharedInPlugin>) {
  const adapter = plugin.runtimes.bare;
  if (!adapter?.invoke) throw new Error("no invoke adapter");
  return adapter.invoke("sharedIn.list", {}, { runtime: "bare", payload: new Uint8Array() });
}

async function get(handler: LoopbackRouteHandler) {
  const chunks: Buffer[] = [];
  const out = { status: 0, headers: {} as Record<string, string> };
  const res = Object.assign(
    new Writable({
      write(c, _e, cb) {
        chunks.push(Buffer.from(c));
        cb();
      },
    }),
    {
      writeHead(s: number, h: Record<string, string>) {
        out.status = s;
        out.headers = h;
      },
    },
  );
  const done = new Promise((r) => res.on("finish", r));
  handler({ url: "", headers: {} } as never, res as never);
  await done;
  return { ...out, body: Buffer.concat(chunks) };
}

describe("justus.sharedIn plugin", () => {
  test("lists the fixture batch and serves each original's bytes with its type", async () => {
    const d = nodePath.join(dir, fixture.id);
    fs.mkdirSync(d);
    fs.writeFileSync(nodePath.join(d, "batch.json"), JSON.stringify(fixture));
    fs.writeFileSync(nodePath.join(d, "0.jpeg"), "jpeg-bytes");
    fs.writeFileSync(nodePath.join(d, "copy-0-display.jpg"), "display");
    fs.writeFileSync(nodePath.join(d, "copy-0-thumb.jpg"), "thumb");
    fs.writeFileSync(nodePath.join(d, "1.png"), "png-bytes");
    const { routes, server } = fakeServer();
    const plugin = createSharedInPlugin({
      dir,
      files,
      paths,
      media: createLazyMedia(server, files),
    });

    const [e, result] = (await invokeList(plugin)) as [
      null,
      { batches: { photos: { url: string; type: string }[] }[] },
    ];
    expect(e).toBeNull();
    const photos = result.batches[0]!.photos;
    expect(photos.map((p) => p.url)).toEqual([
      `/shared-in/${fixture.id}/0`,
      `/shared-in/${fixture.id}/1`,
    ]);

    const first = await get(routes[`GET ${photos[0]!.url}`]!);
    expect(first.status).toBe(200);
    expect(first.headers["Content-Type"]).toBe("image/jpeg");
    expect(first.body.toString()).toBe("jpeg-bytes");
    const second = await get(routes[`GET ${photos[1]!.url}`]!);
    expect(second.headers["Content-Type"]).toBe("image/png");
    expect(second.body.toString()).toBe("png-bytes");
    expect(console.error).toHaveBeenCalledWith("[justus] shared-in.listed batches=1 photos=2");
  });

  test("listing again keeps the routes working (serve is idempotent)", async () => {
    const d = nodePath.join(dir, fixture.id);
    fs.mkdirSync(d);
    fs.writeFileSync(
      nodePath.join(d, "batch.json"),
      JSON.stringify({ ...fixture, items: [{ file: "1.png" }] }),
    );
    fs.writeFileSync(nodePath.join(d, "1.png"), "png-bytes");
    const { routes, server } = fakeServer();
    const plugin = createSharedInPlugin({
      dir,
      files,
      paths,
      media: createLazyMedia(server, files),
    });
    await invokeList(plugin);
    await invokeList(plugin);
    expect(Object.keys(routes)).toEqual([`GET /shared-in/${fixture.id}/0`]);
  });

  test("an empty inbox lists nothing", async () => {
    const { server } = fakeServer();
    const plugin = createSharedInPlugin({
      dir,
      files,
      paths,
      media: createLazyMedia(server, files),
    });
    expect(await invokeList(plugin)).toEqual([null, { batches: [] }]);
  });

  test("an unreadable inbox is a HOST_ERROR", async () => {
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "x");
    const { server } = fakeServer();
    const plugin = createSharedInPlugin({
      dir,
      files,
      paths,
      media: createLazyMedia(server, files),
    });
    const [e] = (await invokeList(plugin)) as [{ code: string }, null];
    expect(e.code).toBe("HOST_ERROR");
    fs.rmSync(dir);
  });

  test("removing a listed batch empties the inbox; removing again removes nothing", async () => {
    const d = nodePath.join(dir, fixture.id);
    fs.mkdirSync(d);
    fs.writeFileSync(nodePath.join(d, "batch.json"), JSON.stringify(fixture));
    fs.writeFileSync(nodePath.join(d, "0.jpeg"), "jpeg-bytes");
    fs.writeFileSync(nodePath.join(d, "1.png"), "png-bytes");
    const { server } = fakeServer();
    const plugin = createSharedInPlugin({
      dir,
      files,
      paths,
      media: createLazyMedia(server, files),
    });
    const [, listed] = (await invokeList(plugin)) as [null, { batches: { id: string }[] }];
    expect(listed.batches).toHaveLength(1);
    expect(await invokeRemove(plugin, [fixture.id])).toEqual([null, { removed: 1 }]);
    expect(await invokeList(plugin)).toEqual([null, { batches: [] }]);
    expect(await invokeRemove(plugin, [fixture.id])).toEqual([null, { removed: 0 }]);
  });

  test("removing with a bad list is a PLUGIN_ERROR", async () => {
    const { server } = fakeServer();
    const plugin = createSharedInPlugin({
      dir,
      files,
      paths,
      media: createLazyMedia(server, files),
    });
    const [e] = (await invokeRemove(plugin, "x")) as [{ code: string }, null];
    expect(e.code).toBe("PLUGIN_ERROR");
  });
});
