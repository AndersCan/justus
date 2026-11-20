import { EventEmitter } from "node:events";
import createTestnet from "hyperdht/testnet";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHyperPeerNetwork } from "../src/adapters/hyper-peer-network.ts";
import { watchStalls } from "../src/adapters/stall-watch.ts";
import { createP2pLog } from "../src/p2p-log.ts";
import type { P2pEvent } from "../src/p2p-log.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("watchStalls", () => {
  it("stays quiet while ticks arrive on time", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watch = watchStalls(Date.now, onStall);
    vi.advanceTimersByTime(30_000);
    watch.stop();
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires once when the clock jumps past the stall limit", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watch = watchStalls(Date.now, onStall);
    vi.advanceTimersByTime(1000);
    vi.setSystemTime(Date.now() + 20_000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(3000);
    watch.stop();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("does not fire after stop", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    watchStalls(Date.now, onStall).stop();
    vi.setSystemTime(Date.now() + 20_000);
    vi.advanceTimersByTime(5000);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe("the peer network after a frozen process", () => {
  it("tells the swarm its network changed so it re-announces to fresh relays", async () => {
    const testnet = await createTestnet(3);
    const events: P2pEvent[] = [];
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const emit = vi.spyOn(EventEmitter.prototype, "emit");
    const network = createHyperPeerNetwork({
      bootstrap: testnet.bootstrap,
      replicate: () => {},
      log: createP2pLog((e) => events.push(e)),
    });
    try {
      vi.setSystemTime(Date.now() + 20_000);
      vi.advanceTimersByTime(1000);
      expect(events.some((e) => e.event === "stall.resumed")).toBe(true);
      expect(emit.mock.calls.some(([name]) => name === "network-change")).toBe(true);
    } finally {
      emit.mockRestore();
      vi.useRealTimers();
      await network.close();
      await testnet.destroy();
    }
  });
});
