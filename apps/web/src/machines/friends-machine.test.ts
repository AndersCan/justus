import { describe, expect, test, vi } from "vite-plus/test";
import { VirtualClock } from "@mantaq/core";
import { SAVE_FAILED_COPY, createFriendsActor, type FriendsPort } from "./friends-machine";

vi.mock("../gateway", () => ({ gateway: { friends: { list: vi.fn(), add: vi.fn() } } }));

type Reply = () => Promise<[unknown, unknown]>;

const open = (identity = "k1", ownName = "Kim") =>
  ({ type: "OPEN", payload: { target: { identity, ownName } } }) as never;
const add = () => ({ type: "ADD" }) as never;
const type = (text: string) => ({ type: "TYPE", payload: { text } }) as never;
const save = () => ({ type: "SAVE" }) as never;
const close = () => ({ type: "CLOSE" }) as never;

async function setup(options: { list?: Reply; add?: Reply } = {}) {
  const port = {
    list: vi.fn(options.list ?? (async () => [null, []])),
    add: vi.fn(
      options.add ??
        (async (identity: string, name: string) => [null, { identity, name }] as [null, unknown]),
    ),
  };
  const actor = createFriendsActor({ clock: VirtualClock(), port: port as unknown as FriendsPort });
  const outputs: unknown[] = [];
  actor.on("output", { fn: (e: unknown) => outputs.push(e) } as never);
  await actor.settled();
  return { actor, port, outputs };
}

describe("friends machine", () => {
  test("loads the friends on start", async () => {
    const { actor, port } = await setup({
      list: async () => [null, [{ identity: "k9", name: "Sam" }]],
    });
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(actor.state.name).toBe("closed");
    expect(actor.snapshot().context.friends).toEqual({ k9: "Sam" });
  });

  test("a failed load leaves the sheet closed with no friends and no error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { actor } = await setup({ list: async () => [new Error("disk"), null] });
    expect(actor.state.name).toBe("closed");
    expect(actor.snapshot().context.friends).toEqual({});
    expect(actor.snapshot().context.error).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("OPEN is ignored while loading", () => {
    const port = { list: vi.fn(() => new Promise(() => {})), add: vi.fn() };
    const actor = createFriendsActor({
      clock: VirtualClock(),
      port: port as unknown as FriendsPort,
    });
    actor.send(open());
    expect(actor.state.name).toBe("loading");
  });

  test("the full add path stores the name and says so", async () => {
    const { actor, port, outputs } = await setup();
    actor.send(open());
    expect(actor.state.name).toBe("viewing");
    actor.send(add());
    expect(actor.state.name).toBe("naming");
    expect(actor.snapshot().payload).toEqual({
      identity: "k1",
      ownName: "Kim",
      draft: "Kim",
    });
    actor.send(type("  Kimmy  "));
    actor.send(save());
    expect(actor.state.name).toBe("saving");
    await actor.settled();
    expect(port.add).toHaveBeenCalledWith("k1", "Kimmy");
    expect(actor.state.name).toBe("closed");
    expect(actor.snapshot().context.friends).toEqual({ k1: "Kimmy" });
    expect(outputs).toEqual([
      expect.objectContaining({ type: "FRIEND_SAVED", payload: { name: "Kimmy" } }),
    ]);
  });

  test("typing cuts the draft to 40 characters", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(add());
    actor.send(type("x".repeat(60)));
    expect((actor.snapshot().payload as { draft: string }).draft).toBe("x".repeat(40));
  });

  test("SAVE with a blank draft is ignored", async () => {
    const { actor, port } = await setup();
    actor.send(open());
    actor.send(add());
    actor.send(type("   "));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("naming");
    expect(port.add).not.toHaveBeenCalled();
  });

  test("ADD on an existing friend does nothing", async () => {
    const { actor } = await setup({
      list: async () => [null, [{ identity: "k1", name: "Kimmy" }]],
    });
    actor.send(open());
    actor.send(add());
    expect(actor.state.name).toBe("viewing");
  });

  test("a failed save returns to naming with the draft and the error", async () => {
    const { actor, outputs } = await setup({ add: async () => [new Error("full"), null] });
    actor.send(open());
    actor.send(add());
    actor.send(type("Kimmy"));
    actor.send(save());
    await actor.settled();
    expect(actor.state.name).toBe("naming");
    expect((actor.snapshot().payload as { draft: string }).draft).toBe("Kimmy");
    expect(actor.snapshot().context.error).toBe(SAVE_FAILED_COPY);
    expect(outputs).toEqual([]);
    actor.send(type("Kimmy2"));
    expect(actor.snapshot().context.error).toBeNull();
  });

  test("CLOSE from viewing and naming closes the sheet and clears the error", async () => {
    const { actor } = await setup();
    actor.send(open());
    actor.send(close());
    expect(actor.state.name).toBe("closed");
    actor.send(open());
    actor.send(add());
    actor.send(close());
    expect(actor.state.name).toBe("closed");
  });
});
