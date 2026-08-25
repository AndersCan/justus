import { describe, it, expect } from "vite-plus/test";
import { allocateInstancePorts } from "./ports.mjs";
import { buildRegistry } from "./registry.mjs";

describe("allocateInstancePorts", () => {
  it("returns count consecutive ports starting at basePort", () => {
    expect(allocateInstancePorts({ basePort: 9000, count: 3 })).toEqual([9000, 9001, 9002]);
  });

  it("skips claimed ports and keeps going", () => {
    expect(allocateInstancePorts({ basePort: 9000, count: 3, claimed: new Set([9001]) })).toEqual([
      9000, 9002, 9003,
    ]);
  });

  it("accepts a claimed array, not just a Set", () => {
    expect(
      allocateInstancePorts({ basePort: 9000, count: 4, claimed: [9000, 9002, 9004] }),
    ).toEqual([9001, 9003, 9005, 9006]);
  });

  it("never returns a claimed port", () => {
    const claimed = new Set([9000, 9002, 9004, 9005]);
    const ports = allocateInstancePorts({ basePort: 9000, count: 4, claimed });
    expect(ports.every((p) => !claimed.has(p))).toBe(true);
  });

  it("rejects a non-positive count", () => {
    expect(() => allocateInstancePorts({ basePort: 9000, count: 0 })).toThrow(RangeError);
  });

  it("rejects an out-of-range basePort", () => {
    expect(() => allocateInstancePorts({ basePort: 70000, count: 1 })).toThrow(RangeError);
  });

  it("throws a RangeError when the ring overflows 65535", () => {
    expect(() => allocateInstancePorts({ basePort: 65534, count: 5 })).toThrow(RangeError);
  });
});

describe("buildRegistry", () => {
  it("emits one instance per tab with url/port/storageDir + a dht descriptor", () => {
    const reg = buildRegistry({
      basePort: 9100,
      count: 2,
      storageRoot: "/tmp/hub",
      dhtPort: 9099,
    });

    expect(reg.instances).toHaveLength(2);
    expect(reg.instances[0]).toEqual({
      id: "tab-1",
      port: 9100,
      url: "http://127.0.0.1:9100",
      storageDir: "/tmp/hub/instance-1",
    });
    expect(reg.dht).toMatchObject({
      port: 9099,
      bootstrap: "http://127.0.0.1:9099",
    });
  });

  it("keeps instance ports clear of the dht port (shifts up on collision)", () => {
    const reg = buildRegistry({
      basePort: 9100,
      count: 3,
      storageRoot: "/tmp/hub",
      dhtPort: 9100, // collides with basePort
    });
    expect(reg.dht.port).toBe(9100);
    expect(reg.instances.map((i) => i.port)).toEqual([9101, 9102, 9103]);
  });

  it("rejects a non-positive instance count", () => {
    expect(() => buildRegistry({ basePort: 9100, count: 0, storageRoot: "/tmp/hub" })).toThrow(
      RangeError,
    );
  });

  it("rejects an empty storageRoot", () => {
    expect(() => buildRegistry({ basePort: 9100, count: 1, storageRoot: "" })).toThrow(TypeError);
  });
});
