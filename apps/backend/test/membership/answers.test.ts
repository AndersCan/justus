// Answer-channel rules on the fakes: who a phone is proven to be, what it is
// owed, and what an arriving answer settles.
import { describe, expect, it } from "vite-plus/test";
import type { PeerEvent } from "../../src/ports/peer-network.ts";
import {
  addFakeNode,
  createFakeDriveStore,
  createFakeHub,
  createFakePeerNetwork,
  setFakeNodeConnected,
} from "../fakes/fake-world.ts";
import {
  answersOwed,
  deletedAlbumAnswers,
  arrivingAnswer,
  deliverOwed,
  forgetSent,
  proveIdentity,
  type AnswerLog,
  type ClaimedConn,
  type OwingAlbum,
} from "../../src/membership/answers.ts";
import type { Answer } from "../../src/membership/records.ts";

const hex = (c: string) => c.repeat(64);
const TOPIC = hex("7");
const CODE = hex("c");
const RETIRED = hex("d");
const SHARE = hex("e");
const noLog: AnswerLog = () => {};

async function waitFor(check: () => boolean, what: string) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function phones(names: string[]) {
  const hub = createFakeHub();
  return Promise.all(
    names.map(async (name) => {
      const node = addFakeNode(hub);
      setFakeNodeConnected({ hub, node, connected: true });
      const drives = createFakeDriveStore({ hub, node });
      const identity = await drives.openOwn();
      const network = createFakePeerNetwork({ hub });
      const events: PeerEvent[] = [];
      await identity.put(
        "/device.json",
        Buffer.from(
          JSON.stringify({ name, swarmKey: network.peerKey(), identityKey: identity.key }),
        ),
      );
      network.start(identity.key, (e) => events.push(e));
      return { name, drives, identity, network, events };
    }),
  );
}
type Phone = Awaited<ReturnType<typeof phones>>[number];

async function meet(a: Phone, b: Phone) {
  a.network.join(TOPIC, { server: true });
  b.network.join(TOPIC, { server: true });
  const sees = (p: Phone, other: Phone) =>
    p.events.some((e) => e.type === "identified" && e.identityKey === other.identity.key);
  await waitFor(() => sees(a, b) && sees(b, a), `${a.name} and ${b.name} to meet`);
}

/** The connection `p` holds to `other`, as photo-store's bookkeeping sees it. */
function connTo(p: Phone, other: Phone) {
  const found = p.events.find(
    (e) => e.type === "identified" && e.identityKey === other.identity.key,
  );
  if (found?.type !== "identified") throw new Error("not connected");
  const connected = p.events.find((e) => e.type === "connected" && e.conn === found.conn);
  if (connected?.type !== "connected") throw new Error("no connected event");
  return { conn: found.conn, peerKey: connected.peerKey, identity: other.identity.key };
}

function prove(p: Phone, conn: () => ClaimedConn | undefined, attempts = 2, log = noLog) {
  return proveIdentity((k) => p.drives.open(k, { timeoutMs: 200 }), {
    connId: 1,
    conn,
    ownIdentity: p.identity.key,
    attempts,
    waitMs: 10,
    log,
  });
}

const album = (extra: Partial<OwingAlbum> = {}): OwingAlbum => ({
  role: "creator",
  shareKey: SHARE,
  invite: { code: CODE },
  answers: { [hex("b")]: "accepted" },
  ...extra,
});

describe("answers: proving who a connection is", () => {
  it("proof: a phone whose device file names its connection is proven", async () => {
    const [a, b] = await phones(["a", "b"]);
    await meet(a, b);
    const c = connTo(a, b);
    expect(await prove(a, () => ({ ...c, verified: false }))).toBe(b.identity.key);
  });

  it("proof: a phone that claims another identity is never proven", async () => {
    const [a, b, c] = await phones(["a", "b", "c"]);
    await meet(a, c);
    const lying = { identity: b.identity.key, peerKey: connTo(a, c).peerKey, verified: false };
    let reads = 0;
    expect(await prove(a, () => (reads++, lying), 3)).toBeUndefined();
    expect(reads).toBe(3);
  });

  it("proof: a closed connection stops the proof", async () => {
    const [a] = await phones(["a"]);
    let opened = 0;
    const result = await proveIdentity(
      async () => {
        opened++;
        return [new Error("no"), null];
      },
      {
        connId: 1,
        conn: () => undefined,
        ownIdentity: a.identity.key,
        attempts: 3,
        waitMs: 10,
        log: noLog,
      },
    );
    expect(result).toBeUndefined();
    expect(opened).toBe(0);
  });

  it("proof: our own identity is never proven", async () => {
    const [a] = await phones(["a"]);
    const own = { identity: a.identity.key, peerKey: a.network.peerKey(), verified: false };
    expect(await prove(a, () => own)).toBeUndefined();
  });

  it("proof: an identity drive that cannot be opened logs and is not proven", async () => {
    const [a] = await phones(["a"]);
    const logs: string[] = [];
    const result = await proveIdentity(async () => [new Error("unreachable"), null], {
      connId: 4,
      conn: () => ({ identity: hex("9"), peerKey: hex("8"), verified: false }),
      ownIdentity: a.identity.key,
      attempts: 1,
      waitMs: 1,
      log: (event, fields) => logs.push(`${event}:${fields?.where}:${fields?.conn}`),
    });
    expect(result).toBeUndefined();
    expect(logs).toEqual(["error:verifiedIdentity:4"]);
  });

  it("proof: an already verified connection is trusted without reading a drive", async () => {
    const [a] = await phones(["a"]);
    const result = await proveIdentity(
      async () => {
        throw new Error("must not open");
      },
      {
        connId: 1,
        conn: () => ({ identity: hex("9"), peerKey: undefined, verified: true }),
        ownIdentity: a.identity.key,
        attempts: 1,
        waitMs: 1,
        log: noLog,
      },
    );
    expect(result).toBe(hex("9"));
  });
});

describe("answers: what is owed", () => {
  it("owed: an accepted answer carries the album key under the current and each retired code, a declined one carries no key", () => {
    const b = hex("b");
    expect(answersOwed([album({ retiredInvites: [RETIRED] })], b)).toEqual([
      { code: CODE, answer: "accepted", shareKey: SHARE },
      { code: RETIRED, answer: "accepted", shareKey: SHARE },
    ]);
    expect(answersOwed([album({ answers: { [b]: "declined" } })], b)).toEqual([
      { code: CODE, answer: "declined" },
    ]);
  });

  it("owed: movedFrom rides on every accepted answer, never on a declined one", () => {
    const b = hex("b");
    const movedFrom = [hex("d"), hex("e")];
    expect(answersOwed([album({ retiredInvites: [RETIRED], movedFrom })], b)).toEqual([
      { code: CODE, answer: "accepted", shareKey: SHARE, movedFrom },
      { code: RETIRED, answer: "accepted", shareKey: SHARE, movedFrom },
    ]);
    expect(answersOwed([album({ answers: { [b]: "declined" }, movedFrom })], b)).toEqual([
      { code: CODE, answer: "declined" },
    ]);
  });

  it("owed: only creator albums with an invite and an answer for that identity count", () => {
    const b = hex("b");
    expect(
      answersOwed(
        [
          album({ role: "member" }),
          album({ invite: undefined }),
          album({ answers: { [hex("f")]: "accepted" } }),
          album({ answers: undefined }),
        ],
        b,
      ),
    ).toEqual([]);
  });
});

async function adminAndJoiners() {
  const [admin, joiner, other] = await phones(["admin", "joiner", "other"]);
  await meet(admin, joiner);
  await meet(admin, other);
  const toJoiner = connTo(admin, joiner);
  const toOther = connTo(admin, other);
  const sent = new Map<number, Set<string>>([
    [toJoiner.conn, new Set()],
    [toOther.conn, new Set()],
  ]);
  const ports = (claims: { conn: number; identity: string }[]) => ({
    connections: () => claims.map((c) => ({ ...c, sent: sent.get(c.conn)! })),
    provenIdentity: (conn: number) =>
      prove(admin, () => {
        const c = [toJoiner, toOther].find((x) => x.conn === conn)!;
        return {
          identity: claims.find((x) => x.conn === conn)?.identity,
          peerKey: c.peerKey,
          verified: false,
        };
      }),
    sendAnswer: admin.network.sendAnswer.bind(admin.network),
  });
  return { admin, joiner, other, toJoiner, toOther, sent, ports };
}

describe("answers: a turned-off link", () => {
  const b = hex("b");
  const asked = (requestedAt: number, code = RETIRED) => [{ code, requestedAt }];

  it("owed: a retired code asked through with no answer gets a linkOff", () => {
    expect(
      answersOwed([album({ answers: undefined, retiredInvites: [RETIRED] })], b, asked(7)),
    ).toEqual([{ code: RETIRED, answer: "linkOff", askedAt: 7 }]);
  });

  it("owed: a linkOff carries why for a retired code with a recorded reason, and no key without one", () => {
    const owed = (retiredWhy?: OwingAlbum["retiredWhy"]) =>
      answersOwed(
        [album({ answers: undefined, retiredInvites: [RETIRED], retiredWhy })],
        b,
        asked(7),
      );
    expect(owed({ [RETIRED]: "turnedOff" })).toEqual([
      { code: RETIRED, answer: "linkOff", askedAt: 7, why: "turnedOff" },
    ]);
    expect(owed({ [RETIRED]: "replaced" })).toEqual([
      { code: RETIRED, answer: "linkOff", askedAt: 7, why: "replaced" },
    ]);
    expect(owed({ [hex("9")]: "replaced" })).toEqual([
      { code: RETIRED, answer: "linkOff", askedAt: 7 },
    ]);
    expect(Object.keys(owed()[0]!)).not.toContain("why");
  });

  it("owed: a held ask through a retired code gets no linkOff", () => {
    expect(
      answersOwed(
        [album({ answers: undefined, retiredInvites: [RETIRED], heldAsks: { [b]: RETIRED } })],
        b,
        asked(7),
      ),
    ).toEqual([]);
  });

  it("owed: a hold for someone else does not shield this ask", () => {
    expect(
      answersOwed(
        [
          album({
            answers: undefined,
            retiredInvites: [RETIRED],
            heldAsks: { [hex("c")]: RETIRED },
          }),
        ],
        b,
        asked(7),
      ),
    ).toEqual([{ code: RETIRED, answer: "linkOff", askedAt: 7 }]);
  });

  it("owed: the current code asked through gets no linkOff", () => {
    expect(answersOwed([album({ answers: undefined })], b, asked(7, CODE))).toEqual([]);
  });

  it("owed: an accepted answer is not followed by a linkOff", () => {
    expect(answersOwed([album({ retiredInvites: [RETIRED] })], b, asked(7))).toEqual([
      { code: CODE, answer: "accepted", shareKey: SHARE },
      { code: RETIRED, answer: "accepted", shareKey: SHARE },
    ]);
  });

  it("owed: a decline covering the ask is the only answer, an older decline is followed by a linkOff", () => {
    const declined = (askedAt: number) =>
      album({
        answers: { [b]: "declined" },
        declinedAsks: { [b]: askedAt },
        retiredInvites: [RETIRED],
      });
    expect(answersOwed([declined(7)], b, asked(7))).toEqual([
      { code: CODE, answer: "declined", askedAt: 7 },
      { code: RETIRED, answer: "declined", askedAt: 7 },
    ]);
    expect(answersOwed([declined(5)], b, asked(7))).toEqual([
      { code: CODE, answer: "declined", askedAt: 5 },
      { code: RETIRED, answer: "declined", askedAt: 5 },
      { code: RETIRED, answer: "linkOff", askedAt: 7 },
    ]);
  });

  it("owed: another album's retired code gets no linkOff", () => {
    expect(
      answersOwed([album({ answers: undefined, retiredInvites: [hex("9")] })], b, asked(7)),
    ).toEqual([]);
  });

  it("delivery: a linkOff is sent for each ask time, once per connection", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    let requestedAt = 7;
    const options = {
      identity: id,
      owed: () =>
        answersOwed(
          [album({ answers: undefined, retiredInvites: [RETIRED] })],
          id,
          asked(requestedAt),
        ),
      log: noLog,
    };
    const ports = w.ports([{ conn: w.toJoiner.conn, identity: id }]);
    expect((await deliverOwed(ports, options)).sent).toBe(1);
    expect((await deliverOwed(ports, options)).sent).toBe(0);
    requestedAt = 9;
    expect((await deliverOwed(ports, options)).sent).toBe(1);
  });

  describe("arriving", () => {
    const OWNER = hex("a");
    const ask = { code: RETIRED, owner: OWNER, status: "waiting", askedAt: 7 };
    const arrive = (who: string | undefined, value: unknown, list = [ask]) =>
      arrivingAnswer(
        { provenIdentity: async () => who },
        {
          conn: 1,
          value,
          refused: false,
          asks: () => list,
        },
      );
    const linkOff = (askedAt: number) => ({ code: RETIRED, answer: "linkOff", askedAt });

    it("settles a waiting ask from the proven owner", async () => {
      expect(await arrive(OWNER, linkOff(7))).toEqual({ kind: "linkOff", code: RETIRED });
    });
    it("passes the reason through, and drops one it does not know", async () => {
      expect(await arrive(OWNER, { ...linkOff(7), why: "replaced" })).toEqual({
        kind: "linkOff",
        code: RETIRED,
        why: "replaced",
      });
      expect(await arrive(OWNER, { ...linkOff(7), why: "removed" })).toEqual({
        kind: "linkOff",
        code: RETIRED,
      });
    });
    it("is unverified from another identity", async () => {
      expect(await arrive(hex("f"), linkOff(7))).toEqual({
        kind: "ignored",
        reason: "unverified",
      });
    });
    it("is stale when it names an older ask", async () => {
      expect(await arrive(OWNER, linkOff(6))).toEqual({ kind: "ignored", reason: "stale" });
    });
    it("is ignored with no waiting ask", async () => {
      expect(await arrive(OWNER, linkOff(7), [])).toEqual({
        kind: "ignored",
        reason: "no-waiting-ask",
      });
    });
  });
});

describe("answers: delivering what is owed", () => {
  it("delivery: only connections proven to be the identity get the answer", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    const logs: string[] = [];
    const result = await deliverOwed(
      w.ports([
        { conn: w.toJoiner.conn, identity: id },
        { conn: w.toOther.conn, identity: id },
      ]),
      {
        identity: id,
        owed: () => answersOwed([album({ answers: { [id]: "accepted" } })], id),
        log: (event) => logs.push(event),
      },
    );
    expect(result).toEqual({ sent: 1, retry: false });
    await waitFor(() => w.joiner.events.some((e) => e.type === "answer"), "the answer");
    const got = w.joiner.events.filter((e) => e.type === "answer");
    expect(got.map((e) => e.type === "answer" && e.value)).toEqual([
      { code: CODE, answer: "accepted", shareKey: SHARE },
    ]);
    expect(w.other.events.some((e) => e.type === "answer")).toBe(false);
    expect(logs).toEqual(["answer.sent", "answer.unverified"]);
  });

  it("delivery: a code already sent on a connection is not sent again", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    const options = {
      identity: id,
      owed: () => answersOwed([album({ answers: { [id]: "declined" } })], id),
      log: noLog,
    };
    const ports = w.ports([{ conn: w.toJoiner.conn, identity: id }]);
    expect((await deliverOwed(ports, options)).sent).toBe(1);
    expect((await deliverOwed(ports, options)).sent).toBe(0);
    expect(w.sent.get(w.toJoiner.conn)).toEqual(new Set([`${CODE}:declined:`]));
  });

  it("delivery: an accept is sent after a decline for the same code on one connection", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    let answers: Record<string, "accepted" | "declined"> = { [id]: "declined" };
    const options = {
      identity: id,
      owed: () => answersOwed([album({ answers })], id),
      log: noLog,
    };
    const ports = w.ports([{ conn: w.toJoiner.conn, identity: id }]);
    expect((await deliverOwed(ports, options)).sent).toBe(1);
    answers = { [id]: "accepted" };
    expect((await deliverOwed(ports, options)).sent).toBe(1);
  });

  it("delivery: an accept taken back and given again is sent again on one connection", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    let answers: Record<string, "accepted" | "declined"> = { [id]: "accepted" };
    const options = {
      identity: id,
      owed: () => answersOwed([album({ answers })], id),
      log: noLog,
    };
    const ports = w.ports([{ conn: w.toJoiner.conn, identity: id }]);
    expect((await deliverOwed(ports, options)).sent).toBe(1);
    answers = {};
    answers = { [id]: "accepted" };
    expect((await deliverOwed(ports, options)).sent).toBe(0);
    forgetSent(w.sent.get(w.toJoiner.conn)!, [CODE]);
    expect((await deliverOwed(ports, options)).sent).toBe(1);
  });

  it("owed: a decline carries the time of the ask it answered", () => {
    const id = hex("b");
    const owed = answersOwed(
      [album({ answers: { [id]: "declined" }, declinedAsks: { [id]: 7 } })],
      id,
    );
    expect(owed.map((m) => (m.answer === "declined" ? m.askedAt : "n/a"))).toEqual([7]);
    expect(answersOwed([album({ answers: { [id]: "declined" } })], id)[0]).not.toHaveProperty(
      "askedAt",
    );
  });

  it("delivery: a refused send is retried", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    let refuse = true;
    const base = w.ports([{ conn: w.toJoiner.conn, identity: id }]);
    const ports = {
      ...base,
      sendAnswer: (conn: number, m: Answer) => {
        if (!refuse) return base.sendAnswer(conn, m);
        refuse = false;
        return false;
      },
    };
    const options = {
      identity: id,
      owed: () => answersOwed([album({ answers: { [id]: "declined" } })], id),
      log: noLog,
    };
    expect(await deliverOwed(ports, options)).toEqual({ sent: 0, retry: true });
    expect(w.sent.get(w.toJoiner.conn)!.has(CODE)).toBe(false);
    expect(await deliverOwed(ports, options)).toEqual({ sent: 1, retry: false });
  });

  it("delivery: an answer taken back during the proof is not sent", async () => {
    const w = await adminAndJoiners();
    const id = w.joiner.identity.key;
    let answers: OwingAlbum["answers"] = { [id]: "accepted" };
    const base = w.ports([{ conn: w.toJoiner.conn, identity: id }]);
    let proving!: () => void;
    const started = new Promise<void>((resolve) => (proving = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sends: Answer[] = [];
    const pending = deliverOwed(
      {
        ...base,
        provenIdentity: async (conn) => {
          proving();
          await gate;
          return base.provenIdentity(conn);
        },
        sendAnswer: (conn: number, m: Answer) => (sends.push(m), base.sendAnswer(conn, m)),
      },
      { identity: id, owed: () => answersOwed([album({ answers })], id), log: noLog },
    );
    await started;
    answers = undefined;
    release();
    expect(await pending).toEqual({ sent: 0, retry: false });
    expect(sends).toEqual([]);
  });

  it("delivery: nothing owed reads no connections", async () => {
    let read = 0;
    const result = await deliverOwed(
      {
        connections: () => (read++, []),
        provenIdentity: async () => undefined,
        sendAnswer: () => true,
      },
      { identity: hex("b"), owed: () => [], log: noLog },
    );
    expect(result).toEqual({ sent: 0, retry: false });
    expect(read).toBe(0);
  });
});

describe("answers: an answer arriving", () => {
  type Ask = { code: string; owner: string; status: string; askedAt: number };
  const OWNER = hex("a");
  const asks =
    (...list: Ask[]) =>
    () =>
      list;
  const proven = (identity: string | undefined) => ({ provenIdentity: async () => identity });
  const waiting: Ask = { code: CODE, owner: OWNER, status: "waiting", askedAt: 2 };
  const accepted = { code: CODE, answer: "accepted", shareKey: SHARE };

  it("arriving answer: a refused connection is ignored before parsing", async () => {
    let proofs = 0;
    const result = await arrivingAnswer(
      { provenIdentity: async () => (proofs++, OWNER) },
      { conn: 1, value: accepted, refused: true, asks: asks(waiting) },
    );
    expect(result).toEqual({ kind: "ignored", reason: "version" });
    expect(proofs).toBe(0);
  });

  it("arriving answer: an accepted answer hands on movedFrom", async () => {
    const movedFrom = [hex("d")];
    const result = await arrivingAnswer(proven(OWNER), {
      conn: 1,
      value: { ...accepted, movedFrom },
      refused: false,
      asks: asks(waiting),
    });
    expect(result).toEqual({ kind: "accepted", code: CODE, shareKey: SHARE, movedFrom });
  });

  it("arriving answer: malformed, unknown code, or a settled ask is ignored", async () => {
    const arrive = (value: unknown, list: Ask[]) =>
      arrivingAnswer(proven(OWNER), { conn: 1, value, refused: false, asks: asks(...list) });
    expect(await arrive({ code: "nope", answer: "accepted" }, [waiting])).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(await arrive({ code: hex("1"), answer: "declined" }, [waiting])).toEqual({
      kind: "ignored",
      reason: "no-waiting-ask",
    });
    expect(await arrive(accepted, [{ ...waiting, status: "declined" }])).toEqual({
      kind: "ignored",
      reason: "no-waiting-ask",
    });
  });

  it("arriving answer: only the ask's owner, proven, settles it", async () => {
    const arrive = (who: string | undefined) =>
      arrivingAnswer(proven(who), {
        conn: 1,
        value: accepted,
        refused: false,
        asks: asks(waiting),
      });
    expect(await arrive(hex("f"))).toEqual({ kind: "ignored", reason: "unverified" });
    expect(await arrive(undefined)).toEqual({ kind: "ignored", reason: "unverified" });
    expect(await arrive(OWNER)).toEqual({
      kind: "accepted",
      code: CODE,
      shareKey: SHARE,
      movedFrom: [],
    });
  });

  it("arriving answer: a decline for an older ask is stale", async () => {
    const arrive = (askedAt: number | undefined) =>
      arrivingAnswer(proven(OWNER), {
        conn: 1,
        value: { code: CODE, answer: "declined", ...(askedAt === undefined ? {} : { askedAt }) },
        refused: false,
        asks: asks(waiting),
      });
    expect(await arrive(1)).toEqual({ kind: "ignored", reason: "stale" });
    expect(await arrive(2)).toEqual({ kind: "declined", code: CODE });
    expect(await arrive(undefined)).toEqual({ kind: "declined", code: CODE });
  });

  it("arriving answer: an ask settled during the proof is left alone", async () => {
    const ask = { ...waiting };
    const result = await arrivingAnswer(
      {
        provenIdentity: async () => {
          ask.status = "declined";
          return OWNER;
        },
      },
      { conn: 1, value: accepted, refused: false, asks: asks(ask) },
    );
    expect(result).toEqual({ kind: "ignored", reason: "settled" });
  });

  it("arriving answer: accept carries the album key, decline carries none", async () => {
    const [admin, joiner] = await phones(["admin", "joiner"]);
    await meet(admin, joiner);
    const toJoiner = connTo(admin, joiner);
    const toAdmin = connTo(joiner, admin);
    const id = joiner.identity.key;
    for (const answer of ["accepted", "declined"] as const) {
      const before = joiner.events.filter((e) => e.type === "answer").length;
      await deliverOwed(
        {
          connections: () => [{ conn: toJoiner.conn, identity: id, sent: new Set() }],
          provenIdentity: async () => id,
          sendAnswer: admin.network.sendAnswer.bind(admin.network),
        },
        {
          identity: id,
          owed: () => answersOwed([album({ answers: { [id]: answer } })], id),
          log: noLog,
        },
      );
      await waitFor(
        () => joiner.events.filter((e) => e.type === "answer").length > before,
        "the answer",
      );
      const event = joiner.events.filter((e) => e.type === "answer").at(-1);
      if (event?.type !== "answer") throw new Error("no answer event");
      const result = await arrivingAnswer(proven(admin.identity.key), {
        conn: toAdmin.conn,
        value: event.value,
        refused: false,
        asks: asks({ code: CODE, owner: admin.identity.key, status: "waiting", askedAt: 1 }),
      });
      expect(result).toEqual(
        answer === "accepted"
          ? { kind: "accepted", code: CODE, shareKey: SHARE, movedFrom: [] }
          : { kind: "declined", code: CODE },
      );
    }
  });
});

describe("answers: asks outside the link times", () => {
  const b = hex("b");
  const links = [{ from: 1_000_000, to: 2_000_000 }];
  const withLinks = (extra: Partial<OwingAlbum> = {}) =>
    album({ invite: { code: CODE, links }, answers: undefined, ...extra });
  const ask = (requestedAt: number) => [{ code: CODE, requestedAt }];

  it("a late ask on the current code gets a linkOff with its askedAt", () => {
    expect(answersOwed([withLinks()], b, ask(9_000_000))).toEqual([
      { code: CODE, answer: "linkOff", askedAt: 9_000_000, why: "expired" },
    ]);
  });

  it("an on-time ask, an invited friend and an album with no links get nothing", () => {
    expect(answersOwed([withLinks()], b, ask(1_500_000))).toEqual([]);
    expect(answersOwed([withLinks({ invited: [b] })], b, ask(9_000_000))).toEqual([]);
    expect(answersOwed([album({ answers: undefined })], b, ask(9_000_000))).toEqual([]);
  });

  it("a late ask already accepted gets only the accept", () => {
    expect(answersOwed([withLinks({ answers: { [b]: "accepted" } })], b, ask(9_000_000))).toEqual([
      { code: CODE, answer: "accepted", shareKey: SHARE },
    ]);
  });
});

describe("answers: a deleted album", () => {
  it("a code of a deleted album gets a linkOff with the ask's time", () => {
    expect(
      deletedAlbumAnswers(new Set([CODE]), [
        { code: CODE, requestedAt: 5 },
        { code: RETIRED, requestedAt: 6 },
      ]),
    ).toEqual([{ code: CODE, answer: "linkOff", askedAt: 5, why: "albumDeleted" }]);
  });

  it("no deleted codes, nothing owed", () => {
    expect(deletedAlbumAnswers(new Set(), [{ code: CODE, requestedAt: 5 }])).toEqual([]);
  });
});
