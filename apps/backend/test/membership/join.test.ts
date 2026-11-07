import { describe, expect, it, vi } from "vite-plus/test";
import type { Drive, OpenResult } from "../../src/ports/drive-store.ts";
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
  pendingJoinRequests,
  readJoinRequests,
  readRecord,
  writeJoinRequest,
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

const T0 = 1_700_000_000_000;

async function outboxOf(device: ReturnType<typeof deviceOn>, label: string) {
  const drive = await device.ports.drives.openOwn(label);
  return drive;
}

describe("writeJoinRequest", () => {
  it("adds this album's request and keeps the other outbox entries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    try {
      const [admin, joiner] = devices(2);
      const folder = await admin.ports.drives.openOwn("folder/a");
      const identity = await outboxOf(joiner, "identity");
      const other = { requesterKey: "k0", shareKey: "s0", invite: "c0" };
      await identity.put("/requests.json", json({ version: 1, requests: { s0: other } }));
      const [err] = await writeJoinRequest(joiner.ports, {
        identityDrive: identity,
        folderDrive: folder,
        shareKey: folder.key,
        requesterKey: "rk",
        requesterName: "Bo",
        folderName: "Trip",
      });
      const text = await readRecord(identity, { path: "/requests.json", log: joiner.ports.log });
      expect({ err, file: JSON.parse(text ?? "null") }).toEqual({
        err: null,
        file: {
          version: 1,
          requests: {
            s0: other,
            [folder.key]: {
              requesterKey: "rk",
              requesterName: "Bo",
              shareKey: folder.key,
              folderName: "Trip",
              requestedAt: T0,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a malformed outbox", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    try {
      const [admin, joiner] = devices(2);
      const folder = await admin.ports.drives.openOwn("folder/a");
      const identity = await outboxOf(joiner, "identity");
      await identity.put("/requests.json", Buffer.from("not json"));
      await writeJoinRequest(joiner.ports, {
        identityDrive: identity,
        folderDrive: folder,
        shareKey: "s",
        requesterKey: "rk",
        requesterName: "Bo",
        folderName: "Trip",
      });
      const text = await readRecord(identity, { path: "/requests.json", log: joiner.ports.log });
      expect(JSON.parse(text ?? "null")).toEqual({
        version: 1,
        requests: {
          s: {
            requesterKey: "rk",
            requesterName: "Bo",
            shareKey: "s",
            folderName: "Trip",
            requestedAt: T0,
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the album topic so the Admin can reach the outbox", async () => {
    const [admin, joiner] = devices(2);
    const folder = await admin.ports.drives.openOwn("folder/a");
    const identity = await outboxOf(joiner, "identity");
    await writeJoinRequest(joiner.ports, {
      identityDrive: identity,
      folderDrive: folder,
      shareKey: "s",
      requesterKey: "rk",
      requesterName: "Bo",
      folderName: "Trip",
    });
    expect(joiner.ports.network.debug().joins).toEqual([
      { topic: folder.discoveryKey, served: true },
    ]);
  });

  it("returns write-failed on a read-only identity drive and serves nothing", async () => {
    const [admin, joiner] = devices(2);
    const folder = await admin.ports.drives.openOwn("folder/a");
    const foreign = await admin.ports.drives.openOwn("identity");
    const [openErr, readOnly] = await joiner.ports.drives.open(foreign.key, { timeoutMs: 50 });
    if (openErr) throw openErr;
    const result = await writeJoinRequest(joiner.ports, {
      identityDrive: readOnly,
      folderDrive: folder,
      shareKey: "s",
      requesterKey: "rk",
      requesterName: "Bo",
      folderName: "Trip",
    });
    expect({ result, joins: joiner.ports.network.debug().joins }).toEqual({
      result: [{ kind: "write-failed", message: "Drive is not writable" }, null],
      joins: [],
    });
  });
});

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const FOLDER = { id: "f1", name: "Trip", shareKey: "s".repeat(64) };

function request(requesterKey: string, extra?: Record<string, unknown>) {
  return {
    requesterKey,
    requesterName: "Bo",
    shareKey: FOLDER.shareKey,
    folderName: "Trip",
    requestedAt: 5,
    ...extra,
  };
}

async function outbox(device: ReturnType<typeof deviceOn>, label: string, requests: object) {
  const drive = await device.ports.drives.openOwn(label);
  await drive.put("/requests.json", json({ version: 1, requests }));
  return drive;
}

function opener(drives: Record<string, Drive>) {
  return async (key: string): Promise<OpenResult<Drive>> => {
    const drive = drives[key];
    return drive ? [null, drive] : [new Error("unreachable"), null];
  };
}

describe("readJoinRequests", () => {
  it("finds a request in a peer's outbox", async () => {
    const [admin, joiner] = devices(2);
    const drive = await outbox(joiner, "id", { [FOLDER.shareKey]: request(KEY_A) });
    const found = await readJoinRequests(opener({ i1: drive }), {
      identities: ["i1"],
      folder: FOLDER,
      log: admin.ports.log,
    });
    expect(found).toEqual({
      requests: [
        {
          request: {
            folderId: "f1",
            folderName: "Trip",
            requesterKey: KEY_A,
            requesterName: "Bo",
            requestedAt: 5,
            shareKey: FOLDER.shareKey,
          },
          identity: "i1",
          viaInvite: false,
        },
      ],
      ambiguous: [],
    });
  });

  it("marks a request made through the album's invite code", async () => {
    const [admin, joiner] = devices(2);
    const code = "c".repeat(64);
    const drive = await outbox(joiner, "id", {
      [FOLDER.shareKey]: request(KEY_A, { invite: code }),
    });
    const found = await readJoinRequests(opener({ i1: drive }), {
      identities: ["i1"],
      folder: { ...FOLDER, inviteCode: code },
      log: admin.ports.log,
    });
    expect(found.requests.map((f) => f.viaInvite)).toEqual([true]);
  });

  it("drops a requester key that two outboxes list", async () => {
    const [admin, one, two] = devices(3);
    const d1 = await outbox(one, "id", { [FOLDER.shareKey]: request(KEY_A) });
    const d2 = await outbox(two, "id", { [FOLDER.shareKey]: request(KEY_A) });
    const found = await readJoinRequests(opener({ i1: d1, i2: d2 }), {
      identities: ["i1", "i2"],
      folder: FOLDER,
      log: admin.ports.log,
    });
    expect(found).toEqual({ requests: [], ambiguous: [KEY_A] });
  });

  it("still finds the reachable outboxes when one never opens", async () => {
    const [admin, joiner] = devices(2);
    const drive = await outbox(joiner, "id", { [FOLDER.shareKey]: request(KEY_B) });
    const found = await readJoinRequests(opener({ i2: drive }), {
      identities: ["i1", "i2"],
      folder: FOLDER,
      log: admin.ports.log,
    });
    expect({
      keys: found.requests.map((f) => [f.request.requesterKey, f.identity]),
      ambiguous: found.ambiguous,
    }).toEqual({ keys: [[KEY_B, "i2"]], ambiguous: [] });
  });
});

describe("pendingJoinRequests", () => {
  it("drops enrolled, denied and answered invite requests", () => {
    const keys = ["1", "2", "3", "4", "5"].map((c) => c.repeat(64));
    const found = keys.map((k, i) => ({
      request: {
        folderId: "f1",
        folderName: "Trip",
        requesterKey: k,
        requesterName: "Bo",
        requestedAt: 5,
      },
      identity: `i${i}`,
      viaInvite: i >= 2,
    }));
    const pending = pendingJoinRequests(found, {
      registry: { version: 1, members: { m: { key: keys[0], name: "A", addedAt: 1 } } },
      denied: new Set([keys[1]]),
      answers: { i2: "declined" },
    });
    expect(pending.map((r) => r.requesterKey)).toEqual([keys[3], keys[4]]);
  });
});
