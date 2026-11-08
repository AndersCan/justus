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
import {
  checkAsk,
  fileInviteAsk,
  offerAlbumTo,
  offerToTake,
  replyTo,
  tellIdentity,
  withdrawInvite,
  type InvitePorts,
} from "../../src/membership/invites.ts";
import type { ChannelMessage } from "../../src/membership/records.ts";
import { isEnrolled } from "../../src/membership/records.ts";
import {
  acceptJoinRequest,
  pendingJoinRequests,
  readJoinRequests,
  readRegistry,
} from "../../src/membership/join.ts";

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
    expect(checkAsk({ code: hex("e"), owner: hex("a") }, held), "check: declined is new").toEqual({
      kind: "new",
      code: hex("e"),
      owner: hex("a"),
    });
    const waiting = { code: hex("d"), status: "waiting" };
    const known = checkAsk(
      { code: hex("d"), owner: hex("a") },
      { folders: [], asks: [declined, waiting] },
    );
    expect(known.kind, "check: asked before").toBe("known");
    expect(known.kind === "known" && known.ask, "check: the same object").toBe(waiting);
  });
});

describe("invites: the Admin's reply", () => {
  const J = hex("j");
  const none = { registry: { version: 1, members: {} } as never, denied: new Set<string>() };

  it("respond: a declined ask is final", async () => {
    expect(
      replyTo({ askedBy: J, enrolled: false }, { approve: false }),
      "reply: decline-ask",
    ).toEqual({
      kind: "decline-ask",
      identity: J,
    });
    const { identity, adminReads, ask } = await askWorld();
    await ask();
    const found = await adminReads(C);
    const answers = { [identity.key]: "declined" as const };
    expect(
      pendingJoinRequests(found.requests, { ...none, answers }),
      "list: declined ask is hidden",
    ).toEqual([]);
    await ask();
    expect(
      pendingJoinRequests((await adminReads(C)).requests, { ...none, answers }),
      "list: still hidden after asking again",
    ).toEqual([]);
  });

  it("respond: a plain decline hides the request for this session only", async () => {
    expect(replyTo({ enrolled: false }, { approve: false }), "reply: decline").toEqual({
      kind: "decline",
    });
    const { askDrive, adminReads, ask } = await askWorld();
    await ask();
    const found = (await adminReads(C)).requests;
    const denied = new Set([askDrive.key]);
    expect(
      pendingJoinRequests(found, { ...none, denied, answers: undefined }),
      "list: denied is hidden",
    ).toEqual([]);
    expect(
      pendingJoinRequests(found, { ...none, answers: undefined }),
      "list: not denied is listed",
    ).toHaveLength(1);
  });

  it("respond: accepting an ask seats the asker and the request leaves the list", async () => {
    expect(replyTo({ askedBy: J, enrolled: false }, { approve: true }), "reply: accept").toEqual({
      kind: "accept",
      identity: J,
    });
    expect(replyTo({ enrolled: false }, { approve: true }), "reply: plain accept").toEqual({
      kind: "accept",
    });
    const { album, askDrive, adminReads, ask } = await askWorld();
    await ask();
    const log = () => {};
    const registry = await readRegistry(album, { log });
    const requests = (await adminReads(C)).requests;
    const pending = pendingJoinRequests(requests, {
      registry,
      denied: new Set(),
      answers: undefined,
    });
    const [error, accepted] = await acceptJoinRequest(album, {
      registry,
      requesterKey: askDrive.key,
      requests: pending,
    });
    expect(error, "accept: no error").toBeNull();
    expect(accepted?.member.name, "accept: the asker's name").toBe("Nils");
    const after = await readRegistry(album, { log });
    expect(isEnrolled(after, askDrive.key), "accept: seated").toBe(true);
    expect(
      pendingJoinRequests((await adminReads(C)).requests, {
        registry: after,
        denied: new Set(),
        answers: undefined,
      }),
      "list: the request left",
    ).toEqual([]);
  });

  it("respond: someone already in is not added twice, and a decline still wins", () => {
    expect(replyTo({ enrolled: true }, { approve: true }).kind, "reply: already in").toBe(
      "already-enrolled",
    );
    expect(replyTo({ enrolled: true }, { approve: false }).kind, "reply: decline wins").toBe(
      "decline",
    );
    expect(
      replyTo({ askedBy: J, enrolled: true }, { approve: false }).kind,
      "reply: ask decline wins",
    ).toBe("decline-ask");
  });

  it("requests: a friend with an open invite is not listed", async () => {
    const { identity, adminReads, ask } = await askWorld();
    await ask();
    const found = (await adminReads(C)).requests;
    expect(
      pendingJoinRequests(found, { ...none, answers: undefined, invited: new Set([identity.key]) }),
      "list: invited friend hidden",
    ).toEqual([]);
    expect(
      pendingJoinRequests(found, { ...none, answers: undefined }),
      "list: without invited it is listed",
    ).toHaveLength(1);
  });
});

function stubPorts(conns: Array<{ conn: number; identity: string; proves?: string | null }>) {
  const sent: Array<{ conn: number; message: ChannelMessage }> = [];
  const hooks: { onSend?: () => void } = {};
  const ports: InvitePorts = {
    connections: () => conns.map(({ conn, identity }) => ({ conn, identity })),
    provenIdentity: async (conn) => {
      const c = conns.find((x) => x.conn === conn);
      return c?.proves === null ? undefined : (c?.proves ?? c?.identity);
    },
    sendAnswer: (conn: number, message: ChannelMessage) => {
      sent.push({ conn, message });
      hooks.onSend?.();
      return true;
    },
  };
  return { ports, sent, hooks };
}

const F = hex("f");
const G = hex("9");
const offer = { code: C, albumName: "Trip", ownerName: "Maya" };

describe("invites: friends and turning a link off", () => {
  it("send: only on connections proven to be that identity", async () => {
    const { ports, sent } = stubPorts([
      { conn: 1, identity: F },
      { conn: 2, identity: F, proves: null },
      { conn: 3, identity: hex("e") },
    ]);
    const count = await tellIdentity(ports, {
      identity: F,
      message: { kind: "offerTaken", code: C },
      timeoutMs: 50,
    });
    expect(count, "send: one send taken").toBe(1);
    expect(sent, "send: only the proven connection").toEqual([
      { conn: 1, message: { kind: "offerTaken", code: C } },
    ]);
  });

  it("offer: the friend's phone seeing it ends the wait", async () => {
    const { ports, sent, hooks } = stubPorts([{ conn: 1, identity: F }]);
    let resolve: (r: "seen" | "refused") => void = () => {};
    const reply = new Promise<"seen" | "refused">((r) => (resolve = r));
    hooks.onSend = () => resolve("seen");
    const result = await offerAlbumTo(ports, {
      identity: F,
      offer,
      reply,
      reachMs: 500,
      resendMs: 20,
      isClosed: () => false,
    });
    expect(result, "offer: seen").toEqual([null, "seen"]);
    expect(sent.length, "offer: sent once").toBe(1);
    expect(sent[0]?.message, "offer: the message").toEqual({ kind: "offer", ...offer });
    expect(Object.keys(sent[0]?.message ?? {}), "offer: key order").toEqual([
      "kind",
      "code",
      "albumName",
      "ownerName",
    ]);
  });

  it("offer: a refusal is reported as one", async () => {
    const { ports } = stubPorts([{ conn: 1, identity: F }]);
    const result = await offerAlbumTo(ports, {
      identity: F,
      offer,
      reply: Promise.resolve("refused"),
      reachMs: 500,
      resendMs: 20,
      isClosed: () => false,
    });
    expect(result, "offer: refused").toEqual([
      { kind: "refused", message: "The friend's phone turned the invite down" },
      null,
    ]);
  });

  it("offer: resent until the deadline, then the phone did not answer", async () => {
    const { ports, sent } = stubPorts([{ conn: 1, identity: F }]);
    const started = Date.now();
    const result = await offerAlbumTo(ports, {
      identity: F,
      offer,
      reply: new Promise(() => {}),
      reachMs: 60,
      resendMs: 20,
      isClosed: () => false,
    });
    expect(result, "offer: unreachable").toEqual([
      { kind: "unreachable", message: "The friend's phone did not answer" },
      null,
    ]);
    expect(sent.length, "offer: resent").toBeGreaterThanOrEqual(2);
    expect(sent.length, "offer: not resent forever").toBeLessThanOrEqual(4);
    expect(Date.now() - started, "offer: stops at the deadline").toBeLessThan(200);
  });

  it("offer: a closing app stops at once", async () => {
    const { ports, sent } = stubPorts([{ conn: 1, identity: F }]);
    const [error] = await offerAlbumTo(ports, {
      identity: F,
      offer,
      reply: new Promise(() => {}),
      reachMs: 500,
      resendMs: 20,
      isClosed: () => true,
    });
    expect(error?.kind, "offer: unreachable when closing").toBe("unreachable");
    expect(sent, "offer: nothing sent").toEqual([]);
  });

  it("turn off: every invited friend is told and the old code is kept", async () => {
    const { ports, sent } = stubPorts([
      { conn: 1, identity: F },
      { conn: 2, identity: G },
    ]);
    const A = hex("a");
    const B = hex("b");
    const album = { invite: { code: A }, invited: [F, G], retiredInvites: [hex("1")] };
    const before = structuredClone(album);
    const next = await withdrawInvite(ports, { album, newCode: B });
    expect(next, "turn off: new code, old kept").toEqual({
      invite: { code: B },
      retired: A,
      retiredInvites: [hex("1"), A],
    });
    expect(sent, "turn off: both friends told").toEqual([
      { conn: 1, message: { kind: "offerWithdrawn", code: A } },
      { conn: 2, message: { kind: "offerWithdrawn", code: A } },
    ]);
    expect(album, "turn off: album untouched").toEqual(before);
  });

  it("turn off: each friend is told the code on their own card", async () => {
    const { ports, sent } = stubPorts([
      { conn: 1, identity: F },
      { conn: 2, identity: G },
    ]);
    const C1 = hex("1");
    const C2 = hex("2");
    await withdrawInvite(ports, {
      album: { invite: { code: C2 }, invited: [F, G], heldAsks: { [F]: C1 } },
      newCode: hex("b"),
    });
    expect(sent, "turn off: held code for F, current for G").toEqual([
      { conn: 1, message: { kind: "offerWithdrawn", code: C1 } },
      { conn: 2, message: { kind: "offerWithdrawn", code: C2 } },
    ]);
  });

  it("turn off: an album without a link sends nothing", async () => {
    const { ports, sent } = stubPorts([{ conn: 1, identity: F }]);
    const next = await withdrawInvite(ports, { album: { invited: [F] }, newCode: hex("b") });
    expect(next, "turn off: only a new code").toEqual({
      invite: { code: hex("b") },
      retiredInvites: undefined,
    });
    expect("retired" in next, "turn off: no retired key").toBe(false);
    expect(sent, "turn off: nothing sent").toEqual([]);
  });

  it("turn off: an ask with the old code no longer reaches the Admin", async () => {
    const { adminReads, ask } = await askWorld();
    await ask();
    expect((await adminReads(C)).requests, "turn off: found before").toHaveLength(1);
    const { ports } = stubPorts([]);
    const next = await withdrawInvite(ports, {
      album: { invite: { code: C } },
      newCode: hex("b"),
    });
    expect((await adminReads(next.invite.code)).requests, "turn off: not found after").toEqual([]);
  });

  it("take: a held invite needs an ask unless one is already out", () => {
    const held = { code: C, owner: hex("a"), albumName: "Trip", ownerName: "Maya" };
    const waiting = { code: C, status: "waiting" };
    const declined = { code: C, status: "declined" };
    expect(
      offerToTake({ offers: [held], asks: [] }, { code: C, owner: hex("b") }).kind,
      "take: other owner",
    ).toBe("gone");
    const fresh = offerToTake({ offers: [held], asks: [] }, { code: C, owner: hex("a") });
    expect(fresh.kind === "file-ask" && fresh.offer, "take: no ask yet").toBe(held);
    expect(
      offerToTake({ offers: [held], asks: [declined] }, { code: C, owner: hex("a") }).kind,
      "take: declined ask is refiled",
    ).toBe("file-ask");
    expect(
      offerToTake(
        { offers: [held], asks: [{ code: C, status: "linkOff" }] },
        { code: C, owner: hex("a") },
      ).kind,
      "take: linkOff ask is refiled",
    ).toBe("file-ask");
    const out = offerToTake({ offers: [held], asks: [waiting] }, { code: C, owner: hex("a") });
    expect(out.kind === "asked" && out.ask, "take: ask already out").toBe(waiting);
  });
});
