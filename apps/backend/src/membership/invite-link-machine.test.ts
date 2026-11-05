import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
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
    actor.send({ type: "create", payload: { validFor } });
    await actor.settled();
    expect(VALID_FOR_MS[validFor]).toBe(ms);
    expect(expiresAt(actor)).toBe(1_000 + ms);
    clock.advance(ms - 1);
    await actor.settled();
    expect(actor.state.name).toBe("live");
    clock.advance(1);
    await actor.settled();
    expect(actor.state.name).toBe("expired");
  });

  test("a request before expiry is queued", async () => {
    const { clock, actor, outputs } = setup();
    actor.send({ type: "create", payload: { validFor: "1h" } });
    clock.advance(1_000);
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(actor.state.name).toBe("live");
    expect(outputs).toEqual([{ type: "requestQueued", payload: request }]);
  });

  test("a request after expiry is refused as expired", async () => {
    const { clock, actor, outputs } = setup();
    actor.send({ type: "create", payload: { validFor: "10m" } });
    clock.advance(VALID_FOR_MS["10m"]);
    await actor.settled();
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(outputs).toEqual([{ type: "requestRefused", payload: { reason: "expired", request } }]);
  });

  test("a request after cancel is refused as cancelled", async () => {
    const { actor, outputs } = setup();
    actor.send({ type: "create", payload: { validFor: "1d" } });
    actor.send({ type: "cancel" });
    await actor.settled();
    expect(actor.state.name).toBe("cancelled");
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(outputs).toEqual([
      { type: "requestRefused", payload: { reason: "cancelled", request } },
    ]);
  });

  test("cancel after expiry is ignored", async () => {
    const { clock, actor, outputs } = setup();
    actor.send({ type: "create", payload: { validFor: "10m" } });
    clock.advance(VALID_FOR_MS["10m"]);
    await actor.settled();
    actor.send({ type: "cancel" });
    await actor.settled();
    expect(actor.state.name).toBe("expired");
    actor.send({ type: "requestArrived", payload: request });
    await actor.settled();
    expect(outputs.map((o) => (o.payload as { reason?: string }).reason)).toEqual(["expired"]);
  });

  test("a cancelled link never expires", async () => {
    const { clock, actor } = setup();
    actor.send({ type: "create", payload: { validFor: "10m" } });
    actor.send({ type: "cancel" });
    clock.advance(VALID_FOR_MS["7d"]);
    await actor.settled();
    expect(actor.state.name).toBe("cancelled");
  });
});
