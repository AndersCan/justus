/**
 * Pure orchestrator planning for the justus multi-instance e2e hub
 * (issue #18 — "each browser tab is its own bare instance").
 *
 * This is the deterministic, network-free *decision* layer the orchestrator
 * (`scripts/e2e-hub.mjs`) consumes. It decides WHAT to boot and in WHAT ORDER,
 * and WHAT to tear down on SIGTERM — without opening a socket or spawning a
 * single process. Keeping the planning pure means it is unit-testable without
 * a DHT, without browsers, and without peers (see plan.test.mjs).
 *
 * The orchestrator is responsible for the live work: probing which ports are
 * already busy, spawning the DHT + N worklets on the planned ports/storage,
 * waiting for the DHT boot-ready signal, and applying `buildCleanupPlan` on
 * SIGTERM. None of that process/network work lives here.
 */

import { buildRegistry } from "./registry.mjs";

/**
 * Plan the full hub: one DHT process plus N worklet instances, each with its
 * own collision-free port + storage dir, all pointed at the DHT bootstrap.
 *
 * @param {object} opts
 * @param {number} opts.basePort     first instance port
 * @param {number} opts.count        number of worklet instances (tabs)
 * @param {string} opts.storageRoot  parent dir for per-instance storage
 * @param {object} [opts.dht]        extra DHT descriptor fields to merge
 * @param {Set<number>|number[]} [opts.claimed]  ports observed busy by live
 *        probes; the plan avoids them so a foreign process never collides.
 * @returns {{ registry: object, boot: Array<object> }}
 *          `boot` is ordered: the DHT first, then the instances (each
 *          `dependsOn: ["dht"]`).
 */
export function planHub({ basePort, count, storageRoot, dht = {}, claimed }) {
  const registry = buildRegistry({
    basePort,
    count,
    storageRoot,
    dhtPort: dht.port,
    dht,
    claimed,
  });

  const boot = [
    {
      id: "dht",
      type: "dht",
      port: registry.dht.port,
      bootstrap: registry.dht.bootstrap,
      dependsOn: [],
    },
    ...registry.instances.map((inst) => ({
      id: inst.id,
      type: "worklet",
      port: inst.port,
      url: inst.url,
      storageDir: inst.storageDir,
      bootstrap: registry.dht.bootstrap,
      dependsOn: ["dht"],
    })),
  ];

  return { registry, boot };
}

/**
 * Validate and return the boot order as a list of step ids. Throws if a step
 * depends on another step that boots later — the contract the orchestrator
 * relies on (DHT must be up before any worklet points at it).
 *
 * @param {{ boot: Array<{id:string, dependsOn:string[]}> }} plan
 * @returns {string[]} ordered step ids
 */
export function bootOrder(plan) {
  const seen = new Set();
  for (const step of plan.boot) {
    for (const dep of step.dependsOn) {
      if (!seen.has(dep)) {
        throw new Error(`boot order violation: ${step.id} depends on ${dep}, which boots later`);
      }
    }
    seen.add(step.id);
  }
  return plan.boot.map((s) => s.id);
}

/**
 * Deterministic teardown plan for SIGTERM: shut the steps down in reverse boot
 * order (instances first, then the DHT) so no orphaned process survives.
 * `ports` / `storageDirs` let the orchestrator release resources even if a
 * spawned child already exited.
 *
 * @param {{ boot: Array<{id:string,type:string,port:number,storageDir?:string}> }} plan
 * @returns {{ order: string[], ports: number[], storageDirs: string[] }}
 */
export function buildCleanupPlan(plan) {
  const shutdown = [...plan.boot].reverse();
  return {
    order: shutdown.map((s) => s.id),
    ports: plan.boot.map((s) => s.port),
    storageDirs: plan.boot.filter((s) => s.type === "worklet").map((s) => s.storageDir),
  };
}
