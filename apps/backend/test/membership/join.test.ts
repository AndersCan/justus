import { describe, expect, it } from "vite-plus/test";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  createFakePeerNetwork,
  setFakeNodeConnected,
  type FakeHub,
  type FakeWorldOptions,
} from "../fakes/fake-world.ts";
import {
  MAX_PEER_JSON_BYTES,
  openAlbum,
  openWithTopic,
  readRecord,
  type JoinPorts,
} from "../../src/membership/join.ts";

type LogEntry = { event: string; fields?: Record<string, unknown> };

function devices(n: number, options?: FakeWorldOptions) {
  const hub = createFakeHub(options);
  return Array.from({ length: n }, () => deviceOn(hub));
}

function deviceOn(hub: FakeHub) {
  {
    const node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
    const drives = createFakeDriveStore({ hub, node });
    const network = createFakePeerNetwork({ hub });
    const events: LogEntry[] = [];
    const ports: JoinPorts = {
      drives,
      network,
      openTimeoutMs: 50,
      log: (event, fields) => events.push({ event, fields }),
    };
    return { ports, events };
  }
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("readRecord", () => {
  it("returns a record's text, and null when it is missing or larger than the cap", async () => {
    const [a] = devices(1);
    const drive = await a.ports.drives.openOwn();
    await drive.put("/small.json", Buffer.from("{}"));
    await drive.put("/big.json", Buffer.alloc(MAX_PEER_JSON_BYTES + 1, 97));
    const read = (path: string) => readRecord(drive, { path, log: a.ports.log });
    expect([
      await read("/small.json"),
      await read("/missing.json"),
      await read("/big.json"),
    ]).toEqual(["{}", null, null]);
  });

  it("returns null and logs drive.read when the read fails", async () => {
    const [a] = devices(1);
    const drive = await a.ports.drives.openOwn();
    const broken = {
      ...drive,
      readSmall: async () => {
        throw new Error("boom");
      },
    };
    const text = await readRecord(broken, { path: "/x.json", log: a.ports.log });
    expect({ text, events: a.events }).toEqual({
      text: null,
      events: [
        {
          event: "error",
          fields: {
            where: "drive.read",
            drive: drive.key.slice(0, 8),
            path: "/x.json",
            err: "boom",
          },
        },
      ],
    });
  });
});

describe("openWithTopic", () => {
  it("joins the drive topic client-only before opening the drive", async () => {
    const [admin, joiner] = devices(2);
    const folder = await admin.ports.drives.openOwn("folder/a");
    const [openErr, drive] = await openWithTopic(joiner.ports, { key: folder.key, server: false });
    expect({
      openErr,
      key: drive?.key,
      joins: joiner.ports.network.debug().joins,
      events: joiner.events.map((e) => e.event),
    }).toEqual({
      openErr: null,
      key: folder.key,
      joins: [{ topic: joiner.ports.drives.discoveryKeyOf(folder.key), served: false }],
      events: ["drive.open.start", "drive.open.ready"],
    });
  });
});

describe("openAlbum", () => {
  it("returns the share drive, its registry and its name", async () => {
    const [admin, joiner] = devices(2);
    const folder = await admin.ports.drives.openOwn("folder/a");
    const registry = {
      version: 1,
      members: { k: { key: "k", name: "Ann", addedAt: 1 } },
    };
    await folder.put("/folder.json", json({ version: 1, name: "Trip" }));
    await folder.put("/members.json", json(registry));
    const [err, album] = await openAlbum(joiner.ports, { shareKey: folder.key });
    expect({
      err,
      key: album?.folderDrive.key,
      registry: album?.registry,
      name: album?.folderName,
    }).toEqual({ err: null, key: folder.key, registry, name: "Trip" });
  });

  it("reads an album with no registry or name as empty values", async () => {
    const [admin, joiner] = devices(2);
    const folder = await admin.ports.drives.openOwn("folder/a");
    const [err, album] = await openAlbum(joiner.ports, { shareKey: folder.key });
    expect({ err, registry: album?.registry, name: album?.folderName }).toEqual({
      err: null,
      registry: { version: 1, members: {} },
      name: "",
    });
  });

  it("returns cannot-open when the share drive never becomes ready", async () => {
    let slowKey = "";
    const hub = createFakeHub({
      readyDelayMs: (k) => (k === slowKey ? Number.POSITIVE_INFINITY : 0),
    });
    const admin = deviceOn(hub);
    const joiner = deviceOn(hub);
    const key = (await admin.ports.drives.openOwn("folder/a")).key;
    slowKey = key;
    const result = await openAlbum(joiner.ports, { shareKey: key });
    expect({
      result,
      timedOut: joiner.events.some((e) => e.event === "drive.open.timeout"),
    }).toEqual({
      result: [{ kind: "cannot-open", message: `drive ${key.slice(0, 8)} not ready` }, null],
      timedOut: true,
    });
  });
});
