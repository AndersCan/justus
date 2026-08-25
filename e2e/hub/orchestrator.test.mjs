import { describe, it, expect } from "vite-plus/test";
import { parseArgs, buildOrchestratorPlan, DEFAULTS, REPO_ROOT } from "./orchestrator.mjs";

describe("parseArgs", () => {
  it("applies defaults", () => {
    const o = parseArgs([]);
    expect(o.count).toBe(2);
    expect(o.basePort).toBe(9000);
    expect(o.dhtPort).toBe(49737);
    expect(o.plan).toBeFalsy();
  });

  it("reads --count / --base-port / --dht-port / --plan", () => {
    const o = parseArgs(["--count", "3", "--base-port", "9100", "--dht-port", "51000", "--plan"]);
    expect(o.count).toBe(3);
    expect(o.basePort).toBe(9100);
    expect(o.dhtPort).toBe(51000);
    expect(o.plan).toBe(true);
  });

  it("accepts --dry-run as an alias for --plan", () => {
    expect(parseArgs(["--dry-run"]).plan).toBe(true);
  });

  it("throws on a non-positive count", () => {
    expect(() => parseArgs(["--count", "0"])).toThrow(RangeError);
  });

  it("throws on an out-of-range port", () => {
    expect(() => parseArgs(["--base-port", "70000"])).toThrow(RangeError);
  });

  it("throws on an unknown argument", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("buildOrchestratorPlan", () => {
  it("produces count worklets, each with its own port + storage", () => {
    const plan = buildOrchestratorPlan({ count: 3 });
    expect(plan.registry.instances).toHaveLength(3);
    expect(plan.plan.worklets).toHaveLength(3);

    const ports = plan.plan.worklets.map((w) => w.port);
    expect(new Set(ports).size).toBe(3); // no collisions

    for (const w of plan.plan.worklets) {
      expect(w.args).toContain(`port=${w.port}`);
      expect(w.args).toContain(`storage=${w.storageDir}`);
      expect(w.args).toContain(`bootstrap=${plan.registry.dht.bootstrap}`);
      expect(w.args[0]).toMatch(/apps\/backend\/dist\/main\.core\.gen\.js$/);
      expect(w.runtime).toBe("bare");
    }
  });

  it("points every worklet + the DHT at the same local bootstrap", () => {
    const plan = buildOrchestratorPlan({ dhtPort: 51000 });
    expect(plan.registry.dht.bootstrap).toBe("http://127.0.0.1:51000");
    expect(plan.plan.dht.bootstrap).toBe(plan.registry.dht.bootstrap);
    for (const w of plan.plan.worklets) {
      expect(w.bootstrap).toBe(plan.registry.dht.bootstrap);
    }
  });

  it("builds a DHT spawn spec from the local-dht script", () => {
    const plan = buildOrchestratorPlan({ dhtPort: 51000 });
    expect(plan.plan.dht.command).toBe("node");
    expect(plan.plan.dht.args[0]).toMatch(/apps\/backend\/scripts\/local-dht\.mjs$/);
    expect(plan.plan.dht.args[1]).toBe("51000");
    expect(plan.plan.dht.runtime).toBe("node");
  });

  it("never lands an instance on the DHT port", () => {
    const plan = buildOrchestratorPlan({ basePort: 9000, dhtPort: 8999 });
    for (const w of plan.plan.worklets) {
      expect(w.port).not.toBe(8999);
    }
  });

  it("derives caches/inboxes per instance under storage", () => {
    const plan = buildOrchestratorPlan({ count: 2 });
    for (const w of plan.plan.worklets) {
      expect(w.args).toContain(`cache=${w.storageDir}/cache`);
      expect(w.args).toContain(`inbox=${w.storageDir}/inbox`);
    }
  });

  it("cleanup order is the reverse of the boot order", () => {
    const plan = buildOrchestratorPlan({ count: 3 });
    const bootIds = plan.boot.map((s) => s.id);
    expect(plan.cleanup.order).toEqual([...bootIds].reverse());
    // The DHT is always last to die.
    expect(plan.cleanup.order[plan.cleanup.order.length - 1]).toBe("dht");
  });

  it("resolves repo-relative paths from REPO_ROOT", () => {
    expect(REPO_ROOT.endsWith("justus")).toBe(true);
    const plan = buildOrchestratorPlan();
    expect(plan.plan.dht.args[0].startsWith(REPO_ROOT)).toBe(true);
  });

  it("DEFAULTS.storageRoot lives under the repo", () => {
    expect(DEFAULTS.storageRoot).toMatch(/\.dev-e2e-hub$/);
  });
});
