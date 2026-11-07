import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import { describe, expect, test } from "vite-plus/test";
import { buildInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";
import {
  EXPIRED_LINK,
  GARBLED_LINK,
  SEND_FAILED,
  oldLinkMessage,
  createJoinRequestActor,
  type AskSummary,
  type JoinPort,
  type Known,
} from "./join-request-machine";

const INVITE: JoinInvite = {
  code: "a".repeat(64),
  owner: "b".repeat(64),
  album: "Spain 2026",
  ownerName: "Nils",
};
const LINK = buildInviteLink(INVITE);

function setup(options: { port?: JoinPort; known?: Known } = {}) {
  const clock = VirtualClock();
  const actor = createJoinRequestActor({ clock, ...options });
  const outputs: { type: string; payload?: unknown }[] = [];
  onOutput(actor, (e) =>
    outputs.push({ type: e.type, payload: (e as { payload?: unknown }).payload }),
  );
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  return { clock, actor, outputs, send };
}

type Setup = ReturnType<typeof setup>;
const payload = (s: Setup) => s.actor.snapshot().payload;
const error = (s: Setup) => (s.actor.snapshot().context as { error: string }).error;

async function waitingSetup(options: Parameters<typeof setup>[0] = {}) {
  const s = setup(options);
  await s.send("openLink", { text: LINK });
  await s.send("askToJoin");
  return s;
}

describe("openLink", () => {
  test("a new link asks 'Ask to join?'", async () => {
    const s = setup();
    await s.send("openLink", { text: `join us ${LINK} thanks` });
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(["noInvite", "decidingToAsk", "waitingForAnswer"] as const)(
    "a garbled link in %s stays put with an error",
    async (name) => {
      const s = setup();
      if (name !== "noInvite") await s.send("openLink", { text: LINK });
      if (name === "waitingForAnswer") await s.send("askToJoin");
      await s.send("openLink", { text: "justus://join/not-a-link" });
      expect(s.actor.state.name).toBe(name === "noInvite" ? "unusableLink" : name);
      expect(error(s)).toBe(GARBLED_LINK);
    },
  );

  test("a garbled link in declined stays declined", async () => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask("declined") });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("declined");
    expect(error(s)).toBe(GARBLED_LINK);
  });

  test.each(["noInvite", "decidingToAsk", "waitingForAnswer", "declined"] as const)(
    "an old link in %s stays put with its own message",
    async (name) => {
      const s = setup();
      if (name === "declined") await s.send("reopenRequest", { ask: ask("declined") });
      else if (name !== "noInvite") await s.send("openLink", { text: LINK });
      if (name === "waitingForAnswer") await s.send("askToJoin");
      await s.send("openLink", { text: `justus://join/${"a".repeat(64)}?n=Lisbon&a=Nils` });
      expect(s.actor.state.name).toBe(name === "noInvite" ? "unusableLink" : name);
      expect(error(s)).toBe("This link no longer works. Ask Nils for a new invite link.");
    },
  );

  test("an old link without a hint names the Admin", async () => {
    const s = setup();
    await s.send("openLink", { text: `justus://join/${"a".repeat(64)}` });
    expect(error(s)).toBe(oldLinkMessage("the Admin"));
  });

  test.each([["own"], ["member"]] as const)(
    "a link to an album that is %s opens the album",
    async (kind) => {
      const s = setup({ known: { kind, folderId: "f1" } });
      await s.send("openLink", { text: LINK });
      expect(s.actor.state.name).toBe("joined");
      expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f1" } }]);
    },
  );

  test("a link with a waiting ask shows waiting, without sending again", async () => {
    let calls = 0;
    const s = setup({
      known: { kind: "waiting" },
      port: { ask: async () => (calls++, [undefined, {}]) },
    });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForAnswer");
    expect(calls).toBe(0);
  });

  test("a link with a declined ask shows declined, with no way to ask", async () => {
    const s = setup({ known: { kind: "declined" } });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("declined");
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("declined");
  });

  test("a good link clears an earlier error", async () => {
    const s = setup();
    await s.send("openLink", { text: "nope" });
    await s.send("openLink", { text: LINK });
    expect(error(s)).toBe("");
  });

  test("a link opened while waiting switches to what it says", async () => {
    const s = await waitingSetup();
    const other = { ...INVITE, code: "c".repeat(64) };
    await s.send("openLink", { text: buildInviteLink(other) });
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(payload(s)).toEqual(other);
  });
});

function ask(status: AskSummary["status"]): AskSummary {
  return {
    code: INVITE.code,
    owner: INVITE.owner,
    albumName: INVITE.album,
    ownerName: INVITE.ownerName,
    askedAt: 1,
    status,
  };
}

describe("reopenRequest", () => {
  test.each([
    ["waiting", "waitingForAnswer"],
    ["declined", "declined"],
  ] as const)("a %s row opens %s", async (status, expected) => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask(status) });
    expect(s.actor.state.name).toBe(expected);
    expect(payload(s)).toEqual(INVITE);
  });
});

describe("decidingToAsk", () => {
  test("not now sends nothing", async () => {
    let calls = 0;
    const s = setup({ port: { ask: async () => (calls++, [undefined, {}]) } });
    await s.send("openLink", { text: LINK });
    await s.send("notNow");
    expect(s.actor.state.name).toBe("noInvite");
    expect(calls).toBe(0);
  });

  test("ask sends the invite and waits", async () => {
    const seen: JoinInvite[] = [];
    const s = await waitingSetup({ port: { ask: async (i) => (seen.push(i), [undefined, {}]) } });
    expect(s.actor.state.name).toBe("waitingForAnswer");
    expect(seen).toEqual([INVITE]);
    expect(payload(s)).toEqual(INVITE);
  });

  test("ask locks the screen while sending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ port: { ask: async () => (await gate, [undefined, {}]) } });
    await s.send("openLink", { text: LINK });
    s.actor.send({ type: "askToJoin" } as never);
    await Promise.resolve();
    expect(s.actor.state.name).toBe("sendingRequest");
    s.actor.send({ type: "notNow" } as never);
    s.actor.send({ type: "askToJoin" } as never);
    release();
    await s.actor.settled();
    expect(s.actor.state.name).toBe("waitingForAnswer");
  });

  test.each([
    ["rejects", { ask: async () => Promise.reject(new Error("x")) }],
    ["returns an error", { ask: async () => [new Error("x"), undefined] as [unknown, unknown] }],
  ])("a send that %s goes back to decidingToAsk with an error", async (_n, port) => {
    const s = await waitingSetup({ port });
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(error(s)).toBe(SEND_FAILED);
    expect(payload(s)).toEqual(INVITE);
  });

  test("a retry after a failed send works", async () => {
    let fail = true;
    const s = await waitingSetup({
      port: { ask: async () => (fail ? [new Error("x"), undefined] : [undefined, {}]) },
    });
    fail = false;
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("waitingForAnswer");
    expect(error(s)).toBe("");
  });
});

describe("waitingForAnswer", () => {
  test("closeWaiting goes to noInvite and sends nothing", async () => {
    const s = await waitingSetup();
    await s.send("closeWaiting");
    expect(s.actor.state.name).toBe("noInvite");
    expect(s.outputs).toEqual([]);
  });

  test("accepted opens the album", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("joined");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
  });

  test("declined shows declined", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    expect(s.actor.state.name).toBe("declined");
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(["accepted", "declined"] as const)(
    "an answer for another code (%s) changes nothing",
    async (answer) => {
      const s = await waitingSetup();
      await s.send("requestAnswered", { code: "c".repeat(64), answer, folderId: "f9" });
      expect(s.actor.state.name).toBe("waitingForAnswer");
      expect(s.outputs).toEqual([]);
    },
  );

  test("an accepted answer with no folder keeps waiting", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted" });
    expect(s.actor.state.name).toBe("waitingForAnswer");
  });

  test("answers outside waiting are dropped", async () => {
    const s = setup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("noInvite");
    expect(s.outputs).toEqual([]);
  });
});

describe("linkExpired", () => {
  const END = 600_000;
  const timed = buildInviteLink({ ...INVITE, expiresAt: END });

  test("an open before the end asks to join", async () => {
    const s = setup();
    s.clock.advance(END - 1);
    await s.send("openLink", { text: timed });
    expect(s.actor.state.name).toBe("decidingToAsk");
  });

  test("an open at the end shows the expired screen and sends nothing", async () => {
    let asked = 0;
    const s = setup({ port: { ask: async () => (asked++, [undefined, {}]) } });
    s.clock.advance(END);
    await s.send("openLink", { text: timed });
    expect(s.actor.state.name).toBe("linkExpired");
    expect(payload(s)).toEqual({ ...INVITE, expiresAt: END });
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("linkExpired");
    expect(asked).toBe(0);
    expect(EXPIRED_LINK).toBe("This invite link has expired.");
  });

  test.each([
    [{ kind: "own", folderId: "f1" }, "joined"],
    [{ kind: "member", folderId: "f1" }, "joined"],
    [{ kind: "waiting" }, "waitingForAnswer"],
    [{ kind: "declined" }, "declined"],
  ] as const)("a late link for a known %j shows %s", async (known, name) => {
    const s = setup({ known });
    s.clock.advance(END + 1);
    await s.send("openLink", { text: timed });
    expect(s.actor.state.name).toBe(name);
  });

  test("a link without an end opens however late", async () => {
    const s = setup();
    s.clock.advance(10 ** 12);
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("decidingToAsk");
  });

  test("asked in time, the end passing changes nothing, then accepted joins", async () => {
    const s = setup();
    await s.send("openLink", { text: timed });
    await s.send("askToJoin");
    s.clock.advance(END * 2);
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
    expect(s.actor.state.name).toBe("joined");
  });

  test("OK goes to noInvite; a garbled paste keeps the expired screen", async () => {
    const s = setup();
    s.clock.advance(END);
    await s.send("openLink", { text: timed });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("linkExpired");
    await s.send("dismissExpired");
    expect(s.actor.state.name).toBe("noInvite");
  });

  test("a request row opens from the expired screen", async () => {
    const s = setup();
    s.clock.advance(END);
    await s.send("openLink", { text: timed });
    await s.send("reopenRequest", { ask: ask("waiting") });
    expect(s.actor.state.name).toBe("waitingForAnswer");
  });
});

describe("declined", () => {
  test("dismissDecline goes to noInvite", async () => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask("declined") });
    await s.send("dismissDecline");
    expect(s.actor.state.name).toBe("noInvite");
  });

  test("the decline is final: a later answer does not change it", async () => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask("declined") });
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("declined");
  });
});

describe("link states", () => {
  test("a link after an unusable link opens its screen", async () => {
    const s = setup();
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("unusableLink");
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(error(s)).toBe("");
  });

  test("a link to an own album after joined opens the album again", async () => {
    const s = setup({ known: { kind: "own", folderId: "f1" } });
    await s.send("openLink", { text: LINK });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("joined");
    expect(s.outputs).toHaveLength(2);
  });

  test("a garbled link after joined is unusable", async () => {
    const s = setup({ known: { kind: "own", folderId: "f1" } });
    await s.send("openLink", { text: LINK });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("unusableLink");
  });

  test("a request row opens from joined and from unusableLink", async () => {
    const s = setup({ known: { kind: "own", folderId: "f1" } });
    await s.send("openLink", { text: LINK });
    await s.send("reopenRequest", { ask: ask("waiting") });
    expect(s.actor.state.name).toBe("waitingForAnswer");
    const t = setup();
    await t.send("openLink", { text: "nope" });
    await t.send("reopenRequest", { ask: ask("declined") });
    expect(t.actor.state.name).toBe("declined");
  });
});

const make = recordRuns(createJoinRequestActor);
const ROW = (status: AskSummary["status"]) => ask(status);

async function drive(steps: (send: Setup["send"]) => Promise<void>) {
  const actor = make({ clock: VirtualClock() });
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  await steps(send);
  return actor;
}

test("Maya: asks and is accepted", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
  });
  expect(actor.state.name).toBe("joined");
});

test("Maya: asks and is declined", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "declined" });
  });
  expect(actor.state.name).toBe("declined");
});

test("Maya: reopens her ask while waiting", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("closeWaiting");
    await send("reopenRequest", { ask: ROW("waiting") });
  });
  expect(actor.state.name).toBe("waitingForAnswer");
});

test("Maya: reopens her ask after a decline", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "declined" });
    await send("dismissDecline");
    await send("reopenRequest", { ask: ROW("declined") });
  });
  expect(actor.state.name).toBe("declined");
});

test("Maya: opens a link from before the new key", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: `justus://join/${INVITE.code}?n=Spain 2026&a=Nils` });
  });
  expect(actor.state.name).toBe("unusableLink");
});

test("Maya opens Nils's link after it ended", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  const timed = buildInviteLink({ ...INVITE, expiresAt: 600_000 });
  await send("openLink", { text: timed });
  await send("askToJoin");
  await send("closeWaiting");
  clock.advance(600_000);
  await send("openLink", { text: timed });
  expect(actor.state.name).toBe("linkExpired");
});

test("Maya: asks in time, the link ends, Nils accepts", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  await send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
  await send("askToJoin");
  clock.advance(700_000);
  await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
  expect(actor.state.name).toBe("joined");
});

describe("joiner design", () => {
  const target = {
    id: "joinRequest",
    create: () => createJoinRequestActor({ clock: VirtualClock() }),
    tests: [
      {
        name: "Maya opens Nils's link after it ended",
        steps: [
          { kind: "advance" as const, ms: 600_000 },
          {
            kind: "event" as const,
            event: "openLink",
            payload: { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) },
          },
        ],
      },
    ],
    payloads: {
      openLink: [
        { text: LINK },
        { text: "nope" },
        { text: buildInviteLink({ ...INVITE, expiresAt: 1 }) },
      ],
      reopenRequest: [{ ask: { ...ask("waiting") } }, { ask: { ...ask("declined") } }],
      requestAnswered: [
        { code: INVITE.code, answer: "accepted", folderId: "f1" },
        { code: INVITE.code, answer: "declined", folderId: "f1" },
      ],
    },
  };
  test("has no design errors", () => {
    expectNoDesignErrors(target);
  });
  test("reaches every state", () => {
    expectAllStatesReached(target);
  });
});
