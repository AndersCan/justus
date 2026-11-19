// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { VirtualClock } from "@mantaq/core";
import { presenceStrip } from "./gallery";
import { connectionGivenUp, reachMachine } from "../machines/reach-hint-machine";
import { PRESENCE_TICK_MS } from "../utils/presence";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

test("after Ben's link drops, the strip goes from connected to Nobody connected without Connecting to Ben… (photo-wait.spec 'Ada sees Ben's link drop')", async () => {
  const clock = VirtualClock();
  const reach = reachMachine.create({ clock });
  const t0 = clock.now();
  // Ben's link closed at t0: backend stamps lastSeenAt = close time.
  const status = {
    folder: { id: "f1" },
    members: [
      { key: "k0", name: "Ada", connected: true },
      { key: "k1", name: "Ben", admin: false, connected: false, lastSeenAt: t0 },
    ],
  };
  reach.send({ type: "UNREACHABLE", payload: { name: "Ben" } } as never);
  const seen: string[] = [];
  for (let s = 0; s <= 120; s++) {
    await reach.settled();
    // presence clock: set on the drop, then moves every 15 s
    const now = t0 + Math.floor((s * 1000) / PRESENCE_TICK_MS) * PRESENCE_TICK_MS;
    const host = document.createElement("div");
    const connectingTo = connectionGivenUp(reach.snapshot()) ? undefined : "Ben";
    render(presenceStrip(status as never, null, connectingTo, { now }), host);
    const text = host.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (seen.at(-1)?.split(" @")[0] !== text.slice(0, 30)) seen.push(`${text.slice(0, 30)} @${s}s`);
    clock.advance(1000);
  }
  const line = seen.join(" | ");
  expect(line).not.toContain("Connecting to Ben");
  expect(line).toContain("Nobody connected right now");
});
