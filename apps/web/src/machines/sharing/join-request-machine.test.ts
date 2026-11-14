import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { recordRuns } from "@mantaq/inspect/record";
import type { VizRun } from "@mantaq/viz";
import { describe, expect, test } from "vite-plus/test";
import { buildInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";
import {
  EXPIRED_LINK,
  GARBLED_LINK,
  NOTHING_COPIED,
  SEND_FAILED,
  createJoinRequestActor,
  oldLinkMessage,
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

function setup(
  options: {
    port?: JoinPort;
    known?: Known | ((invite: JoinInvite) => Known);
    asked?: (code: string) => AskSummary | undefined;
  } = {},
) {
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

  test.each(["noInviteOpen", "decidingToAsk", "waitingForAdminToAccept"] as const)(
    "a garbled link in %s stays put with an error",
    async (name) => {
      const s = setup();
      if (name !== "noInviteOpen") await s.send("openLink", { text: LINK });
      if (name === "waitingForAdminToAccept") await s.send("askToJoin");
      await s.send("openLink", { text: "justus://join/not-a-link" });
      expect(s.actor.state.name).toBe(name === "noInviteOpen" ? "showingLinkProblem" : name);
      expect(error(s)).toBe(GARBLED_LINK);
    },
  );

  test("a garbled link in declined stays declined", async () => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask("declined") });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("declinedByAdmin");
    expect(error(s)).toBe(GARBLED_LINK);
  });

  test.each([
    "noInviteOpen",
    "decidingToAsk",
    "waitingForAdminToAccept",
    "declinedByAdmin",
  ] as const)("an old link in %s stays put with its own message", async (name) => {
    const s = setup();
    if (name === "declinedByAdmin") await s.send("reopenRequest", { ask: ask("declined") });
    else if (name !== "noInviteOpen") await s.send("openLink", { text: LINK });
    if (name === "waitingForAdminToAccept") await s.send("askToJoin");
    await s.send("openLink", { text: `justus://join/${"a".repeat(64)}?n=Lisbon&a=Nils` });
    expect(s.actor.state.name).toBe(name === "noInviteOpen" ? "showingLinkProblem" : name);
    expect(error(s)).toBe("This link no longer works. Ask Nils for a new invite link.");
  });

  test("an old link without a hint is told to ask the person who invited you", async () => {
    const s = setup();
    await s.send("openLink", { text: `justus://join/${"a".repeat(64)}` });
    expect(error(s)).toBe(
      "This link no longer works. Ask the person who invited you for a new invite link.",
    );
  });

  test.each([["own"], ["member"]] as const)(
    "a link to an album that is %s opens the album",
    async (kind) => {
      const s = setup({ known: { kind, folderId: "f1" } });
      await s.send("openLink", { text: LINK });
      expect(s.actor.state.name).toBe("joinedAlbum");
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
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(calls).toBe(0);
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

describe("checkingLink", () => {
  const portWith = (checkLink: JoinPort["checkLink"]) => {
    const asks: JoinInvite[] = [];
    const port: JoinPort = {
      ask: async (invite) => {
        asks.push(invite);
        return [undefined, {}];
      },
      checkLink,
    };
    return { port, asks };
  };

  test("a link its owner turned off is refused at Continue, and nothing is sent", async () => {
    const { port, asks } = portWith(async () => [undefined, { turnedOff: true }]);
    const s = setup({ port });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("linkTurnedOffByAdmin");
    expect(payload(s)).toEqual(INVITE);
    expect(asks).toEqual([]);
    expect(s.outputs).toEqual([]);
  });

  test("a link that is not off asks the question", async () => {
    const s = setup({ port: portWith(async () => [undefined, { turnedOff: false }]).port });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("decidingToAsk");
  });

  test.each([
    ["rejects", async () => Promise.reject(new Error("down"))],
    ["returns an error", async () => [{ code: "X" }, null] as [unknown, unknown]],
    [
      "returns a garbled result",
      async () => [undefined, { turnedOff: "yes" }] as [unknown, unknown],
    ],
  ])("a check that %s asks the question", async (_name, checkLink) => {
    const s = setup({ port: portWith(checkLink).port });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("decidingToAsk");
  });

  test("a port with no check asks the question", async () => {
    const s = setup({ port: { ask: async () => [undefined, {}] } });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("decidingToAsk");
  });
});

describe("reopenRequest", () => {
  test.each([
    ["waiting", "waitingForAdminToAccept"],
    ["declined", "declinedByAdmin"],
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
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(calls).toBe(0);
  });

  test("ask sends the invite and waits", async () => {
    const seen: JoinInvite[] = [];
    const s = await waitingSetup({ port: { ask: async (i) => (seen.push(i), [undefined, {}]) } });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
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
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
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
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(error(s)).toBe("");
  });
});

describe("waitingForAdminToAccept", () => {
  test("closeWaiting goes to noInvite and sends nothing", async () => {
    const s = await waitingSetup();
    await s.send("closeWaiting");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([]);
  });

  test("accepted opens the album", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
  });

  test("declined shows declined", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    expect(s.actor.state.name).toBe("declinedByAdmin");
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(["accepted", "declined"] as const)(
    "an answer for another code (%s) changes nothing",
    async (answer) => {
      const s = await waitingSetup();
      await s.send("requestAnswered", { code: "c".repeat(64), answer, folderId: "f9" });
      expect(s.actor.state.name).toBe("waitingForAdminToAccept");
      expect(s.outputs).toEqual([]);
    },
  );

  test("an accepted answer with no folder keeps waiting", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted" });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });

  test("an answer for another code is ignored while waiting", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: "c".repeat(64), answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(s.outputs).toEqual([]);
  });
});

describe("cancelRequest", () => {
  test("Cancel request takes the request back", async () => {
    const s = await waitingSetup();
    await s.send("cancelRequest");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs.at(-1)).toEqual({ type: "cancelAsk", payload: { code: INVITE.code } });
  });

  test("after Cancel request, a decline for that code stays quiet", async () => {
    const s = await waitingSetup();
    await s.send("cancelRequest");
    await s.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    expect(s.actor.state.name).toBe("noInviteOpen");
  });

  test("Cancel request does nothing outside the waiting screen", async () => {
    const deciding = setup();
    await deciding.send("openLink", { text: LINK });
    const declined = await waitingSetup();
    await declined.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    const expired = setup();
    expired.clock.advance(600_000);
    await expired.send("openLink", {
      text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }),
    });
    for (const [s, name] of [
      [deciding, "decidingToAsk"],
      [declined, "declinedByAdmin"],
      [expired, "linkExpired"],
    ] as const) {
      const before = s.outputs.length;
      await s.send("cancelRequest");
      expect(s.actor.state.name).toBe(name);
      expect(s.outputs.length).toBe(before);
    }
  });
});

describe("askToJoin at the end", () => {
  const END = 600_000;
  const timed = buildInviteLink({ ...INVITE, expiresAt: END });

  test("Ask at the end shows the expired screen and sends nothing", async () => {
    let asked = 0;
    const s = setup({ port: { ask: async () => (asked++, [undefined, {}]) } });
    await s.send("openLink", { text: timed });
    s.clock.advance(END);
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("linkExpired");
    expect(asked).toBe(0);
  });

  test("Ask before the end still sends", async () => {
    const s = setup();
    await s.send("openLink", { text: timed });
    s.clock.advance(END - 1);
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });

  test("a failed send, retried after the end, shows expired and clears the error", async () => {
    const s = setup({ port: { ask: async () => [new Error("x"), undefined] } });
    await s.send("openLink", { text: timed });
    await s.send("askToJoin");
    expect(error(s)).toBe(SEND_FAILED);
    s.clock.advance(END);
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("linkExpired");
    expect(error(s)).toBe("");
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
    [{ kind: "own", folderId: "f1" }, "joinedAlbum"],
    [{ kind: "member", folderId: "f1" }, "joinedAlbum"],
    [{ kind: "waiting" }, "waitingForAdminToAccept"],
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
    expect(s.actor.state.name).toBe("joinedAlbum");
  });

  test("OK goes to noInvite; a garbled paste keeps the expired screen", async () => {
    const s = setup();
    s.clock.advance(END);
    await s.send("openLink", { text: timed });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("linkExpired");
    await s.send("dismissExpired");
    expect(s.actor.state.name).toBe("noInviteOpen");
  });

  test("a request row opens from the expired screen", async () => {
    const s = setup();
    s.clock.advance(END);
    await s.send("openLink", { text: timed });
    await s.send("reopenRequest", { ask: ask("waiting") });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });
});

describe("declined", () => {
  test("OK on a decline asks the app to take the request off this phone", async () => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask("declined") });
    await s.send("dismissDecline");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([{ type: "dismissDeclinedAsk", payload: { code: INVITE.code } }]);
  });

  test("OK on a decline that just arrived does the same", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    s.outputs.length = 0;
    await s.send("dismissDecline");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([{ type: "dismissDeclinedAsk", payload: { code: INVITE.code } }]);
  });

  test("the decline is final: a later answer does not change it", async () => {
    const s = setup();
    await s.send("reopenRequest", { ask: ask("declined") });
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("declinedByAdmin");
  });
});

describe("ask again", () => {
  const declined = async (options: Parameters<typeof setup>[0] = {}) => {
    const s = await waitingSetup(options);
    await s.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    s.outputs.length = 0;
    return s;
  };

  test("sends the same request again and waits, without removing the ask", async () => {
    const sent: JoinInvite[] = [];
    const s = await declined({
      port: { ask: async (invite) => (sent.push(invite), [undefined, {}]) },
    });
    sent.length = 0;
    await s.send("askAgain");
    expect(sent).toEqual([INVITE]);
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(s.outputs).toEqual([]);
  });

  test("waits for an update when the phones differ", async () => {
    const s = await declined({
      asked: () => ({ ...ask("waiting"), whoMustUpdate: "you" }),
    });
    await s.send("askAgain");
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("a failed send returns to the declined screen with the error, and Ask again retries", async () => {
    let fail = false;
    const s = await declined({
      port: { ask: async () => (fail ? [new Error("down"), null] : [undefined, {}]) },
    });
    fail = true;
    await s.send("askAgain");
    expect(s.actor.state.name).toBe("declinedByAdmin");
    expect(error(s)).toBe(SEND_FAILED);
    fail = false;
    await s.send("askAgain");
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(error(s)).toBe("");
  });

  test("Not now after a failed send removes the ask and clears the error", async () => {
    let fail = false;
    const s = await declined({
      port: { ask: async () => (fail ? [new Error("down"), null] : [undefined, {}]) },
    });
    fail = true;
    await s.send("askAgain");
    await s.send("dismissDecline");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(error(s)).toBe("");
    expect(s.outputs).toEqual([{ type: "dismissDeclinedAsk", payload: { code: INVITE.code } }]);
  });

  test("an accept while sending again opens the album", async () => {
    let hold: Promise<void> | undefined;
    const s = await declined({
      port: {
        ask: async () => {
          await hold;
          return [undefined, {}];
        },
      },
    });
    let release = () => {};
    hold = new Promise<void>((r) => (release = r));
    s.actor.send({ type: "askAgain" } as never);
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
    release();
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f1" } }]);
  });
});

describe("link states", () => {
  test("a link after an unusable link opens its screen", async () => {
    const s = setup();
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("showingLinkProblem");
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(error(s)).toBe("");
  });

  test("a link to an own album after joined opens the album again", async () => {
    const s = setup({ known: { kind: "own", folderId: "f1" } });
    await s.send("openLink", { text: LINK });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toHaveLength(2);
  });

  test("a garbled link after joined is unusable", async () => {
    const s = setup({ known: { kind: "own", folderId: "f1" } });
    await s.send("openLink", { text: LINK });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("showingLinkProblem");
  });

  test("a request row opens from joined and from unusableLink", async () => {
    const s = setup({ known: { kind: "own", folderId: "f1" } });
    await s.send("openLink", { text: LINK });
    await s.send("reopenRequest", { ask: ask("waiting") });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    const t = setup();
    await t.send("openLink", { text: "nope" });
    await t.send("reopenRequest", { ask: ask("declined") });
    expect(t.actor.state.name).toBe("declinedByAdmin");
  });
});

describe("answers with no sheet open", () => {
  const found = (code: string) => (code === INVITE.code ? ask("waiting") : undefined);
  const accepted = { code: INVITE.code, answer: "accepted", folderId: "f9" };
  const declinedAnswer = { code: INVITE.code, answer: "declined" };

  async function closed(options: Parameters<typeof setup>[0] = {}) {
    const s = await waitingSetup(options);
    await s.send("closeWaiting");
    return s;
  }

  test("accepted after closeWaiting opens the album", async () => {
    const s = await closed();
    await s.send("requestAnswered", accepted);
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
  });

  test("declined after closeWaiting shows the decline with the stored ask", async () => {
    const s = await closed({ asked: found });
    await s.send("requestAnswered", declinedAnswer);
    expect(s.actor.state.name).toBe("declinedByAdmin");
    expect(payload(s)).toEqual(INVITE);
  });

  test("declined with no stored ask stays quiet", async () => {
    const s = await closed({ asked: () => undefined });
    await s.send("requestAnswered", declinedAnswer);
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([]);
  });

  test("accepted with no folderId stays", async () => {
    const s = await closed();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted" });
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([]);
  });

  test("accepted from showingLinkProblem opens the album and keeps the error until the next link", async () => {
    const s = setup();
    await s.send("openLink", { text: "justus://join/not-a-link" });
    await s.send("requestAnswered", accepted);
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(error(s)).toBe(GARBLED_LINK);
    await s.send("openLink", { text: LINK });
    expect(error(s)).toBe("");
  });

  test("a second accept from joinedAlbum opens a second album", async () => {
    const s = await closed();
    await s.send("requestAnswered", accepted);
    await s.send("requestAnswered", { ...accepted, folderId: "f10" });
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs.map((o) => o.payload)).toEqual([{ folderId: "f9" }, { folderId: "f10" }]);
  });

  test("a decline in decidingToAsk leaves the sheet alone", async () => {
    const s = setup({ asked: found });
    await s.send("openLink", { text: LINK });
    await s.send("requestAnswered", declinedAnswer);
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(payload(s)).toEqual(INVITE);
    expect(s.outputs).toEqual([]);
  });

  test("an accept in decidingToAsk opens the album", async () => {
    const s = setup();
    await s.send("openLink", { text: LINK });
    await s.send("requestAnswered", accepted);
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
  });

  test("an accept in linkExpired opens the album", async () => {
    const s = setup();
    s.clock.advance(600_000);
    await s.send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
    expect(s.actor.state.name).toBe("linkExpired");
    await s.send("requestAnswered", accepted);
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
  });
});

describe("the welcome", () => {
  const known = (kind: Known["kind"]): Known =>
    kind === "member" ? { kind, folderId: "f1" } : ({ kind } as Known);

  test("a link opened during the welcome asks once the name is saved", async () => {
    const s = setup();
    await s.send("welcomeStarted");
    expect(s.actor.state.name).toBe("showingWelcome");
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("holdingInviteUntilWelcomeEnds");
    expect(payload(s)).toEqual(INVITE);
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(payload(s)).toEqual(INVITE);
  });

  test("a second link replaces the held one", async () => {
    const s = setup();
    const other = { ...INVITE, album: "Garden", ownerName: "Tom" };
    await s.send("welcomeStarted");
    await s.send("openLink", { text: LINK });
    await s.send("openLink", { text: buildInviteLink(other) });
    expect(payload(s)).toEqual(other);
  });

  test("a garbled link keeps the held one and shows no error", async () => {
    const s = setup();
    await s.send("welcomeStarted");
    await s.send("openLink", { text: LINK });
    await s.send("openLink", { text: "hello" });
    expect(s.actor.state.name).toBe("holdingInviteUntilWelcomeEnds");
    expect(payload(s)).toEqual(INVITE);
    expect(error(s)).toBe("");
  });

  test("an unusable link during the welcome is dropped", async () => {
    const s = setup();
    await s.send("welcomeStarted");
    await s.send("openLink", { text: "hello" });
    expect(s.actor.state.name).toBe("showingWelcome");
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(error(s)).toBe("");
  });

  test("a link that ended during the welcome shows as ended", async () => {
    const s = setup();
    await s.send("welcomeStarted");
    await s.send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
    s.clock.advance(600_000);
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("linkExpired");
    expect(s.outputs).toEqual([]);
  });

  test("a link to an album already joined opens the album", async () => {
    const s = setup({ known: known("member") });
    await s.send("welcomeStarted");
    await s.send("openLink", { text: LINK });
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f1" } }]);
  });

  test("a link already asked through shows the waiting screen", async () => {
    const s = setup({ known: known("waiting") });
    await s.send("welcomeStarted");
    await s.send("openLink", { text: LINK });
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });

  test("answers while holding change nothing", async () => {
    const s = setup();
    await s.send("welcomeStarted");
    await s.send("openLink", { text: LINK });
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
    await s.send("reopenRequest", { ask: ask("waiting") });
    expect(s.actor.state.name).toBe("holdingInviteUntilWelcomeEnds");
    expect(payload(s)).toEqual(INVITE);
  });

  test("welcomeStarted and welcomeEnded outside the welcome are dropped", async () => {
    const s = setup();
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("noInviteOpen");
    await s.send("openLink", { text: LINK });
    await s.send("welcomeStarted");
    await s.send("welcomeEnded");
    expect(s.actor.state.name).toBe("decidingToAsk");
  });
});

describe("pasteFoundNothing", () => {
  test("says nothing is copied", async () => {
    const s = setup();
    await s.send("pasteFoundNothing");
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe("Nothing copied yet. Copy the link from your chat, then tap Paste.");
    expect(NOTHING_COPIED).toBe(error(s));
  });

  test("is dropped while a question is open", async () => {
    const s = setup();
    await s.send("openLink", { text: LINK });
    await s.send("pasteFoundNothing");
    expect(s.actor.state.name).toBe("decidingToAsk");
  });
});

describe("askWithPastedLink", () => {
  const OFF = "Nils turned off this link. Ask Nils for a new link if you still want to join.";
  const EXPIRED = "This invite link has expired. Ask Nils for a new one.";
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** A port whose check and send wait until the test lets them go. */
  function heldPort(turnedOff = false) {
    const asks: JoinInvite[] = [];
    const release: { check: () => void; send: (result?: [unknown, unknown]) => void } = {
      check: () => {},
      send: () => {},
    };
    const port: JoinPort = {
      checkLink: () =>
        new Promise((resolve) => {
          release.check = () => resolve([undefined, { turnedOff }]);
        }),
      ask: (invite) =>
        new Promise((resolve) => {
          asks.push(invite);
          release.send = (result = [undefined, {}]) => resolve(result);
        }),
    };
    return { port, asks, release };
  }
  const paste = (s: Setup, text = LINK) =>
    s.actor.send({ type: "askWithPastedLink", payload: { text } } as never);

  test("a new link is checked, sent and waited on with no question between", async () => {
    const { port, asks, release } = heldPort();
    const s = setup({ port });
    const seen: string[] = [];
    s.actor.on("change", { fn: (snap) => seen.push(snap.path[0] as string) });
    paste(s);
    await tick();
    expect(s.actor.state.name).toBe("checkingPastedLink");
    release.check();
    await tick();
    expect(s.actor.state.name).toBe("sendingPastedRequest");
    release.send();
    await tick();
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(seen).not.toContain("decidingToAsk");
    expect(seen).not.toContain("checkingLink");
    expect(asks).toEqual([INVITE]);
    expect(error(s)).toBe("");
  });

  test.each(["checkingPastedLink", "sendingPastedRequest"])(
    "a second tap during %s sends nothing more",
    async (during) => {
      const { port, asks, release } = heldPort();
      const s = setup({ port });
      paste(s);
      await tick();
      if (during === "sendingPastedRequest") {
        release.check();
        await tick();
      }
      expect(s.actor.state.name).toBe(during);
      paste(s);
      await tick();
      expect(s.actor.state.name).toBe(during);
      release.check();
      await tick();
      release.send();
      await tick();
      expect(asks).toHaveLength(1);
      expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    },
  );

  test("empty text says nothing was copied", async () => {
    const s = setup();
    await s.send("askWithPastedLink", { text: "  " });
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(NOTHING_COPIED);
  });

  test("text that is not a link says so", async () => {
    const s = setup();
    await s.send("askWithPastedLink", { text: "hello" });
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(GARBLED_LINK);
  });

  test("an old link names its owner", async () => {
    const s = setup();
    await s.send("askWithPastedLink", { text: `justus://join/${INVITE.code}?n=Lisbon&a=Nils` });
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(oldLinkMessage("Nils"));
  });

  test("a link that has ended says so and sends nothing", async () => {
    const asks: JoinInvite[] = [];
    let checks = 0;
    const s = setup({
      port: {
        ask: async (i) => (asks.push(i), [undefined, {}]),
        checkLink: async () => (checks++, [undefined, { turnedOff: false }]),
      },
    });
    s.clock.advance(600_000);
    await s.send("askWithPastedLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
    expect(checks).toBe(0);
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(EXPIRED);
    expect(asks).toEqual([]);
  });

  test("a link that ends during the check says so and sends nothing", async () => {
    const { port, asks, release } = heldPort();
    const s = setup({ port });
    paste(s, buildInviteLink({ ...INVITE, expiresAt: 600_000 }));
    await tick();
    expect(s.actor.state.name).toBe("checkingPastedLink");
    s.clock.advance(600_000);
    release.check();
    await tick();
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(EXPIRED);
    expect(asks).toEqual([]);
  });

  test("a link its owner turned off is refused under the box and sends nothing", async () => {
    const { port, asks, release } = heldPort(true);
    const s = setup({ port });
    paste(s);
    await tick();
    release.check();
    await tick();
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(OFF);
    expect(asks).toEqual([]);
  });

  test.each([
    ["turnedOff", "Nils turned off this link. Ask Nils for a new link if you still want to join."],
    ["replaced", "Nils replaced this link. Ask Nils for the new link."],
    ["albumDeleted", "Nils deleted this album. There is nothing to join any more."],
    ["expired", "This invite link has expired. Ask Nils for a new one."],
    [undefined, "This invite link no longer works. Ask Nils for a new one."],
  ] as const)("a link this phone knows stopped (%s) says so under the box", async (why, line) => {
    const asks: JoinInvite[] = [];
    const s = setup({
      known: { kind: "stopped", why },
      port: { ask: async (i) => (asks.push(i), [undefined, {}]) },
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(line);
    expect(asks).toEqual([]);
    expect(s.outputs).toEqual([]);
  });

  test("a failed send says so under the box, and the next tap sends again", async () => {
    let calls = 0;
    const s = setup({
      port: { ask: async () => (++calls === 1 ? [{ code: "X" }, null] : [undefined, {}]) },
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("showingLinkProblem");
    expect(error(s)).toBe(SEND_FAILED);
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(calls).toBe(2);
    expect(error(s)).toBe("");
  });

  test.each(["own", "member"] as const)("a link to an album already %s opens it", async (kind) => {
    const s = setup({ known: { kind, folderId: "f1" } });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f1" } }]);
  });

  test("a link already asked through opens the waiting screen", async () => {
    const s = setup({ known: { kind: "waiting" } });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });

  test("a link tapped during the check wins", async () => {
    const { port, release } = heldPort();
    const s = setup({
      port,
      known: (i) => (i.code === "c".repeat(64) ? { kind: "waiting" } : { kind: "new" }),
    });
    paste(s);
    await tick();
    expect(s.actor.state.name).toBe("checkingPastedLink");
    await s.send("openLink", { text: buildInviteLink({ ...INVITE, code: "c".repeat(64) }) });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    release.check();
    await tick();
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });

  test.each(["checkingPastedLink", "sendingPastedRequest"])(
    "an accept for another request during %s opens that album",
    async (during) => {
      const { port, release } = heldPort();
      const s = setup({ port });
      paste(s);
      await tick();
      if (during === "sendingPastedRequest") {
        release.check();
        await tick();
      }
      expect(s.actor.state.name).toBe(during);
      await s.send("requestAnswered", { code: "d".repeat(64), answer: "accepted", folderId: "f9" });
      expect(s.actor.state.name).toBe("joinedAlbum");
      expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
    },
  );

  test("typing after a problem clears it; elsewhere the edit is dropped", async () => {
    const s = setup();
    await s.send("askWithPastedLink", { text: "hello" });
    await s.send("linkEdited");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(error(s)).toBe("");
    await s.send("linkEdited");
    expect(s.actor.state.name).toBe("noInviteOpen");
    await s.send("openLink", { text: LINK });
    await s.send("linkEdited");
    expect(s.actor.state.name).toBe("decidingToAsk");
  });
});

const make = recordRuns(createJoinRequestActor);
const ROW = (status: AskSummary["status"]) => ask(status);

async function drive(
  steps: (send: Setup["send"]) => Promise<void>,
  options: Parameters<typeof setup>[0] = {},
) {
  const actor = make({ clock: VirtualClock(), ...options });
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  await steps(send);
  return actor;
}

test("Maya asks to join, and Nils accepts her as a Collaborator", async () => {
  const actor = await drive(async (send) => {
    await send("askWithPastedLink", { text: LINK });
    await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
  });
  expect(actor.state.name).toBe("joinedAlbum");
});

test("Joe opens Tom's link during the welcome and asks once his name is saved", async () => {
  const actor = await drive(async (send) => {
    await send("welcomeStarted");
    await send("openLink", { text: LINK });
    await send("welcomeEnded");
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
  });
  expect(actor.state.name).toBe("joinedAlbum");
});

test("Joe taps Paste with nothing copied", async () => {
  const actor = await drive(async (send) => {
    await send("pasteFoundNothing");
  });
  expect(actor.state.name).toBe("showingLinkProblem");
});

test("Maya: asks and is declined", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "declined" });
  });
  expect(actor.state.name).toBe("declinedByAdmin");
});

test("Ana is declined and asks again in one tap", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "declined" });
    await send("askAgain");
    await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
  });
  expect(actor.state.name).toBe("joinedAlbum");
});

test("Maya: reopens her ask while waiting", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("closeWaiting");
    await send("reopenRequest", { ask: ROW("waiting") });
  });
  expect(actor.state.name).toBe("waitingForAdminToAccept");
});

test("Maya: reopens her ask after a decline", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "declined" });
    await send("dismissDecline");
    await send("reopenRequest", { ask: ROW("declined") });
  });
  expect(actor.state.name).toBe("declinedByAdmin");
});

test("Maya: opens a link from before the new key", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: `justus://join/${INVITE.code}?n=Spain 2026&a=Nils` });
  });
  expect(actor.state.name).toBe("showingLinkProblem");
});

test("Maya opens Nils's link after it ended", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  clock.advance(600_000);
  await send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
  expect(actor.state.name).toBe("linkExpired");
});

test("Maya reopens the ended link she already asked through", async () => {
  let asked = false;
  const s = setup({
    port: { ask: async () => ((asked = true), [undefined, {}]) },
    known: () => (asked ? { kind: "waiting" } : { kind: "new" }),
  });
  const timed = buildInviteLink({ ...INVITE, expiresAt: 600_000 });
  await s.send("openLink", { text: timed });
  await s.send("askToJoin");
  await s.send("closeWaiting");
  s.clock.advance(600_000);
  await s.send("openLink", { text: timed });
  expect(s.actor.state.name).toBe("waitingForAdminToAccept");
});

test("Maya cancels her request", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("cancelRequest");
  });
  expect(actor.state.name).toBe("noInviteOpen");
});

test("Maya cancels, then asks again with the same link", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("cancelRequest");
    await send("openLink", { text: LINK });
  });
  expect(actor.state.name).toBe("decidingToAsk");
});

test("Maya leaves the question open past the end, then taps Ask", async () => {
  const clock = VirtualClock();
  const actor = make({ clock });
  const send = async (type: string, payload?: unknown) => {
    actor.send({ type, payload } as never);
    await actor.settled();
  };
  await send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
  clock.advance(600_000);
  await send("askToJoin");
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
  expect(actor.state.name).toBe("joinedAlbum");
});

describe("stopped links", () => {
  const linkOff = { code: INVITE.code, answer: "linkOff" };
  const found = (code: string) => (code === INVITE.code ? ask("waiting") : undefined);
  const SCREENS = [
    ["expired", "linkExpired"],
    ["turnedOff", "linkTurnedOffByAdmin"],
    ["replaced", "linkReplacedByAdmin"],
    ["albumDeleted", "albumDeletedByAdmin"],
    [undefined, "linkStoppedForUnknownReason"],
  ] as const;

  async function screen(why?: string) {
    const s = await waitingSetup();
    await s.send("requestAnswered", { ...linkOff, why });
    return s;
  }

  test.each(SCREENS)("a linkOff answer with why %s while waiting shows %s", async (why, name) => {
    const s = await screen(why);
    expect(s.actor.state.name).toBe(name);
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(SCREENS)(
    "a linkOff answer with why %s and the sheet closed shows %s",
    async (why, name) => {
      const s = await waitingSetup({ asked: found });
      await s.send("closeWaiting");
      await s.send("requestAnswered", { ...linkOff, why });
      expect(s.actor.state.name).toBe(name);
      expect(payload(s)).toEqual(INVITE);
    },
  );

  test.each(SCREENS)("a row with why %s reopens into %s", async (why, name) => {
    const s = setup();
    await s.send("reopenRequest", { ask: { ...ask("linkOff"), why } });
    expect(s.actor.state.name).toBe(name);
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(SCREENS)(
    "a link known to be stopped with why %s opens %s and sends nothing",
    async (why, name) => {
      const s = setup({ known: { kind: "stopped", why } });
      await s.send("openLink", { text: LINK });
      expect(s.actor.state.name).toBe(name);
      expect(payload(s)).toEqual(INVITE);
      expect(s.outputs).toEqual([]);
    },
  );

  test("a link both stopped and past its end time shows the stopped reason, not ended", async () => {
    const s = setup({ known: { kind: "stopped", why: "replaced" } });
    s.clock.advance(600_000);
    await s.send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
    expect(s.actor.state.name).toBe("linkReplacedByAdmin");
  });

  test("a linkOff for another code is ignored while waiting", async () => {
    const s = await waitingSetup();
    await s.send("requestAnswered", { code: "c".repeat(64), answer: "linkOff" });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
  });

  test("linkOff with no stored ask stays quiet", async () => {
    const s = await waitingSetup({ asked: () => undefined });
    await s.send("closeWaiting");
    await s.send("requestAnswered", linkOff);
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([]);
  });

  test("linkOff over Ask to join leaves the sheet alone", async () => {
    const s = setup({ asked: found });
    await s.send("openLink", { text: LINK });
    await s.send("requestAnswered", linkOff);
    expect(s.actor.state.name).toBe("decidingToAsk");
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(SCREENS.map(([why]) => why))(
    "Close with why %s takes the dead request off",
    async (why) => {
      const s = await screen(why);
      if (why === "expired") await s.send("dismissExpired");
      else await s.send("closeStoppedLink");
      expect(s.actor.state.name).toBe("noInviteOpen");
      expect(s.outputs.at(-1)).toEqual({ type: "cancelAsk", payload: { code: INVITE.code } });
    },
  );

  test("Close twice takes the request off once", async () => {
    const s = await screen("turnedOff");
    await s.send("closeStoppedLink");
    await s.send("reopenRequest", { ask: { ...ask("linkOff"), why: "turnedOff" } });
    await s.send("closeStoppedLink");
    expect(s.outputs.filter((o) => o.type === "cancelAsk")).toHaveLength(1);
  });

  test("Close with no stored ask emits nothing", async () => {
    const s = setup({ known: { kind: "stopped", why: "turnedOff" }, asked: () => undefined });
    await s.send("openLink", { text: LINK });
    await s.send("closeStoppedLink");
    expect(s.actor.state.name).toBe("noInviteOpen");
    expect(s.outputs).toEqual([]);
  });

  test("OK on the expired screen emits nothing with no row or a declined row", async () => {
    for (const asked of [() => undefined, () => ask("declined")]) {
      const s = setup({ asked });
      s.clock.advance(600_000);
      await s.send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
      await s.send("dismissExpired");
      expect(s.actor.state.name).toBe("noInviteOpen");
      expect(s.outputs).toEqual([]);
    }
  });

  test("OK on the expired screen takes a dead row off the phone", async () => {
    const s = setup({ asked: () => ask("linkOff") });
    s.clock.advance(600_000);
    await s.send("openLink", { text: buildInviteLink({ ...INVITE, expiresAt: 600_000 }) });
    await s.send("dismissExpired");
    expect(s.outputs).toEqual([{ type: "cancelAsk", payload: { code: INVITE.code } }]);
  });

  test("Cancel request does nothing on a stopped screen", async () => {
    const s = await screen("turnedOff");
    await s.send("cancelRequest");
    expect(s.actor.state.name).toBe("linkTurnedOffByAdmin");
    expect(s.outputs).toEqual([]);
  });

  test.each(SCREENS)("a garbled paste keeps the screen for why %s", async (why, name) => {
    const s = await screen(why);
    await s.send("openLink", { text: "justus://join/not-a-link" });
    expect(s.actor.state.name).toBe(name);
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(SCREENS)("an accept for another request opens the album over %s", async (why) => {
    const s = await screen(why);
    await s.send("requestAnswered", { code: "c".repeat(64), answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("joinedAlbum");
    expect(s.outputs.at(-1)).toEqual({ type: "openAlbum", payload: { folderId: "f9" } });
  });
});

describe("joiner design", () => {
  const answers: Record<string, string>[] = [
    { code: INVITE.code, answer: "accepted", folderId: "f1" },
    { code: INVITE.code, answer: "declined" },
    { code: INVITE.code, answer: "linkOff" },
    { code: INVITE.code, answer: "linkOff", why: "expired" },
    { code: INVITE.code, answer: "linkOff", why: "turnedOff" },
    { code: INVITE.code, answer: "linkOff", why: "replaced" },
    { code: INVITE.code, answer: "linkOff", why: "albumDeleted" },
  ];
  const target = {
    id: "joinRequest",
    create: () => createJoinRequestActor({ clock: VirtualClock() }),
    tests: [
      {
        name: "Maya opens Nils's link and asks",
        steps: [
          { kind: "event" as const, event: "openLink", payload: { text: LINK } },
          { kind: "event" as const, event: "askToJoin", payload: null },
        ],
      },
      {
        name: "Maya pastes Nils's link and asks",
        steps: [{ kind: "event" as const, event: "askWithPastedLink", payload: { text: LINK } }],
      },
      {
        name: "Maya's ask meets a deleted album",
        steps: [
          { kind: "event" as const, event: "openLink", payload: { text: LINK } },
          { kind: "event" as const, event: "askToJoin", payload: null },
          {
            kind: "event" as const,
            event: "requestAnswered",
            payload: { code: INVITE.code, answer: "linkOff", why: "albumDeleted" },
          },
        ],
      },
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
    ] as VizRun[],
    payloads: {
      askWithPastedLink: [
        { text: LINK },
        { text: "nope" },
        { text: "" },
        { text: buildInviteLink({ ...INVITE, expiresAt: 1 }) },
        { text: `  ${LINK}  ` },
      ],
      openLink: [
        { text: LINK },
        { text: "nope" },
        { text: buildInviteLink({ ...INVITE, expiresAt: 1 }) },
      ],
      reopenRequest: [
        { ask: { ...ask("waiting") } },
        { ask: { ...ask("declined") } },
        { ask: { ...ask("linkOff") } },
        { ask: { ...ask("linkOff"), why: "turnedOff" } },
        { ask: { ...ask("waiting"), whoMustUpdate: "you" } },
      ],
      whoMustUpdateChanged: [
        { code: INVITE.code, who: "you" },
        { code: INVITE.code, who: "nobody" },
        { code: "c".repeat(64), who: "you" },
      ],
      requestAnswered: answers,
      linkChecked: [{ turnedOff: false }, { turnedOff: true }],
      requestFailed: [{ message: SEND_FAILED }],
    },
  };
  test("has no design errors", () => {
    expectNoDesignErrors(target);
  });
  test("reaches every state", () => {
    expectAllStatesReached(target);
  });
});

test("Maya: closes the waiting screen and Nils accepts", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("closeWaiting");
    await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
  });
  expect(actor.state.name).toBe("joinedAlbum");
});

test("Maya: closes the waiting screen and Nils declines", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("closeWaiting");
    await send("requestAnswered", { code: INVITE.code, answer: "declined" });
  });
  expect(actor.state.name).toBe("declinedByAdmin");
});

test("Ben opens a link Ada turned off and is told at Continue", async () => {
  const actor = await drive(
    async (send) => {
      await send("openLink", { text: LINK });
    },
    {
      port: {
        ask: async () => [undefined, {}],
        checkLink: async () => [undefined, { turnedOff: true }],
      },
    },
  );
  expect(actor.state.name).toBe("linkTurnedOffByAdmin");
});

test("Ben opens a working link and is asked to join after the check", async () => {
  const actor = await drive(
    async (send) => {
      await send("openLink", { text: LINK });
    },
    {
      port: {
        ask: async () => [undefined, {}],
        checkLink: async () => [undefined, { turnedOff: false }],
      },
    },
  );
  expect(actor.state.name).toBe("decidingToAsk");
});

test("Maya waits, and Nils turns off his links", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff", why: "turnedOff" });
  });
  expect(actor.state.name).toBe("linkTurnedOffByAdmin");
});

test("Maya closes the waiting screen, and Nils turns off his links", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("closeWaiting");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff", why: "turnedOff" });
  });
  expect(actor.state.name).toBe("linkTurnedOffByAdmin");
});

test("Maya waits, and Nils's phone says an older link was replaced", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff", why: "replaced" });
  });
  expect(actor.state.name).toBe("linkReplacedByAdmin");
});

test("Maya waits, and Nils deletes the album", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff", why: "albumDeleted" });
  });
  expect(actor.state.name).toBe("albumDeletedByAdmin");
});

test("Maya waits, and Nils's older Justus gives no reason", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff" });
  });
  expect(actor.state.name).toBe("linkStoppedForUnknownReason");
});

test("Cy asks, Ada turns off the links, and Cy closes the dead request", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff", why: "turnedOff" });
    await send("closeStoppedLink");
  });
  expect(actor.state.name).toBe("noInviteOpen");
});

test("Maya closes a stopped-link screen and taps her row again", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("requestAnswered", { code: INVITE.code, answer: "linkOff", why: "turnedOff" });
    await send("closeStoppedLink");
    await send("reopenRequest", { ask: { ...ROW("linkOff"), why: "turnedOff" } });
  });
  expect(actor.state.name).toBe("linkTurnedOffByAdmin");
});

const OTHER_CODE = "c".repeat(64);

test("Maya asks on an older Justus, and is told to update first", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
  });
  expect(actor.state.name).toBe("waitingForYouToUpdate");
  expect(actor.snapshot().payload).toEqual(INVITE);
});

test("Maya updates and her request goes back to waiting for Nils", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
    await send("whoMustUpdateChanged", { code: INVITE.code, who: "nobody" });
  });
  expect(actor.state.name).toBe("waitingForAdminToAccept");
});

test("Maya, told to update, cancels her request", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
    await send("cancelRequest");
  });
  expect(actor.state.name).toBe("noInviteOpen");
});

test("Nils accepts after both phones match", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
    await send("whoMustUpdateChanged", { code: INVITE.code, who: "nobody" });
    await send("requestAnswered", { code: INVITE.code, answer: "accepted", folderId: "f1" });
  });
  expect(actor.state.name).toBe("joinedAlbum");
});

test("a mark for another request leaves Maya's sheet alone", async () => {
  const actor = await drive(async (send) => {
    await send("openLink", { text: LINK });
    await send("askToJoin");
    await send("whoMustUpdateChanged", { code: OTHER_CODE, who: "you" });
  });
  expect(actor.state.name).toBe("waitingForAdminToAccept");
});

test("reopening a marked row opens the update screen", async () => {
  const actor = await drive(async (send) => {
    await send("reopenRequest", { ask: { ...ROW("waiting"), whoMustUpdate: "you" } });
  });
  expect(actor.state.name).toBe("waitingForYouToUpdate");
});

describe("the mark that lands around the send", () => {
  test("a mark already on the stored ask opens the update screen after sending", async () => {
    const s = setup({
      asked: (code) =>
        code === INVITE.code ? { ...ROW("waiting"), whoMustUpdate: "you" } : undefined,
    });
    await s.send("openLink", { text: LINK });
    await s.send("askToJoin");
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("a known marked request opens the update screen from a link", async () => {
    const s = setup({
      known: { kind: "waiting" },
      asked: () => ({ ...ROW("waiting"), whoMustUpdate: "you" }),
    });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("closing the update screen keeps the request", async () => {
    const s = await waitingSetup();
    await s.send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
    await s.send("closeWaiting");
    expect(s.actor.state.name).toBe("noInviteOpen");
  });

  test("a decline on the update screen is final", async () => {
    const s = await waitingSetup();
    await s.send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
    await s.send("requestAnswered", { code: INVITE.code, answer: "declined" });
    expect(s.actor.state.name).toBe("declinedByAdmin");
  });
});

describe("the update screen stays put", () => {
  const onUpdateScreen = async () => {
    const s = await waitingSetup();
    await s.send("whoMustUpdateChanged", { code: INVITE.code, who: "you" });
    return s;
  };

  test("another request's answer changes nothing", async () => {
    const s = await onUpdateScreen();
    await s.send("requestAnswered", { code: "other", answer: "declined" });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("an accept with no folder changes nothing", async () => {
    const s = await onUpdateScreen();
    await s.send("requestAnswered", { code: INVITE.code, answer: "accepted" });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("another request's mark changes nothing", async () => {
    const s = await onUpdateScreen();
    await s.send("whoMustUpdateChanged", { code: "other", who: "nobody" });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("an unusable link keeps it", async () => {
    const s = await onUpdateScreen();
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });
});

describe("pasted link: branches the review found untested", () => {
  test("a check that fails still sends the pasted request", async () => {
    const asks: JoinInvite[] = [];
    const s = setup({
      port: {
        checkLink: async () => [{ code: "X" }, null],
        ask: async (i) => (asks.push(i), [undefined, {}]),
      },
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(asks).toEqual([INVITE]);
  });

  test("a check answer without turnedOff true still sends", async () => {
    const asks: JoinInvite[] = [];
    const s = setup({
      port: {
        checkLink: async () => [undefined, {}],
        ask: async (i) => (asks.push(i), [undefined, {}]),
      },
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(asks).toHaveLength(1);
  });

  test("a mark on the stored ask opens the update screen after a pasted send", async () => {
    const s = setup({
      asked: (code) =>
        code === INVITE.code ? { ...ask("waiting"), whoMustUpdate: "you" } : undefined,
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("a known marked request opens the update screen from the paste box", async () => {
    const s = setup({
      known: { kind: "waiting" },
      asked: () => ({ ...ask("waiting"), whoMustUpdate: "you" }),
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("waitingForYouToUpdate");
  });

  test("after an album opened, the next pasted link is asked", async () => {
    const asks: JoinInvite[] = [];
    const other = { ...INVITE, code: "e".repeat(64) };
    const s = setup({
      known: (i) => (i.code === INVITE.code ? { kind: "member", folderId: "f1" } : { kind: "new" }),
      port: { ask: async (i) => (asks.push(i), [undefined, {}]) },
    });
    await s.send("askWithPastedLink", { text: LINK });
    expect(s.actor.state.name).toBe("joinedAlbum");
    await s.send("askWithPastedLink", { text: buildInviteLink(other) });
    expect(s.actor.state.name).toBe("waitingForAdminToAccept");
    expect(asks).toEqual([other]);
  });

  test("a garbled tapped link during the pasted check keeps the check", async () => {
    const s = setup({
      port: {
        checkLink: () => new Promise(() => {}),
        ask: async () => [undefined, {}],
      },
    });
    s.actor.send({ type: "askWithPastedLink", payload: { text: LINK } } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.actor.state.name).toBe("checkingPastedLink");
    s.actor.send({ type: "openLink", payload: { text: "nope" } } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.actor.state.name).toBe("checkingPastedLink");
    expect(payload(s)).toEqual(INVITE);
  });
});
