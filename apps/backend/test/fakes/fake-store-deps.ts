/**
 * A photo store's dependencies on the contract-checked fakes (`fake-world.ts`).
 * Devices share drives only when they share a `hub`.
 */
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { PeerEvent, PeerNetwork } from "../../src/ports/peer-network.ts";
import type { PhotoStore, PhotoStoreDeps } from "../../src/photo-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  createFakePeerNetwork,
  setFakeNodeConnected,
  type FakeHub,
  type FakeNode,
} from "./fake-world.ts";
import { makeTmpDir } from "../tmp-dirs.ts";

/** In-memory LoopbackServer. Routes are recorded so tests can assert mounts. */
export class FakeLoopbackServer {
  private routes = new Map<string, string>();
  async mount(route: string, target: string): Promise<void> {
    this.routes.set(route, target);
  }
  async unmount(route: string): Promise<void> {
    this.routes.delete(route);
  }
  async origin(): Promise<string> {
    return "http://localhost:0";
  }
  async url(path: string): Promise<string> {
    return `http://localhost:0${path}`;
  }
  token(): string {
    return "";
  }
  async credentials(): Promise<{
    origin: string;
    port: number;
    token: string;
    bootstrap: string;
  }> {
    return { origin: "http://localhost:0", port: 0, token: "", bootstrap: "" };
  }
  mountDir(_prefix: string, _dirPath: string, _opts?: { public?: boolean }): void {}
  onConnection(_handler: unknown): void {}
  private handlers = new Map<string, (req: unknown, res: unknown) => void>();
  registerRoute(method: string, path: string, handler: unknown): void {
    this.handlers.set(`${method} ${path}`, handler as (req: unknown, res: unknown) => void);
    this.routes.set(path, `${method} route`);
  }
  /** Load a registered GET route the way the WebView would. */
  async getForTest(
    path: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const handler = this.handlers.get(`GET ${path}`);
    if (!handler) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }) as Writable & { writeHead(s: number, h: Record<string, string>): void };
    res.writeHead = (s, h) => {
      status = s;
      headers = h;
    };
    const done = new Promise<void>((resolve) => res.on("finish", () => resolve()));
    handler({ method: "GET", url: path, headers: {} }, res);
    await done;
    return { status, headers, body: Buffer.concat(chunks) };
  }
  push(_frame: Uint8Array): boolean {
    return false;
  }
  close(_cb?: (err?: Error | null) => void): void {}
  routesForTest(): Map<string, string> {
    return this.routes;
  }
}

export type FakeStoreDeps = PhotoStoreDeps & { hub: FakeHub; node: FakeNode };

/** A photo store's deps on the checked fakes. Devices share drives only when they share `hub`. */
export function fakeStoreDeps(
  overrides: Partial<PhotoStoreDeps> & { hub?: FakeHub; node?: FakeNode } = {},
): FakeStoreDeps {
  const hub = overrides.hub ?? createFakeHub();
  let node = overrides.node;
  if (!node) {
    node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
  }
  const storageDir = overrides.storageDir ?? makeTmpDir("justus-fake-");
  return {
    storageDir,
    cacheDir: join(storageDir, "cache"),
    server: new FakeLoopbackServer(),
    deviceName: "Tester",
    onChanged: () => {},
    seedOnEmpty: false,
    fs: nodeFs as unknown as typeof import("bare-fs"),
    path: nodePath as unknown as typeof import("bare-path"),
    crypto: nodeCrypto as unknown as typeof import("bare-crypto"),
    drives: createFakeDriveStore({ hub, node }),
    network: createFakePeerNetwork({ hub }),
    ...overrides,
    hub,
    node,
  } as FakeStoreDeps;
}

/** Same storage, node and options; a fresh drive store and network, as after an app restart. */
export function restarted(deps: FakeStoreDeps): FakeStoreDeps {
  const { hub, node } = deps;
  return fakeStoreDeps({
    ...deps,
    drives: createFakeDriveStore({ hub, node }),
    network: createFakePeerNetwork({ hub }),
  });
}

/** Another phone's network, started with `identityKey`; `meet(topic)` joins it client-only, so it connects to whoever serves `topic`. */
export function peerPhone(
  hub: FakeHub,
  opts: { identityKey: string; protocol?: number; legacy?: boolean },
): { network: PeerNetwork; events: PeerEvent[]; meet(topic: string): void } {
  const network = createFakePeerNetwork({ hub, legacy: opts.legacy });
  const events: PeerEvent[] = [];
  network.start(opts.identityKey, (e) => events.push(e), opts.protocol);
  return { network, events, meet: (topic) => network.join(topic, { server: false }) };
}

/** Makes `joiner` a Member of the Admin's album the way the app does: the
 * joiner asks with its drive for that album (a pending reader), the Admin
 * approves that key, and joining again picks up the approval. Returns the
 * joiner's member key (its drive key in that album). */
export async function joinAsMember(
  admin: PhotoStore,
  folderId: string,
  joiner: PhotoStore,
  shareKey: string,
): Promise<string> {
  const asked = await joiner.join(shareKey);
  if (asked[0]) throw asked[0];
  const pending = (await joiner.folders()).folders.find((f) => f.shareKey === shareKey)!;
  const approved = await admin.respond(folderId, pending.driveKey, true);
  if (approved[0]) throw approved[0];
  const joined = await joiner.join(shareKey);
  if (joined[0]) throw joined[0];
  return pending.driveKey;
}
