import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import { recordRuns } from "@mantaq/inspect/record";
import { expectAllStatesReached, expectNoDesignErrors } from "@mantaq/inspect";
import { describe, expect, test } from "vite-plus/test";
import {
  createInviteLinkActor,
  VALID_FOR_MS,
  type LinkRequest,
  type ValidFor,
} from "./invite-link-machine";

const request: LinkRequest = { requesterKey: "a".repeat(64), requesterName: "Maya" };

function setup() {
  const clock = VirtualClock();
  const actor = createInviteLinkActor({ clock });
  const outputs: { type: string; payload?: unknown }[] = [];
  onOutput(actor, (e) => outputs.push({ type: e.type, payload: e.payload }));
  return { clock, actor, outputs };
}

const expiresAt = (actor: ReturnType<typeof setup>["actor"]) =>
  (actor.snapshot().payload as { expiresAt: number }).expiresAt;

describe("invite link machine", () => {
  test.each([
    ["10m", 600_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
    ["7d", 604_800_000],
  ] as [ValidFor, number][])("validFor %s expires after %i ms", async (validFor, ms) => {
    const { clock, actor } = setup();
    clock.advance(1_000);
    actor.send({ type: "createLink", payload: { validFor } });
    await actor.settled();
    expect(VALID_FOR_MS[validFor]).toBe(ms);
    expect(expiresAt(actor)).toBe(1_000 + ms);
    clock.advance(ms - 1);
    await actor.settled();
    expect(actor.state.name).toBe("linkActive");
    clock.advance(1);
    await actor.settled();
    expect(actor.state.name).toBe("expired");
  });

  test("a request before expiry is queued", async () => {
    const { clock, actor, outputs } = setup();
    actor.send({ type: "createLink", payload: { validFor: "1h" } });
    clock.advance(1_000);
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(actor.state.name).toBe("linkActive");
    expect(outputs).toEqual([{ type: "requestQueued", payload: request }]);
  });

  test("a request after expiry is refused as expired", async () => {
    const { clock, actor, outputs } = setup();
    actor.send({ type: "createLink", payload: { validFor: "10m" } });
    clock.advance(VALID_FOR_MS["10m"]);
    await actor.settled();
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(outputs).toEqual([{ type: "requestRefused", payload: { reason: "expired", request } }]);
  });

  test("a request after cancelling is refused as cancelled", async () => {
    const { actor, outputs } = setup();
    actor.send({ type: "createLink", payload: { validFor: "1d" } });
    actor.send({ type: "cancelLink" });
    await actor.settled();
    expect(actor.state.name).toBe("cancelled");
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(outputs).toEqual([
      { type: "requestRefused", payload: { reason: "cancelled", request } },
    ]);
  });

  test("cancelling after expiry is ignored", async () => {
    const { clock, actor, outputs } = setup();
    actor.send({ type: "createLink", payload: { validFor: "10m" } });
    clock.advance(VALID_FOR_MS["10m"]);
    await actor.settled();
    actor.send({ type: "cancelLink" });
    await actor.settled();
    expect(actor.state.name).toBe("expired");
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(outputs.map((o) => (o.payload as { reason?: string }).reason)).toEqual(["expired"]);
  });

  test("a cancelled link never expires", async () => {
    const { clock, actor } = setup();
    actor.send({ type: "createLink", payload: { validFor: "10m" } });
    actor.send({ type: "cancelLink" });
    clock.advance(VALID_FOR_MS["7d"]);
    await actor.settled();
    expect(actor.state.name).toBe("cancelled");
  });
});

const walkTarget = () => createInviteLinkActor({ clock: VirtualClock() });
const make = recordRuns(createInviteLinkActor);

async function walk(options: {
  validFor: ValidFor;
  closing: "time" | "cancel";
}): Promise<ReturnType<typeof make>> {
  const clock = VirtualClock();
  const actor = make({ clock });
  actor.send({ type: "createLink", payload: { validFor: options.validFor } });
  await actor.settled();
  actor.send({ type: "requestArrived", payload: request });
  await actor.settled();
  if (options.closing === "time") clock.advance(VALID_FOR_MS[options.validFor]);
  else actor.send({ type: "cancelLink" });
  await actor.settled();
  actor.send({ type: "requestArrived", payload: request });
  await actor.settled();
  return actor;
}

test("Nils's link: a 1 day link queues Maya's request, then expires and refuses the next one", async () => {
  const actor = await walk({ validFor: "1d", closing: "time" });
  expect(actor.state.name).toBe("expired");
});

test("Nils's link: a 7 day link, then the week is over", async () => {
  const actor = await walk({ validFor: "7d", closing: "time" });
  expect(actor.state.name).toBe("expired");
});

test("Nils's link: a stranger is in the chat, so he cancels", async () => {
  const actor = await walk({ validFor: "7d", closing: "cancel" });
  expect(actor.state.name).toBe("cancelled");
});

test("Nils's link: a 1 hour link for the family expires", async () => {
  const actor = await walk({ validFor: "1h", closing: "time" });
  expect(actor.state.name).toBe("expired");
});

describe("invite link edge cases", () => {
  test("a link with an unknown validity expires at once instead of throwing", async () => {
    const { clock, actor } = setup();
    actor.send({ type: "createLink", payload: { validFor: "forever" as ValidFor } });
    clock.advance(0);
    await actor.settled();
    expect(actor.state.name).toBe("expired");
  });
});

describe("invite link design", () => {
  test("has no design errors", () => {
    expectNoDesignErrors({ id: "inviteLink", create: walkTarget });
  });
  test("reaches every state", () => {
    expectAllStatesReached({ id: "inviteLink", create: walkTarget });
  });
});
