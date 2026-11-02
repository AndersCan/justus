import { createFakeHub, createFakePeerNetwork } from "./fakes/fake-world.ts";
import { describe, expect, it } from "vite-plus/test";

const topic = "ab".repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 20));

function started(hub: ReturnType<typeof createFakeHub>) {
  const network = createFakePeerNetwork({ hub });
  const events: string[] = [];
  network.start("cd".repeat(32), (e) => events.push(e.type));
  return { network, events };
}

describe("fake peer network matching", () => {
  it("does not connect two client-only networks", async () => {
    const hub = createFakeHub();
    const a = started(hub);
    const b = started(hub);
    a.network.join(topic, { server: false });
    b.network.join(topic, { server: false });
    await settle();
    expect(a.events).toEqual([]);
    expect(b.network.connectionCount()).toBe(0);
  });

  it("stops matching a topic after leave", async () => {
    const hub = createFakeHub();
    const a = started(hub);
    const b = started(hub);
    a.network.join(topic, { server: true });
    a.network.leave(topic);
    b.network.join(topic, { server: false });
    await settle();
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([]);
  });
});
