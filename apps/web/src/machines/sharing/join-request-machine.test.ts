import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { describe, expect, test } from "vite-plus/test";
import {
  ADMIN_OFFLINE_HINT_AFTER_MS,
  createJoinRequestActor,
  parseJoinLink,
} from "./join-request-machine";

const LINK = "justus://join?i=abc123&n=Spain%202026&a=Nils";

function setup() {
  const clock = VirtualClock();
  const actor = createJoinRequestActor({ clock });
  const outputs: string[] = [];
  onOutput(actor, (e) => outputs.push(e.type));
  const send = (type: string, payload?: unknown) => actor.send({ type, payload } as never);
  return { clock, actor, outputs, send };
}

async function waitingActor() {
  const s = setup();
  s.send("openLink", { link: LINK });
  s.send("ask");
  await s.actor.settled();
  return s;
}

const payload = (actor: ReturnType<typeof setup>["actor"]) => actor.snapshot().payload;

describe("parseJoinLink", () => {
  test.each(["", "hello", "justus://join?n=x", "justus://join?i=!!&n=x", "justus://join?i=ab"])(
    "rejects %j",
    (text) => expect(parseJoinLink(text)).toBeUndefined(),
  );
  test("reads album and Admin from a message containing the link", () => {
    expect(parseJoinLink(`join us ${LINK} thanks`)).toEqual({ album: "Spain 2026", admin: "Nils" });
  });
});

describe("join request machine", () => {
  test("a garbled link stays in idle", async () => {
    const { actor, send } = setup();
    send("openLink", { link: "justus://join/not-a-link" });
    await actor.settled();
    expect(actor.state.name).toBe("idle");
  });

  test("a good link asks 'Join <album>?'", async () => {
    const { actor, send } = setup();
    send("openLink", { link: LINK });
    await actor.settled();
    expect(actor.state.name).toBe("reviewing");
    expect(payload(actor)).toEqual({ album: "Spain 2026", admin: "Nils" });
  });

  test("cancel while reviewing sends nothing", async () => {
    const { actor, send, outputs } = setup();
    send("openLink", { link: LINK });
    send("cancel");
    await actor.settled();
    expect(actor.state.name).toBe("idle");
    expect(outputs).toEqual([]);
  });

  test("asking sends the request and waits", async () => {
    const { actor, outputs } = await waitingActor();
    expect(actor.state.name).toBe("waiting");
    expect(outputs).toEqual(["requestSent"]);
  });

  test("the offline hint shows after 30 s, not before", async () => {
    const { actor, clock } = await waitingActor();
    clock.advance(ADMIN_OFFLINE_HINT_AFTER_MS - 1);
    await actor.settled();
    expect((payload(actor) as { hint: boolean }).hint).toBe(false);
    clock.advance(1);
    await actor.settled();
    expect((payload(actor) as { hint: boolean }).hint).toBe(true);
  });

  test("cancel while waiting withdraws the request", async () => {
    const { actor, send, outputs } = await waitingActor();
    send("cancel");
    await actor.settled();
    expect(actor.state.name).toBe("idle");
    expect(outputs).toEqual(["requestSent", "requestWithdrawn"]);
  });

  test.each([["reader"], ["member"]] as const)("accepted as %s", async (role) => {
    const { actor, send } = await waitingActor();
    send("accepted", { role });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
    expect(payload(actor)).toEqual({ role });
  });

  test("declined", async () => {
    const { actor, send } = await waitingActor();
    send("adminDeclined");
    await actor.settled();
    expect(actor.state.name).toBe("declined");
  });

  test.each([["expired"], ["cancelled"]] as const)("link %s", async (reason) => {
    const { actor, send } = await waitingActor();
    send("linkRefused", { reason });
    await actor.settled();
    expect(actor.state.name).toBe("refused");
    expect(payload(actor)).toEqual({ reason });
  });

  test("an answer after the hint still works", async () => {
    const { actor, send, clock } = await waitingActor();
    clock.advance(ADMIN_OFFLINE_HINT_AFTER_MS);
    await actor.settled();
    send("accepted", { role: "reader" });
    await actor.settled();
    expect(actor.state.name).toBe("joined");
  });
});

/** Each walk is the same steps as the link in docs/design/sharing-flows.md (Walks). */
const OPEN = `openLink={"link":"${LINK}"}`;
const WALKS: [string, string[], string][] = [
  [
    "Story 1, Maya: waits past the hint, then is accepted as Collaborator",
    [OPEN, "ask", "@30000", 'accepted={"role":"member"}'],
    "joined",
  ],
  ["Story 1, Maya: link expired", [OPEN, "ask", 'linkRefused={"reason":"expired"}'], "refused"],
  ["Story 1, Maya: declined", [OPEN, "ask", "adminDeclined"], "declined"],
  ["Story 3, relative: accepted as Viewer", [OPEN, "ask", 'accepted={"role":"reader"}'], "joined"],
];

describe("joiner walks", () => {
  test.each(WALKS)("%s", async (_name, steps, finalState) => {
    const { actor, clock } = setup();
    for (const step of steps) {
      if (step.startsWith("@")) clock.advance(Number(step.slice(1)));
      else {
        const cut = step.indexOf("=");
        if (cut === -1) actor.send({ type: step } as never);
        else
          actor.send({
            type: step.slice(0, cut),
            payload: JSON.parse(step.slice(cut + 1)),
          } as never);
      }
      await actor.settled();
    }
    expect(actor.state.name).toBe(finalState);
  });
});
