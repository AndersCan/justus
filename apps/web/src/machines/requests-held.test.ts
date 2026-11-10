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

function setup(keys = ["k1", "k2"]) {
  const pending: ((v: [unknown, unknown]) => void)[] = [];
  const port = {
    requests: vi.fn(async () => [null, { requests: keys.map((k) => request("f1", k)) }] as never),
    respond: vi.fn(() => new Promise<[unknown, unknown]>((r) => pending.push(r)) as never),
  };
  const actor = createRequestsActor({ clock: VirtualClock(), gateway: port as never });
  return { actor, port, pending };
}

describe("held decline while another answer is being sent", () => {
  test("the held No finishing during an Accept does not send the Accept twice", async () => {
    const { actor, port } = setup();
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(ev("HOLD_DECLINE", { folderId: "f1", requesterKey: "k1" }));
    actor.send(
      ev("RESPOND", { folderId: "f1", requesterKey: "k2", approve: true, role: "reader" }),
    );
    expect(actor.state.name).toBe("sendingAnswer");
    await Promise.resolve();
    expect(port.respond).toHaveBeenCalledTimes(1);
    // the toast closes and the held No went through
    actor.send(ev("DECLINE_SENT", { folderId: "f1", requesterKey: "k1" }));
    await Promise.resolve();
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  test("Undo during Accept all does not send the batch's current answer twice", async () => {
    const { actor, port } = setup(["k1", "k2", "k3"]);
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(ev("HOLD_DECLINE", { folderId: "f1", requesterKey: "k1" }));
    actor.send(ev("ACCEPT_ALL_AS_VIEWERS", { folderId: "f1", requesterKeys: ["k2", "k3"] }));
    actor.send(ev("CONFIRM_ACCEPT_ALL"));
    expect(actor.state.name).toBe("sendingAnswersToAll");
    await Promise.resolve();
    expect(port.respond).toHaveBeenCalledTimes(1);
    actor.send(ev("UNDO_DECLINE", { folderId: "f1", requesterKey: "k1" }));
    await Promise.resolve();
    expect(port.respond).toHaveBeenCalledTimes(1);
  });
});

describe("held decline in every state", () => {
  const hold = (k: string) => ev("HOLD_DECLINE", { folderId: "f1", requesterKey: k });
  const key = (k: string) => ({ folderId: "f1", requesterKey: k });
  const keys = (a: ReturnType<typeof setup>["actor"]) =>
    a.snapshot().context.requests.map((r) => r.requesterKey);

  test("Hold and Undo work while loading", async () => {
    const { actor } = setup();
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(ev("REFRESH"));
    expect(actor.state.name).toBe("loadingRequests");
    actor.send(hold("k1"));
    expect(keys(actor)).toEqual(["k2"]);
    actor.send(ev("UNDO_DECLINE", key("k1")));
    expect(keys(actor)).toEqual(["k1", "k2"]);
    expect(actor.state.name).toBe("loadingRequests");
  });

  test("Hold and Undo work while an answer is sent, and the state stays", async () => {
    const { actor, port } = setup(["k1", "k2", "k3"]);
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(
      ev("RESPOND", { folderId: "f1", requesterKey: "k3", approve: true, role: "reader" }),
    );
    expect(actor.state.name).toBe("sendingAnswer");
    actor.send(hold("k1"));
    expect(keys(actor)).toEqual(["k2", "k3"]);
    actor.send(ev("UNDO_DECLINE", key("k1")));
    expect(keys(actor)).toEqual(["k1", "k2", "k3"]);
    expect(actor.state.name).toBe("sendingAnswer");
    await Promise.resolve();
    expect(port.respond).toHaveBeenCalledTimes(1);
  });

  test("Hold works during Accept all and while confirming", async () => {
    const { actor } = setup(["k1", "k2", "k3"]);
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(ev("ACCEPT_ALL_AS_VIEWERS", { folderId: "f1", requesterKeys: ["k2", "k3"] }));
    expect(actor.state.name).toBe("confirmingAcceptAll");
    actor.send(hold("k1"));
    expect(keys(actor)).toEqual(["k2", "k3"]);
    actor.send(ev("CONFIRM_ACCEPT_ALL"));
    expect(actor.state.name).toBe("sendingAnswersToAll");
    actor.send(ev("UNDO_DECLINE", key("k1")));
    expect(keys(actor)).toEqual(["k1", "k2", "k3"]);
    expect(actor.state.name).toBe("sendingAnswersToAll");
  });

  test("Hold works after a failed load", async () => {
    const port = {
      requests: vi.fn(async () => [new Error("offline"), null] as never),
      respond: vi.fn(),
    };
    const actor = createRequestsActor({ clock: VirtualClock(), gateway: port as never });
    actor.send(ev("REFRESH"));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotLoadRequests");
    actor.send(hold("k1"));
    expect(actor.state.name).toBe("couldNotLoadRequests");
  });

  test("a held No that fails brings the card back and says so", async () => {
    const { actor } = setup();
    const out: { type: string; payload: unknown }[] = [];
    onOutput(actor, (e) => out.push(e as never));
    actor.send(ev("REFRESH"));
    await actor.settled();
    actor.send(hold("k1"));
    out.length = 0;
    actor.send(ev("DECLINE_FAILED", key("k1")));
    expect(keys(actor)).toEqual(["k1", "k2"]);
    expect(out).toEqual([{ type: "DECLINE_NOT_SENT", payload: { requesterName: "k1" } }]);
    actor.send(ev("DECLINE_FAILED", key("k1")));
    expect(out).toHaveLength(1);
  });
});
