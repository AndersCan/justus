import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { onOutput } from "@mantaq/sugar";
import type { JoinRequest } from "@justus/core";
import { createRequestsActor, requestsViewModel, viewerAcceptKeys } from "./requests-machine";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const request = (folderId: string, requesterKey: string, viaInvite = false) =>
  ({ folderId, requesterKey, requesterName: requesterKey, viaInvite }) as unknown as JoinRequest;

const refresh = () => ({ type: "REFRESH" }) as never;
const retry = () => ({ type: "RETRY" }) as never;
const acceptAll = (folderId: string, keys: string[]) =>
  ({ type: "ACCEPT_ALL", payload: { folderId, requesterKeys: keys, role: "reader" } }) as never;
const respond = (
  folderId: string,
  requesterKey: string,
  approve: boolean,
  role: "reader" | "member" = "member",
) => ({ type: "RESPOND", payload: { folderId, requesterKey, approve, role } }) as never;

function setup(
  options: {
    requests?: () => Promise<[unknown, unknown]>;
    respond?: () => Promise<[unknown, unknown]>;
  } = {},
) {
  const port = {
    requests: vi.fn(
      options.requests ??
        (async () =>
          [null, { requests: [request("f1", "k1", true), request("f1", "k2")] }] as never),
    ),
    respond: vi.fn(options.respond ?? (async () => [null, { ok: true }] as never)),
  };
  const actor = createRequestsActor({ clock: VirtualClock(), gateway: port as never });
  return { actor, port };
}

describe("requests machine factory", () => {
  test("refresh loads the requests", async () => {
    const { actor } = setup();
    actor.send(refresh());
    expect(actor.state.name).toBe("loadingRequests");
    await actor.settled();
    expect(actor.state.name).toBe("showingRequests");
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k1", "k2"]);
  });

  test("a failed refresh shows the error", async () => {
    const { actor } = setup({ requests: async () => [new Error("offline"), null] });
    actor.send(refresh());
    await actor.settled();
    expect(actor.state.name).toBe("couldNotLoadRequests");
    expect(actor.snapshot().context.error).toBe("offline");
  });

  test("an answer without data is an error", async () => {
    const { actor } = setup({ requests: async () => [null, null] });
    actor.send(refresh());
    await actor.settled();
    expect(actor.snapshot().context.error).toBe("requests returned no data");
  });

  test("retry clears the error and loads again", async () => {
    let fail = true;
    const { actor } = setup({
      requests: async () =>
        fail ? [new Error("offline"), null] : [null, { requests: [request("f1", "k1")] }],
    });
    actor.send(refresh());
    await actor.settled();
    fail = false;
    actor.send(retry());
    expect(actor.state.name).toBe("loadingRequests");
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(actor.state.name).toBe("showingRequests");
    expect(actor.snapshot().context.requests).toHaveLength(1);
  });

  test("refresh after an error clears it", async () => {
    let fail = true;
    const { actor } = setup({
      requests: async () => (fail ? [new Error("offline"), null] : [null, { requests: [] }]),
    });
    actor.send(refresh());
    await actor.settled();
    fail = false;
    actor.send(refresh());
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(actor.state.name).toBe("showingRequests");
  });

  test.each([true, false])("responding (approve=%s) removes that request", async (approve) => {
    const { actor, port } = setup();
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", approve));
    expect(actor.state.name).toBe("sendingAnswer");
    await actor.settled();
    expect(port.respond).toHaveBeenCalledWith("f1", "k1", approve, "member");
    expect(actor.state.name).toBe("showingRequests");
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k2"]);
  });

  test("accepting as a Viewer sends the reader role", async () => {
    const { actor, port } = setup();
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true, "reader"));
    await actor.settled();
    expect(port.respond).toHaveBeenCalledWith("f1", "k1", true, "reader");
  });

  test("a failed answer keeps the request and shows the error", async () => {
    const { actor } = setup({ respond: async () => [new Error("not the owner"), null] });
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSendAnswer");
    expect(actor.snapshot().context.error).toBe("not the owner");
    expect(actor.snapshot().context.requests).toHaveLength(2);
    expect(requestsViewModel(actor.snapshot()).settled).toBe(true);
  });

  test("from couldNotSendAnswer, RESPOND sends again and REFRESH reloads", async () => {
    const { actor } = setup({ respond: async () => [new Error("not the owner"), null] });
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true));
    await actor.settled();
    actor.send(respond("f1", "k1", false));
    expect(actor.state.name).toBe("sendingAnswer");
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSendAnswer");
    actor.send(refresh());
    expect(actor.state.name).toBe("loadingRequests");
    await actor.settled();
    expect(actor.state.name).toBe("showingRequests");
  });

  test("a sent answer announces who is in and how", async () => {
    const { actor } = setup();
    const sent: unknown[] = [];
    onOutput(actor, (e) => {
      if (e.type === "ANSWER_SENT") sent.push(e.payload);
    });
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true, "reader"));
    await actor.settled();
    actor.send(respond("f1", "k2", false));
    await actor.settled();
    expect(sent).toEqual([
      { requesterName: "k1", approve: true, role: "reader", viaInvite: true },
      { requesterName: "k2", approve: false, role: "member", viaInvite: false },
    ]);
  });

  test("a failed answer is kept: the view model names it and nothing is announced", async () => {
    const { actor } = setup({ respond: async () => [new Error("invoke timeout"), null] });
    const sent: string[] = [];
    onOutput(actor, (e) => sent.push(e.type));
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true));
    await actor.settled();
    expect(requestsViewModel(actor.snapshot()).failedAnswer).toEqual({
      folderId: "f1",
      requesterKey: "k1",
      approve: true,
      role: "member",
    });
    expect(sent).toEqual([]);
  });

  test("Retry after a failed answer sends the same answer again", async () => {
    const { actor, port } = setup();
    port.respond.mockResolvedValueOnce([new Error("invoke timeout"), null] as never);
    const sent: string[] = [];
    onOutput(actor, (e) => sent.push(e.type));
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true, "reader"));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSendAnswer");
    actor.send(retry());
    expect(actor.state.name).toBe("sendingAnswer");
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect(port.respond).toHaveBeenCalledTimes(2);
    expect(port.respond).toHaveBeenNthCalledWith(1, "f1", "k1", true, "reader");
    expect(port.respond).toHaveBeenNthCalledWith(2, "f1", "k1", true, "reader");
    expect(actor.state.name).toBe("showingRequests");
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k2"]);
    expect(requestsViewModel(actor.snapshot()).failedAnswer).toBeNull();
    expect(sent).toEqual(["ANSWER_SENT"]);
  });

  test("Refresh after a failed answer forgets it", async () => {
    const { actor } = setup({ respond: async () => [new Error("invoke timeout"), null] });
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true));
    await actor.settled();
    actor.send(refresh());
    await actor.settled();
    expect(requestsViewModel(actor.snapshot()).failedAnswer).toBeNull();
    expect(actor.snapshot().context.pendingRespond).toBeNull();
  });
});

describe("accept all as Viewers", () => {
  const three = [request("f1", "k1", true), request("f1", "k2", true), request("f1", "k3", true)];
  const load = async (list: JoinRequest[]) => {
    const s = setup({ requests: async () => [null, { requests: list }] });
    const outputs: { type: string; payload?: unknown }[] = [];
    // The stubbed reload hands back the answered people again; these tests are about the batch total.
    s.actor.on("output", {
      fn: (e) => void (e.type !== "REQUESTS_ARRIVED" && outputs.push(e as never)),
    });
    s.actor.send(refresh());
    await s.actor.settled();
    return { ...s, outputs };
  };

  test("sends a Viewer answer to each person in turn, then one total and a reload", async () => {
    const { actor, port, outputs } = await load([
      request("f1", "k1", true),
      request("f1", "k2", true),
      request("f2", "k9", true),
    ]);
    const gates: ((v: [unknown, unknown]) => void)[] = [];
    port.respond.mockImplementation(() => new Promise((res) => gates.push(res as never)));
    actor.send(acceptAll("f1", ["k1", "k2"]));
    await Promise.resolve();
    expect(actor.state.name).toBe("sendingAnswersToAll");
    expect(requestsViewModel(actor.snapshot()).responding).toBe(true);
    expect(port.respond).toHaveBeenCalledTimes(1);
    expect(port.respond).toHaveBeenLastCalledWith("f1", "k1", true, "reader");
    gates[0]!([null, { ok: true }]);
    await vi.waitFor(() => expect(port.respond).toHaveBeenCalledTimes(2));
    expect(port.respond).toHaveBeenLastCalledWith("f1", "k2", true, "reader");
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k2", "k9"]);
    gates[1]!([null, { ok: true }]);
    await actor.settled();
    expect(outputs.map((o) => o.type)).toEqual(["ALL_ACCEPTED"]);
    expect(outputs[0]!.payload).toEqual({ count: 2, role: "reader" });
    expect(port.requests).toHaveBeenCalledTimes(2);
    expect(actor.state.name).toBe("showingRequests");
  });

  test("only people still waiting in that album are answered, once each", async () => {
    const { actor, port, outputs } = await load([
      request("f1", "k1", true),
      request("f2", "k9", true),
    ]);
    actor.send(acceptAll("f1", ["k1", "kGone", "k9", "k1"]));
    await actor.settled();
    expect(port.respond).toHaveBeenCalledTimes(1);
    expect(port.respond).toHaveBeenCalledWith("f1", "k1", true, "reader");
    expect(outputs[0]!.payload).toEqual({ count: 1, role: "reader" });
  });

  test("with nobody still waiting nothing happens", async () => {
    const { actor, port } = await load(three);
    actor.send(acceptAll("f1", ["kGone"]));
    await actor.settled();
    expect(actor.state.name).toBe("showingRequests");
    expect(port.respond).not.toHaveBeenCalled();
  });

  test("a connection error stops the batch with the rest still waiting and no toast", async () => {
    const { actor, port, outputs } = await load(three);
    port.respond
      .mockResolvedValueOnce([null, { ok: true }] as never)
      .mockResolvedValueOnce([new Error("invoke timeout for x"), null] as never);
    actor.send(acceptAll("f1", ["k1", "k2", "k3"]));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSendAnswer");
    const vm = requestsViewModel(actor.snapshot());
    expect(vm.error).toBe("invoke timeout for x");
    expect(vm.failedAnswer?.requesterKey).toBe("k2");
    expect(port.respond).toHaveBeenCalledTimes(2);
    expect(vm.requests.map((r) => r.requesterKey)).toEqual(["k2", "k3"]);
    expect(outputs).toEqual([]);
  });

  test("Retry resends the failed answer, goes on with those still waiting and counts the whole batch", async () => {
    const { actor, port, outputs } = await load(three);
    port.respond
      .mockResolvedValueOnce([null, { ok: true }] as never)
      .mockResolvedValueOnce([new Error("invoke timeout"), null] as never);
    actor.send(acceptAll("f1", ["k1", "k2", "k3"]));
    await actor.settled();
    actor.send(retry());
    expect(actor.state.name).toBe("sendingAnswersToAll");
    expect(actor.snapshot().context.error).toBeNull();
    await actor.settled();
    expect((port.respond.mock.calls as unknown as string[][]).map((c) => c[1])).toEqual([
      "k1",
      "k2",
      "k2",
      "k3",
    ]);
    expect(outputs.map((o) => o.payload)).toEqual([{ count: 3, role: "reader" }]);
    expect(actor.state.name).toBe("showingRequests");
  });

  test("a failure on the first answer stops with none sent, and Retry sends everyone", async () => {
    const { actor, port, outputs } = await load(three);
    port.respond.mockResolvedValueOnce([new Error("invoke timeout"), null] as never);
    actor.send(acceptAll("f1", ["k1", "k2", "k3"]));
    await actor.settled();
    expect(actor.state.name).toBe("couldNotSendAnswer");
    actor.send(retry());
    await actor.settled();
    expect(outputs.map((o) => o.payload)).toEqual([{ count: 3, role: "reader" }]);
  });

  test("a refresh after a stop forgets the batch", async () => {
    const { actor, port, outputs } = await load(three);
    port.respond.mockResolvedValueOnce([new Error("invoke timeout"), null] as never);
    actor.send(acceptAll("f1", ["k1", "k2", "k3"]));
    await actor.settled();
    actor.send(refresh());
    await actor.settled();
    expect(actor.snapshot().context.stoppedBatch).toBeNull();
    expect(requestsViewModel(actor.snapshot()).failedAnswer).toBeNull();
    expect(port.respond).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([]);
  });

  test("answering one card after a stop forgets the batch", async () => {
    const { actor, port, outputs } = await load(three);
    port.respond.mockResolvedValueOnce([new Error("invoke timeout"), null] as never);
    actor.send(acceptAll("f1", ["k1", "k2", "k3"]));
    await actor.settled();
    actor.send(respond("f1", "k2", false));
    await actor.settled();
    expect(actor.state.name).toBe("showingRequests");
    expect(port.respond).toHaveBeenCalledTimes(2);
    expect(outputs.map((o) => o.type)).toEqual(["ANSWER_SENT"]);
    expect(actor.snapshot().context.stoppedBatch).toBeNull();
  });

  test("accept all again after a stop starts a new batch", async () => {
    const { actor, port, outputs } = await load(three);
    port.respond.mockResolvedValueOnce([new Error("invoke timeout"), null] as never);
    actor.send(acceptAll("f1", ["k1", "k2", "k3"]));
    await actor.settled();
    actor.send(acceptAll("f1", ["k1", "k2"]));
    await actor.settled();
    expect(outputs.map((o) => o.payload)).toEqual([{ count: 2, role: "reader" }]);
  });

  test("a refresh during the batch is ignored and a newcomer is not answered", async () => {
    const { actor, port } = await load([request("f1", "k1", true), request("f1", "k2", true)]);
    port.requests.mockResolvedValue([null, { requests: [request("f1", "k3", true)] }] as never);
    actor.send(acceptAll("f1", ["k1", "k2"]));
    actor.send(refresh());
    expect(actor.state.name).toBe("sendingAnswersToAll");
    await actor.settled();
    expect((port.respond.mock.calls as unknown as string[][]).map((c) => c[1])).toEqual([
      "k1",
      "k2",
    ]);
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k3"]);
  });

  test("if the reload after the batch fails the total is still announced", async () => {
    const { actor, port, outputs } = await load([request("f1", "k1", true)]);
    port.requests.mockResolvedValue([new Error("offline"), null] as never);
    actor.send(acceptAll("f1", ["k1"]));
    await actor.settled();
    expect(outputs.map((o) => o.payload)).toEqual([{ count: 1, role: "reader" }]);
    expect(actor.state.name).toBe("couldNotLoadRequests");
  });

  test("viewerAcceptKeys picks invite asks in one album, in order", () => {
    const list = [
      request("f1", "a", true),
      request("f1", "b", false),
      request("f2", "c", true),
      request("f1", "d", true),
      { folderId: "f1", requesterKey: "e", requesterName: "e" } as unknown as JoinRequest,
    ];
    expect(viewerAcceptKeys(list, "f1")).toEqual(["a", "d"]);
  });

  test("viewerAcceptKeys skips asks whose name equals a saved friend's", () => {
    const list = [
      request("f1", "a", true),
      { ...request("f1", "b", true), clash: "Dad" },
      request("f1", "c", true),
    ];
    expect(viewerAcceptKeys(list, "f1")).toEqual(["a", "c"]);
  });
});

describe("requestsViewModel", () => {
  test("initial snapshot", () => {
    const { actor } = setup();
    expect(requestsViewModel(actor.snapshot())).toEqual({
      requests: [],
      state: "requestsNotLoaded",
      loading: false,
      responding: false,
      failedAnswer: null,
      settled: false,
      error: null,
      fatal: false,
    });
  });

  test("responding while an answer is in flight", async () => {
    const { actor } = setup({ respond: () => new Promise(() => {}) });
    actor.send(refresh());
    await actor.settled();
    actor.send(respond("f1", "k1", true));
    const vm = requestsViewModel(actor.snapshot());
    expect(vm.state).toBe("sendingAnswer");
    expect(vm.responding).toBe(true);
  });
});

describe("requestsViewModel loading", () => {
  test("loading while a reload is under way, so the buttons wait", async () => {
    const { actor } = setup({ requests: () => new Promise(() => {}) });
    actor.send(refresh());
    const vm = requestsViewModel(actor.snapshot());
    expect(vm.state).toBe("loadingRequests");
    expect(vm.loading).toBe(true);
    expect(vm.responding).toBe(false);
  });

  test("not loading once the requests are shown", async () => {
    const { actor } = setup();
    actor.send(refresh());
    await actor.settled();
    expect(requestsViewModel(actor.snapshot()).loading).toBe(false);
  });
});

describe("asks that arrive", () => {
  const at = (folderId: string, key: string, requestedAt: number) =>
    ({ ...request(folderId, key), requestedAt }) as JoinRequest;
  const maya = at("f1", "maya", 1);
  const ben = at("f1", "ben", 2);

  /** Loads each list in turn (one refresh each) and returns the keys announced per load. */
  const run = async (lists: (JoinRequest[] | Error)[]) => {
    let i = 0;
    const { actor } = setup({
      requests: async () => {
        const next = lists[i++];
        return next instanceof Error ? [next, null] : [null, { requests: next }];
      },
    });
    const arrived: string[][] = [];
    onOutput(actor, (e) => {
      if (e.type === "REQUESTS_ARRIVED")
        arrived.push(
          (e.payload as { requests: JoinRequest[] }).requests.map((r) => r.requesterKey),
        );
    });
    for (const list of lists) {
      actor.send(refresh());
      await actor.settled();
      if (list instanceof Error) actor.send(retry());
      await actor.settled();
    }
    return arrived;
  };

  test("asks already waiting at the first load are not announced", async () => {
    expect(await run([[maya]])).toEqual([]);
  });
  test("an ask on an empty list is announced", async () => {
    expect(await run([[], [maya]])).toEqual([["maya"]]);
  });
  test("only the new ask is announced", async () => {
    expect(await run([[maya], [maya, ben]])).toEqual([["ben"]]);
  });
  test("the same list again announces nothing", async () => {
    expect(await run([[maya], [maya]])).toEqual([]);
  });
  test("a re-ask with a later time is announced", async () => {
    expect(await run([[maya], [at("f1", "maya", 9)]])).toEqual([["maya"]]);
  });
  test("a failed first load, then a good one, is silent", async () => {
    expect(await run([new Error("offline"), [maya]])).toEqual([]);
  });
  test("a new ask that came during Accept all is announced, and the total still is", async () => {
    const lists = [[maya], [ben]];
    let i = 0;
    const { actor } = setup({
      requests: async () => [null, { requests: lists[Math.min(i++, 1)] }] as never,
    });
    const types: string[] = [];
    onOutput(actor, (e) => void types.push(e.type));
    actor.send(refresh());
    await actor.settled();
    actor.send(acceptAll("f1", ["maya"]));
    await actor.settled();
    expect(types).toContain("REQUESTS_ARRIVED");
    expect(types).toContain("ALL_ACCEPTED");
  });
});
