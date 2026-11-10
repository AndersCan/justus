import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import type { JoinRequest } from "@justus/core";
import { createRequestsActor } from "./requests-machine";

vi.mock("../gateway", () => ({ gateway: { logs: { view: vi.fn(), clear: vi.fn() } } }));

const request = (folderId: string, requesterKey: string) =>
  ({
    folderId,
    requesterKey,
    requesterName: requesterKey,
    viaInvite: true,
  }) as unknown as JoinRequest;
const ev = (type: string, payload?: unknown) => ({ type, payload }) as never;
const key = (k: string) => ({ folderId: "f1", requesterKey: k });

describe("held decline in the two failure states", () => {
  test("Hold and Undo work after an answer could not be sent", async () => {
    const port = {
      requests: vi.fn(
        async () => [null, { requests: ["k1", "k2"].map((k) => request("f1", k)) }] as never,
      ),
      respond: vi.fn(async () => [new Error("offline"), null] as never),
    };
    const actor = createRequestsActor({ clock: VirtualClock(), gateway: port as never });
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(
      ev("RESPOND", { folderId: "f1", requesterKey: "k2", approve: true, role: "reader" }),
    );
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSendAnswer");
    actor.send(ev("HOLD_DECLINE", key("k1")));
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k2"]);
    actor.send(ev("UNDO_DECLINE", key("k1")));
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k1", "k2"]);
    expect(actor.state.name).toBe("couldNotSendAnswer");
  });

  test("a held No that fails after a failed reload brings the card back and says so", async () => {
    let fail = false;
    const port = {
      requests: vi.fn(async () =>
        fail
          ? ([new Error("offline"), null] as never)
          : ([null, { requests: ["k1", "k2"].map((k) => request("f1", k)) }] as never),
      ),
      respond: vi.fn(),
    };
    const actor = createRequestsActor({ clock: VirtualClock(), gateway: port as never });
    const out: { type: string }[] = [];
    onOutput(actor, (e) => out.push(e as never));
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(ev("HOLD_DECLINE", key("k1")));
    fail = true;
    actor.send(ev("REFRESH"));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotLoadRequests");
    actor.send(ev("DECLINE_FAILED", key("k1")));
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toContain("k1");
    expect(out.map((e) => e.type)).toContain("DECLINE_NOT_SENT");
  });
});
