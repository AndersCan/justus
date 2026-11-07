// Invite rules on the fakes. The fake network has no answer channel (its
// `sendAnswer` is false), so sends go to a recording stub; real delivery is
// covered by p2p-scenarios.ts.
import { describe, expect, it } from "vite-plus/test";
import type { Drive } from "../../src/ports/drive-store.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import { checkAsk, fileInviteAsk } from "../../src/membership/invites.ts";
import { readJoinRequests } from "../../src/membership/join.ts";

const hex = (c: string) => c.repeat(64);
const C = hex("c");

function devices(n: number) {
  const hub = createFakeHub();
  return Array.from({ length: n }, () => {
    const node = addFakeNode(hub);
    setFakeNodeConnected({ hub, node, connected: true });
    return {
      drives: createFakeDriveStore({ hub, node }),
      log: (_event: string, _fields?: Record<string, unknown>) => {},
    };
  });
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

async function askWorld() {
  const [admin, joiner] = devices(2);
  const album = await admin.drives.openOwn("folder/f1");
  const identity = await joiner.drives.openOwn();
  const askDrive = await joiner.drives.openOwn(`ask/${C}`);
  const adminReads = (inviteCode: string) =>
    readJoinRequests((k) => admin.drives.open(k, { timeoutMs: 200 }), {
      identities: [identity.key],
      folder: { id: "f1", name: "Trip", shareKey: album.key, inviteCode },
      log: admin.log,
    });
  const ask = (extra: { albumName?: unknown; ownerName?: unknown } = {}) =>
    fileInviteAsk(identity, {
      askDriveKey: askDrive.key,
      code: C,
      owner: hex("a"),
      albumName: "Trip",
      ownerName: "Maya",
      requesterName: "Nils",
      now: 1234,
      log: joiner.log,
      ...extra,
    });
  return { album, identity, askDrive, adminReads, ask };
}

const outbox = async (identity: Drive) =>
  (await identity.readSmall("/requests.json", 1024 * 1024)) ?? "";

describe("invites: asking through a link", () => {
  it("an ask puts the code, never a key, in the joiner's outbox", async () => {
    const { album, identity, askDrive, ask } = await askWorld();
    const [error, result] = await ask();
    expect(error, "ask: no error").toBeNull();
    expect(result, "ask: the ask record").toEqual({
      code: C,
      owner: hex("a"),
      albumName: "Trip",
      ownerName: "Maya",
      askedAt: 1234,
      status: "waiting",
    });
    const text = await outbox(identity);
    expect(JSON.parse(text), "ask: the outbox holds a code, never a key").toEqual({
      version: 1,
      requests: {
        ["invite:" + C]: {
          requesterKey: askDrive.key,
          requesterName: "Nils",
          invite: C,
          requestedAt: 1234,
        },
      },
    });
    expect(text.includes(album.key), "ask: no album key in the outbox").toBe(false);
    expect(text.includes("shareKey"), "ask: no shareKey in the outbox").toBe(false);
    expect(Object.keys(JSON.parse(text).requests["invite:" + C]), "ask: entry key order").toEqual([
      "requesterKey",
      "requesterName",
      "invite",
      "requestedAt",
    ]);
    expect(Object.keys(result!), "ask: result key order").toEqual([
      "code",
      "owner",
      "albumName",
      "ownerName",
      "askedAt",
      "status",
    ]);
  });

  it("the Admin finds the ask as an invite request", async () => {
    const { identity, askDrive, adminReads, ask } = await askWorld();
    await ask();
    const found = await adminReads(C);
    expect(found.requests.length, "admin: one request").toBe(1);
    expect(found.requests[0]!.viaInvite, "admin: it came through the invite").toBe(true);
    expect(found.requests[0]!.identity, "admin: the asker's identity").toBe(identity.key);
    expect(found.requests[0]!.request.requesterKey, "admin: the ask drive").toBe(askDrive.key);
    expect(found.requests[0]!.request.requesterName, "admin: the name").toBe("Nils");
    expect((await adminReads(hex("d"))).requests, "admin: another code finds none").toEqual([]);
  });

  it("an ask keeps the joiner's other requests", async () => {
    const { identity, ask } = await askWorld();
    const old = {
      version: 1,
      requests: {
        [hex("9")]: { requesterKey: hex("8"), requesterName: "Nils", requestedAt: 1 },
      },
    };
    await identity.put("/requests.json", json(old));
    await ask();
    const after = JSON.parse(await outbox(identity));
    expect(Object.keys(after.requests).length, "ask: both entries stay").toBe(2);
    expect(after.requests[hex("9")], "ask: the old entry is byte-equal").toEqual(
      old.requests[hex("9")],
    );
  });

  it("names the link carried are clipped, and missing ones say who", async () => {
    const { ask } = await askWorld();
    const [, blank] = await ask({ albumName: "  ", ownerName: 7 });
    expect(blank?.albumName, "ask: blank album name").toBe("this album");
    expect(blank?.ownerName, "ask: non-string owner name").toBe("the Admin");
    const [, long] = await ask({ albumName: "x".repeat(200) });
    expect(long?.albumName, "ask: clipped to 80").toBe("x".repeat(80));
  });

  it("a failed write is a value, not a throw", async () => {
    const stub = {
      key: hex("1"),
      readSmall: async () => undefined,
      put: async () => {
        throw new Error("disk full");
      },
    } as unknown as Drive;
    const [error, result] = await fileInviteAsk(stub, {
      askDriveKey: hex("2"),
      code: C,
      owner: hex("a"),
      albumName: "Trip",
      ownerName: "Maya",
      requesterName: "Nils",
      now: 1,
      log: () => {},
    });
    expect(error, "ask: the write failure").toEqual({ kind: "write-failed", message: "disk full" });
    expect(result, "ask: no ask").toBeNull();
  });

  it("an ask needs two keys, a new album and no ask before", () => {
    const declined = { code: hex("e"), status: "declined" };
    const held = { folders: [{ invite: { code: hex("f") } }, {}], asks: [declined] };
    expect(checkAsk({ code: "xyz", owner: hex("a") }, held).kind, "check: short code").toBe(
      "invalid",
    );
    expect(checkAsk({ code: C, owner: 5 }, held).kind, "check: non-string owner").toBe("invalid");
    expect(
      checkAsk({ code: C.toUpperCase(), owner: hex("A") }, held),
      "check: keys are lowercased",
    ).toEqual({ kind: "new", code: C, owner: hex("a") });
    expect(checkAsk({ code: hex("f"), owner: hex("a") }, held).kind, "check: own album").toBe(
      "have-album",
    );
    const known = checkAsk({ code: hex("e"), owner: hex("a") }, held);
    expect(known.kind, "check: asked before").toBe("known");
    expect(known.kind === "known" && known.ask, "check: the same object").toBe(declined);
  });
});
