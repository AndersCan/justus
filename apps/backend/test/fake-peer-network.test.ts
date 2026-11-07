import { createFakeHub, createFakePeerNetwork } from "./fakes/fake-world.ts";
import type { PeerEvent } from "../src/ports/peer-network.ts";
import { describe, expect, it } from "vite-plus/test";

const topic = "ab".repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 20));

function started(hub: ReturnType<typeof createFakeHub>, legacy?: boolean) {
  const network = createFakePeerNetwork({ hub, legacy });
  const events: string[] = [];
  const all: PeerEvent[] = [];
  network.start("cd".repeat(32), (e) => {
    events.push(e.type);
    all.push(e);
  });
  return { network, events, all };
}

async function pair(legacyA?: boolean, legacyB?: boolean) {
  const hub = createFakeHub();
  const a = started(hub, legacyA);
  const b = started(hub, legacyB);
  a.network.join(topic, { server: true });
  b.network.join(topic, { server: false });
  await settle();
  const connOf = (n: ReturnType<typeof started>) => {
    const e = n.all.find((x) => x.type === "connected");
    if (!e || e.type !== "connected") throw new Error("not connected");
    return e.conn;
  };
  return { a, b, aConn: connOf(a), bConn: connOf(b) };
}

describe("fake peer network matching", () => {
  it("does not connect two client-only networks", async () => {
    const hub = createFakeHub();
    const a = started(hub);
    const b = started(hub);
    a.network.join(topic, { server: false });
    b.network.join(topic, { server: false });
    await settle();
    expect(a.events).toEqual([]);
    expect(b.network.connectionCount()).toBe(0);
  });

  it("stops matching a topic after leave", async () => {
    const hub = createFakeHub();
    const a = started(hub);
    const b = started(hub);
    a.network.join(topic, { server: true });
    a.network.leave(topic);
    b.network.join(topic, { server: false });
    await settle();
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });
});

describe("fake peer network answers", () => {
  it("delivers a copy of the answer to the peer", async () => {
    const { a, b, aConn } = await pair();
    const sent = { id: "x", nested: { n: 1 } };
    expect(a.network.sendAnswer(aConn, sent as never)).toBe(true);
    sent.nested.n = 2;
    await settle();
    const got = b.all.find((e) => e.type === "answer");
    expect(got && got.type === "answer" && got.value).toEqual({ id: "x", nested: { n: 1 } });
  });

  it("returns false for an unknown connection", async () => {
    const { a } = await pair();
    expect(a.network.sendAnswer("nope" as never, {} as never)).toBe(false);
  });

  it("returns false after the receiving side closes", async () => {
    const { a, b, aConn } = await pair();
    await b.network.close();
    expect(a.network.sendAnswer(aConn, {} as never)).toBe(false);
  });
});

describe("fake peer network legacy phones", () => {
  it("sends version events when neither side is legacy", async () => {
    const { a, b } = await pair();
    expect(a.events).toContain("version");
    expect(b.events).toContain("version");
  });

  it.each([
    [true, false],
    [false, true],
  ])("sends no version event when legacy is %s/%s", async (la, lb) => {
    const { a, b } = await pair(la, lb);
    expect(a.events).not.toContain("version");
    expect(b.events).not.toContain("version");
    expect(a.events).toContain("identified");
    expect(b.events).toContain("identified");
  });
});
