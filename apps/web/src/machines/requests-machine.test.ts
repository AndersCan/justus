import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import type { JoinRequest } from "@justus/core";
import { createRequestsActor, requestsViewModel } from "./requests-machine";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
}));

const request = (folderId: string, requesterKey: string) =>
  ({ folderId, requesterKey, requesterName: requesterKey }) as unknown as JoinRequest;

const refresh = () => ({ type: "REFRESH" }) as never;
const retry = () => ({ type: "RETRY" }) as never;
const respond = (folderId: string, requesterKey: string, approve: boolean) =>
  ({ type: "RESPOND", payload: { folderId, requesterKey, approve } }) as never;

function setup(
  options: {
    requests?: () => Promise<[unknown, unknown]>;
    respond?: () => Promise<[unknown, unknown]>;
  } = {},
) {
  const port = {
    requests: vi.fn(
      options.requests ??
        (async () => [null, { requests: [request("f1", "k1"), request("f1", "k2")] }] as never),
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
    expect(port.respond).toHaveBeenCalledWith("f1", "k1", approve);
    expect(actor.state.name).toBe("showingRequests");
    expect(actor.snapshot().context.requests.map((r) => r.requesterKey)).toEqual(["k2"]);
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
});

describe("requestsViewModel", () => {
  test("initial snapshot", () => {
    const { actor } = setup();
    expect(requestsViewModel(actor.snapshot())).toEqual({
      requests: [],
      state: "requestsNotLoaded",
      responding: false,
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
