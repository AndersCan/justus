import { describe, it, expect } from "vite-plus/test";
import { planHub, bootOrder, buildCleanupPlan } from "./plan.mjs";
import { buildRegistry } from "./registry.mjs";

describe("planHub", () => {
  it("boots one DHT plus N worklets, DHT first, in collision-free ports", () => {
    const { registry, boot } = planHub({
      basePort: 9100,
      count: 2,
      storageRoot: "/tmp/hub",
      dht: { port: 9099 },
    });

    expect(boot).toHaveLength(3); // 1 dht + 2 worklets
    expect(boot[0]).toMatchObject({ id: "dht", type: "dht", port: 9099 });
    expect(boot.slice(1).map((s) => s.id)).toEqual(["tab-1", "tab-2"]);
    // every boot port matches the registry; no two steps share a port
    const ports = boot.map((s) => s.port);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).toEqual([registry.dht.port, ...registry.instances.map((i) => i.port)]);
  });

  it("maps each worklet to its own storage dir + the DHT bootstrap", () => {
    const { boot } = planHub({
      basePort: 9100,
      count: 2,
      storageRoot: "/tmp/hub",
    });
    const worklets = boot.filter((s) => s.type === "worklet");
    expect(worklets[0]).toMatchObject({
      id: "tab-1",
      port: 9100,
      url: "http://127.0.0.1:9100",
      storageDir: "/tmp/hub/instance-1",
      bootstrap: "http://127.0.0.1:9099",
      dependsOn: ["dht"],
    });
    expect(worklets[1].storageDir).toBe("/tmp/hub/instance-2");
  });

  it("avoids ports a live probe reported busy (claimed)", () => {
    const claimed = new Set([9100, 9101]); // simulate foreign processes
    const { boot } = planHub({
      basePort: 9100,
      count: 2,
      storageRoot: "/tmp/hub",
      dht: { port: 9099 },
      claimed,
    });
    for (const step of boot) {
      expect(claimed.has(step.port)).toBe(false);
    }
  });

  it("treats the DHT port as reserved even without an explicit claimed set", () => {
    // basePort === dhtPort would collide; the plan must shift the instances up.
    const { boot } = planHub({
      basePort: 9100,
      count: 2,
      storageRoot: "/tmp/hub",
      dht: { port: 9100 },
    });
    const ports = boot.map((s) => s.port);
    expect(ports).toEqual([9100, 9101, 9102]); // dht=9100, worklets 9101/9102
    expect(boot[0].id).toBe("dht");
  });
});

describe("bootOrder", () => {
  it("returns DHT-first ids and validates dependency ordering", () => {
    const { boot } = planHub({
      basePort: 9100,
      count: 3,
      storageRoot: "/tmp/hub",
    });
    expect(bootOrder({ boot })).toEqual(["dht", "tab-1", "tab-2", "tab-3"]);
  });

  it("throws if a step depends on a later-booted step", () => {
    expect(() =>
      bootOrder({
        boot: [
          { id: "tab-1", type: "worklet", port: 9100, dependsOn: ["dht"] },
          { id: "dht", type: "dht", port: 9099, dependsOn: [] },
        ],
      }),
    ).toThrow(/boot order violation/);
  });
});

describe("buildCleanupPlan", () => {
  it("tears down in reverse boot order, listing all ports + worklet storage", () => {
    const { boot } = planHub({
      basePort: 9100,
      count: 2,
      storageRoot: "/tmp/hub",
      dht: { port: 9099 },
    });
    const cleanup = buildCleanupPlan({ boot });
    expect(cleanup.order).toEqual(["tab-2", "tab-1", "dht"]); // reverse
    expect(cleanup.ports).toEqual([9099, 9100, 9101]);
    expect(cleanup.storageDirs).toEqual(["/tmp/hub/instance-1", "/tmp/hub/instance-2"]);
  });
});

describe("buildRegistry claimed option", () => {
  it("skips extra claimed ports beyond the DHT port", () => {
    const reg = buildRegistry({
      basePort: 9100,
      count: 3,
      storageRoot: "/tmp/hub",
      dhtPort: 9099,
      claimed: [9101], // a port a probe found busy
    });
    const ports = reg.instances.map((i) => i.port);
    expect(ports).toEqual([9100, 9102, 9103]); // 9101 skipped
    expect(ports).not.toContain(9099); // dht reserved
  });
});
