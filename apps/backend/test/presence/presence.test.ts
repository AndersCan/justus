import { afterEach, describe, expect, it } from "vite-plus/test";
import { identityMessage } from "../../src/membership/records.ts";
import type { Drive, DriveStore } from "../../src/ports/drive-store.ts";
import type { PeerNetwork } from "../../src/ports/peer-network.ts";
import {
  createPresence,
  learnDevices,
  memberPresence,
  parseLastSeen,
  peerConnected,
  peerDisconnected,
  serializeLastSeen,
  type DeviceSource,
  type Presence,
} from "../../src/presence/presence.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  createFakePeerNetwork,
  setFakeNodeConnected,
  type FakeHub,
} from "../fakes/fake-world.ts";

type LogEntry = { event: string; fields?: Record<string, unknown> };

const TOPIC = "t".repeat(64);
const hex = (c: string) => c.repeat(64);

function logs() {
  const events: LogEntry[] = [];
  return {
    events,
    log: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
  };
}

async function until(check: () => boolean, options: { ms?: number; what: string }) {
  const ms = options.ms ?? 1000;
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${options.what} within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const networks: PeerNetwork[] = [];
afterEach(async () => {
  await Promise.all(networks.splice(0).map((n) => n.close()));
});

function device(hub: FakeHub, options: { now?: () => number } = {}) {
  const node = addFakeNode(hub);
  setFakeNodeConnected({ hub, node, connected: true });
  const drives = createFakeDriveStore({ hub, node });
  const presence = createPresence({ lastSeen: [] });
  const { events, log } = logs();
  const sources: DeviceSource[] = [];
  const now = options.now ?? (() => 0);
  const peerEvents: string[] = [];
  const learn = () =>
    learnDevices(presence, {
      sources,
      timeoutMs: 500,
      log,
      verify: (p) => drives.verifyIdentity(p),
    });
  const self = {
    drives,
    presence,
    events,
    sources,
    peerEvents,
    network: undefined as unknown as PeerNetwork,
    identity: "",
    start(identityKey: string) {
      const network = createFakePeerNetwork({ hub });
      networks.push(network);
      network.start(identityKey, (e) => {
        if (e.type === "connected") {
          peerEvents.push(e.peerKey);
          peerConnected(presence, { peerKey: e.peerKey, log });
          void learn();
        } else if (e.type === "disconnected") {
          peerDisconnected(presence, { peerKey: e.peerKey, now: now(), log });
        }
      });
      self.network = network;
      return network;
    },
    watch(drive: Drive) {
      drive.onChange(() => void learn());
    },
  };
  return self;
}

type Published = { network: PeerNetwork; drives: DriveStore; identity: string };

/** Publish `/device.json`; `claim` overrides the identity fields (a forger's record). */
async function publishDevice(
  drive: Drive,
  device: Published,
  claim: {
    identityKey?: string;
    identityPublicKey?: string;
    identitySig?: string;
    sign?: boolean;
  } = {},
) {
  const own = (await device.drives.openOwn()).key;
  device.identity = own;
  const record: Record<string, unknown> = {
    name: "phone",
    swarmKey: device.network.peerKey(),
    identityKey: claim.identityKey ?? own,
  };
  if (claim.sign !== false) {
    const [err, signed] = await device.drives.signAsIdentity(identityMessage(drive.key));
    if (err) throw err;
    record.identityPublicKey = claim.identityPublicKey ?? signed.publicKey;
    record.identitySig = claim.identitySig ?? signed.signature;
  }
  await drive.put("/device.json", Buffer.from(JSON.stringify(record)));
}

async function pair(hub: FakeHub, now: () => number) {
  const admin = device(hub, { now });
  const member = device(hub);
  admin.start(hex("a"));
  member.start(hex("b"));
  const memberDrive = await member.drives.openOwn("self");
  const [err, remote] = await admin.drives.open(memberDrive.key, { timeoutMs: 50 });
  if (err) throw err;
  admin.sources.push({ memberKey: memberDrive.key, drive: remote });
  admin.watch(remote);
  await publishDevice(memberDrive, member);
  admin.network.join(TOPIC, { server: true });
  member.network.join(TOPIC, { server: true });
  return { admin, member, memberDrive, memberKey: memberDrive.key };
}

const short = (key: string) => key.slice(0, 8);

describe("presence data", () => {
  it("a member stays connected while any of its connections is open", () => {
    const p = createPresence({ lastSeen: [] });
    const { events, log } = logs();
    p.peerKeys.set(hex("1"), hex("2"));
    peerConnected(p, { peerKey: hex("2"), log });
    peerConnected(p, { peerKey: hex("2"), log });
    expect(peerDisconnected(p, { peerKey: hex("2"), now: 1000, log })).toBe("still-connected");
    expect(memberPresence(p, hex("1"))).toEqual({ connected: true });
    expect(peerDisconnected(p, { peerKey: hex("2"), now: 1000, log })).toBe("member-down");
    expect(memberPresence(p, hex("1"))).toEqual({ connected: false, lastSeenAt: 1000 });
    expect(events.filter((e) => e.fields?.state === "down")).toHaveLength(1);
  });

  it("a connection from a peer that is no member's never marks anyone connected", () => {
    const p = createPresence({ lastSeen: [] });
    const { events, log } = logs();
    p.peerKeys.set(hex("1"), hex("2"));
    peerConnected(p, { peerKey: hex("3"), log });
    expect(memberPresence(p, hex("1"))).toEqual({ connected: false });
    expect(peerDisconnected(p, { peerKey: hex("3"), now: 5, log })).toBe("unknown-peer-down");
    expect(p.lastSeen.size).toBe(0);
    expect(events[0]?.fields?.member).toBeUndefined();
  });

  it("a disconnect for a peer that never connected is an unknown peer going down", () => {
    const p = createPresence({ lastSeen: [] });
    expect(peerDisconnected(p, { peerKey: hex("9"), now: 1, log: () => {} })).toBe(
      "unknown-peer-down",
    );
    expect(p.connections.size).toBe(0);
  });

  it("when two members name the same peer key, the first one learned gets the connection", () => {
    const p = createPresence({ lastSeen: [] });
    p.peerKeys.set(hex("1"), hex("9"));
    p.peerKeys.set(hex("2"), hex("9"));
    peerConnected(p, { peerKey: hex("9"), log: () => {} });
    peerDisconnected(p, { peerKey: hex("9"), now: 7, log: () => {} });
    expect([...p.lastSeen]).toEqual([[hex("1"), 7]]);
  });

  it("an unknown member has only connected: false", () => {
    expect(memberPresence(createPresence({ lastSeen: [] }), hex("1"))).toEqual({
      connected: false,
    });
  });

  it("last-seen times survive a round trip through the stored text, and junk reads as none", () => {
    expect(parseLastSeen('{"a":1,"b":"x"}')).toEqual([["a", 1]]);
    expect(parseLastSeen("garbage")).toEqual([]);
    expect(parseLastSeen("null")).toEqual([]);
    expect(serializeLastSeen(createPresence({ lastSeen: [["a", 1]] }))).toBe('{"a":1}');
  });

  it("a /device.json that never answers is given up after the timeout", async () => {
    const hub = createFakeHub();
    const d = device(hub);
    const drive = await d.drives.openOwn("x");
    const hung = { ...drive, readSmall: () => new Promise<string | undefined>(() => {}) };
    const p: Presence = createPresence({ lastSeen: [] });
    const started = Date.now();
    const learned = await learnDevices(p, {
      sources: [{ memberKey: hex("1"), drive: hung }],
      timeoutMs: 50,
      verify: () => false,
      log: () => {},
    });
    expect(learned).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(p.peerKeys.size).toBe(0);
  });

  it("a /device.json read that throws is logged and reads as missing", async () => {
    const hub = createFakeHub();
    const d = device(hub);
    const drive = await d.drives.openOwn("x");
    const broken = {
      ...drive,
      readSmall: () => Promise.reject(new Error("boom")),
    };
    const { events, log } = logs();
    const learned = await learnDevices(createPresence({ lastSeen: [] }), {
      sources: [{ memberKey: hex("1"), drive: broken }],
      timeoutMs: 50,
      verify: () => false,
      log,
    });
    expect(learned).toBe(false);
    expect(events).toEqual([
      {
        event: "error",
        fields: { where: "drive.read", drive: short(drive.key), path: "/device.json", err: "boom" },
      },
    ]);
  });

  it("a /device.json with a non-hex peer key is ignored", async () => {
    const hub = createFakeHub();
    const d = device(hub);
    const drive = await d.drives.openOwn("x");
    await drive.put("/device.json", Buffer.from(JSON.stringify({ swarmKey: "nothex" })));
    const p = createPresence({ lastSeen: [] });
    const learned = await learnDevices(p, {
      sources: [{ memberKey: hex("1"), drive }],
      timeoutMs: 50,
      verify: () => false,
      log: () => {},
    });
    expect(learned).toBe(false);
    expect(p.peerKeys.size).toBe(0);
  });
});

describe("identity in /device.json", () => {
  async function setup() {
    const hub = createFakeHub();
    const reader = device(hub);
    const forger = device(hub);
    const ben = device(hub);
    for (const d of [reader, forger, ben]) d.start(hex("c"));
    const forgerDrive = await forger.drives.openOwn("album");
    const benDrive = await ben.drives.openOwn("album");
    const benIdentity = (await ben.drives.openOwn()).key;
    const [, benSig] = await ben.drives.signAsIdentity(identityMessage(benDrive.key));
    const learnFrom = async (drive: Drive) => {
      const p = createPresence({ lastSeen: [] });
      await learnDevices(p, {
        sources: [{ memberKey: drive.key, drive }],
        timeoutMs: 500,
        log: () => {},
        verify: (proof) => reader.drives.verifyIdentity(proof),
      });
      return p;
    };
    return { forger, forgerDrive, ben, benDrive, benIdentity, benSig, learnFrom };
  }

  it("a record signed for its own drive gives the member an identity", async () => {
    const { ben, benDrive, benIdentity, learnFrom } = await setup();
    await publishDevice(benDrive, ben);
    const p = await learnFrom(benDrive);
    expect(memberPresence(p, benDrive.key)).toEqual({ connected: false, identity: benIdentity });
  });

  it("a record that copies another device's identity and signature is not trusted", async () => {
    const { forger, forgerDrive, benIdentity, benSig, learnFrom } = await setup();
    await publishDevice(forgerDrive, forger, {
      identityKey: benIdentity,
      identityPublicKey: benSig!.publicKey,
      identitySig: benSig!.signature,
    });
    const p = await learnFrom(forgerDrive);
    expect(memberPresence(p, forgerDrive.key)).toEqual({ connected: false });
    expect(p.peerKeys.size).toBe(1);
  });

  it("a record that claims another identity with the claimant's own signature is not trusted", async () => {
    const { forger, forgerDrive, benIdentity, learnFrom } = await setup();
    await publishDevice(forgerDrive, forger, { identityKey: benIdentity });
    const p = await learnFrom(forgerDrive);
    expect(memberPresence(p, forgerDrive.key)).toEqual({ connected: false });
  });

  it("an unsigned record keeps the member, without an identity", async () => {
    const { ben, benDrive, learnFrom } = await setup();
    await publishDevice(benDrive, ben, { sign: false });
    const p = await learnFrom(benDrive);
    expect(memberPresence(p, benDrive.key)).toEqual({ connected: false });
    expect(p.peerKeys.size).toBe(1);
  });
});

describe("presence on the fake world", () => {
  it("a member shows connected once its connection opens", async () => {
    const hub = createFakeHub();
    const { admin, member, memberKey } = await pair(hub, () => 5000);
    await until(() => memberPresence(admin.presence, memberKey).connected, {
      what: "member never connected",
    });
    expect(memberPresence(admin.presence, memberKey)).toEqual({
      connected: true,
      identity: member.identity,
    });
    expect(admin.events.filter((e) => e.event.startsWith("swarmkey."))).toEqual([
      {
        event: "swarmkey.learned",
        fields: {
          member: short(memberKey),
          swarmkey: short(member.network.peerKey()),
          from: undefined,
        },
      },
    ]);
  });

  it("a member that disconnects shows not connected with a last-seen time", async () => {
    const hub = createFakeHub();
    const { admin, member, memberKey } = await pair(hub, () => 5000);
    await until(() => memberPresence(admin.presence, memberKey).connected, {
      what: "member never connected",
    });
    await member.network.close();
    await until(() => !memberPresence(admin.presence, memberKey).connected, {
      what: "member never showed disconnected",
    });
    expect(memberPresence(admin.presence, memberKey)).toEqual({
      connected: false,
      lastSeenAt: 5000,
      identity: member.identity,
    });
  });

  it("a member that restarts under a new peer key shows connected again", async () => {
    const hub = createFakeHub();
    const { admin, member, memberDrive, memberKey } = await pair(hub, () => 5000);
    await until(() => memberPresence(admin.presence, memberKey).connected, {
      what: "member never connected",
    });
    const oldKey = member.network.peerKey();
    await member.network.close();
    await until(() => !memberPresence(admin.presence, memberKey).connected, {
      what: "member never showed disconnected",
    });
    const restarted = member.start(hex("b"));
    expect(restarted.peerKey()).not.toBe(oldKey);
    await publishDevice(memberDrive, member);
    restarted.join(TOPIC, { server: true });
    await until(() => memberPresence(admin.presence, memberKey).connected, {
      what: "member never connected again under its new key",
    });
    expect(admin.events).toContainEqual({
      event: "swarmkey.changed",
      fields: {
        member: short(memberKey),
        swarmkey: short(restarted.peerKey()),
        from: short(oldKey),
      },
    });
  });

  it("a peer that is not an album member is never shown as one", async () => {
    const hub = createFakeHub();
    const { admin, memberKey, member } = await pair(hub, () => 5000);
    await until(() => memberPresence(admin.presence, memberKey).connected, {
      what: "member never connected",
    });
    await member.network.close();
    await until(() => !memberPresence(admin.presence, memberKey).connected, {
      what: "member never showed disconnected",
    });
    const stranger = device(hub);
    stranger.start(hex("c"));
    const strangerDrive = await stranger.drives.openOwn("self");
    await publishDevice(strangerDrive, stranger);
    const seen = admin.peerEvents.length;
    stranger.network.join(TOPIC, { server: true });
    await until(() => admin.peerEvents.length > seen, {
      what: "stranger never connected to the admin",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(memberPresence(admin.presence, memberKey).connected).toBe(false);
    expect([...admin.presence.peerKeys.values()]).not.toContain(stranger.network.peerKey());
  });
});
