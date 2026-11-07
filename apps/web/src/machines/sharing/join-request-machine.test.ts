import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { describe, expect, test } from "vite-plus/test";
import { buildInviteLink } from "../../utils/invite-link";
import type { JoinInvite } from "../../utils/invite-link";
import {
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
  await s.send("ask");
  return s;
}

describe("openLink", () => {
  test("a new link asks 'Ask to join?'", async () => {
    const s = setup();
    await s.send("openLink", { text: `join us ${LINK} thanks` });
    expect(s.actor.state.name).toBe("reviewing");
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(["idle", "reviewing", "waiting"] as const)(
    "a garbled link in %s stays put with an error",
    async (name) => {
      const s = setup();
      if (name !== "idle") await s.send("openLink", { text: LINK });
      if (name === "waiting") await s.send("ask");
      await s.send("openLink", { text: "justus://join/not-a-link" });
      expect(s.actor.state.name).toBe(name);
      expect(error(s)).toBe(GARBLED_LINK);
    },
  );

  test("a garbled link in declined stays declined", async () => {
    const s = setup();
    await s.send("openAsk", { ask: ask("declined") });
    await s.send("openLink", { text: "nope" });
    expect(s.actor.state.name).toBe("declined");
    expect(error(s)).toBe(GARBLED_LINK);
  });

  test.each(["idle", "reviewing", "waiting", "declined"] as const)(
    "an old link in %s stays put with its own message",
    async (name) => {
      const s = setup();
      if (name === "declined") await s.send("openAsk", { ask: ask("declined") });
      else if (name !== "idle") await s.send("openLink", { text: LINK });
      if (name === "waiting") await s.send("ask");
      await s.send("openLink", { text: `justus://join/${"a".repeat(64)}?n=Lisbon&a=Nils` });
      expect(s.actor.state.name).toBe(name);
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
      expect(s.actor.state.name).toBe("idle");
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
    expect(s.actor.state.name).toBe("waiting");
    expect(calls).toBe(0);
  });

  test("a link with a declined ask shows declined, with no way to ask", async () => {
    const s = setup({ known: { kind: "declined" } });
    await s.send("openLink", { text: LINK });
    expect(s.actor.state.name).toBe("declined");
    await s.send("ask");
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
    expect(s.actor.state.name).toBe("reviewing");
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

describe("openAsk", () => {
  test.each([
    ["waiting", "waiting"],
    ["declined", "declined"],
  ] as const)("a %s row opens %s", async (status, expected) => {
    const s = setup();
    await s.send("openAsk", { ask: ask(status) });
    expect(s.actor.state.name).toBe(expected);
    expect(payload(s)).toEqual(INVITE);
  });
});

describe("reviewing", () => {
  test("not now sends nothing", async () => {
    let calls = 0;
    const s = setup({ port: { ask: async () => (calls++, [undefined, {}]) } });
    await s.send("openLink", { text: LINK });
    await s.send("notNow");
    expect(s.actor.state.name).toBe("idle");
    expect(calls).toBe(0);
  });

  test("ask sends the invite and waits", async () => {
    const seen: JoinInvite[] = [];
    const s = await waitingSetup({ port: { ask: async (i) => (seen.push(i), [undefined, {}]) } });
    expect(s.actor.state.name).toBe("waiting");
    expect(seen).toEqual([INVITE]);
    expect(payload(s)).toEqual(INVITE);
  });

  test("ask locks the screen while sending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ port: { ask: async () => (await gate, [undefined, {}]) } });
    await s.send("openLink", { text: LINK });
    s.actor.send({ type: "ask" } as never);
    await Promise.resolve();
    expect(s.actor.state.name).toBe("sending");
    s.actor.send({ type: "notNow" } as never);
    s.actor.send({ type: "ask" } as never);
    release();
    await s.actor.settled();
    expect(s.actor.state.name).toBe("waiting");
  });

  test.each([
    ["rejects", { ask: async () => Promise.reject(new Error("x")) }],
    ["returns an error", { ask: async () => [new Error("x"), undefined] as [unknown, unknown] }],
  ])("a send that %s goes back to reviewing with an error", async (_n, port) => {
    const s = await waitingSetup({ port });
    expect(s.actor.state.name).toBe("reviewing");
    expect(error(s)).toBe(SEND_FAILED);
    expect(payload(s)).toEqual(INVITE);
  });

  test("a retry after a failed send works", async () => {
    let fail = true;
    const s = await waitingSetup({
      port: { ask: async () => (fail ? [new Error("x"), undefined] : [undefined, {}]) },
    });
    fail = false;
    await s.send("ask");
    expect(s.actor.state.name).toBe("waiting");
    expect(error(s)).toBe("");
  });
});

describe("waiting", () => {
  test("close goes idle and sends nothing", async () => {
    const s = await waitingSetup();
    await s.send("close");
    expect(s.actor.state.name).toBe("idle");
    expect(s.outputs).toEqual([]);
  });

  test("accepted opens the album", async () => {
    const s = await waitingSetup();
    await s.send("answered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("idle");
    expect(s.outputs).toEqual([{ type: "openAlbum", payload: { folderId: "f9" } }]);
  });

  test("declined shows declined", async () => {
    const s = await waitingSetup();
    await s.send("answered", { code: INVITE.code, answer: "declined" });
    expect(s.actor.state.name).toBe("declined");
    expect(payload(s)).toEqual(INVITE);
  });

  test.each(["accepted", "declined"] as const)(
    "an answer for another code (%s) changes nothing",
    async (answer) => {
      const s = await waitingSetup();
      await s.send("answered", { code: "c".repeat(64), answer, folderId: "f9" });
      expect(s.actor.state.name).toBe("waiting");
      expect(s.outputs).toEqual([]);
    },
  );

  test("an accepted answer with no folder keeps waiting", async () => {
    const s = await waitingSetup();
    await s.send("answered", { code: INVITE.code, answer: "accepted" });
    expect(s.actor.state.name).toBe("waiting");
  });

  test("answers outside waiting are dropped", async () => {
    const s = setup();
    await s.send("answered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("idle");
    expect(s.outputs).toEqual([]);
  });
});

describe("declined", () => {
  test("ok goes idle", async () => {
    const s = setup();
    await s.send("openAsk", { ask: ask("declined") });
    await s.send("ok");
    expect(s.actor.state.name).toBe("idle");
  });

  test("the decline is final: a later answer does not change it", async () => {
    const s = setup();
    await s.send("openAsk", { ask: ask("declined") });
    await s.send("answered", { code: INVITE.code, answer: "accepted", folderId: "f9" });
    expect(s.actor.state.name).toBe("declined");
  });
});

/** Each walk is the same steps as the link in docs/design/sharing-flows.md (Walks). */
const OPEN = `openLink={"text":"${LINK}"}`;
const ANSWER = (answer: string, folder = "") =>
  `answered={"code":"${INVITE.code}","answer":"${answer}"${folder}}`;
const ROW = (status: string) =>
  `openAsk={"ask":{"code":"${INVITE.code}","owner":"${INVITE.owner}","albumName":"Spain 2026","ownerName":"Nils","askedAt":1,"status":"${status}"}}`;
const OLD = `openLink={"text":"justus://join/${INVITE.code}?n=Spain 2026&a=Nils"}`;
const WALKS: [string, string[], string][] = [
  ["Maya opens a link from before the new key", [OLD], "idle"],
  ["Maya asks and is accepted", [OPEN, "ask", ANSWER("accepted", ',"folderId":"f1"')], "idle"],
  ["Maya asks and is declined", [OPEN, "ask", ANSWER("declined")], "declined"],
  ["Maya reopens her ask while waiting", [OPEN, "ask", "close", ROW("waiting")], "waiting"],
  [
    "Maya reopens her ask after a decline",
    [OPEN, "ask", ANSWER("declined"), "ok", ROW("declined")],
    "declined",
  ],
];

describe("joiner walks", () => {
  test.each(WALKS)("%s", async (_name, steps, finalState) => {
    const s = setup();
    for (const step of steps) {
      const cut = step.indexOf("=");
      if (cut === -1) await s.send(step);
      else await s.send(step.slice(0, cut), JSON.parse(step.slice(cut + 1)));
    }
    expect(s.actor.state.name).toBe(finalState);
  });
});
