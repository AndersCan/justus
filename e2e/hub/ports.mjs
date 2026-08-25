/**
 * Deterministic port-ring allocation for the justus multi-instance e2e hub
 * (issue #18 — "each browser tab is its own bare instance").
 *
 * This module is the pure, network-free core of the orchestrator: it decides
 * which TCP ports the N worklet instances (and the local DHT) should bind,
 * guaranteeing no two instances collide and no instance lands on a port that
 * is already claimed (e.g. the DHT port, or a port a foreign process holds).
 *
 * The orchestrator is responsible for the live "is this port actually free
 * right now?" probe (reusing apps/backend/scripts/port-utils.mjs) before it
 * spawns each worklet. Keeping the *allocation* pure means it is unit-testable
 * without opening a single socket — see hub.test.mjs.
 */

const MAX_PORT = 65535;

/**
 * @param {object} opts
 * @param {number} opts.basePort  first port to consider for instance 1
 * @param {number} opts.count     how many instance ports to allocate
 * @param {Set<number>|number[]} [opts.claimed] ports that must be skipped
 * @returns {number[]} `count` strictly-ascending, collision-free ports
 */
export function allocateInstancePorts({ basePort, count, claimed = new Set() }) {
  if (!Number.isInteger(basePort) || basePort < 1 || basePort > MAX_PORT) {
    throw new RangeError(`basePort must be a TCP port (1-${MAX_PORT}), got ${basePort}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, got ${count}`);
  }
  const claimedSet = claimed instanceof Set ? claimed : new Set(claimed);

  const ports = [];
  let next = basePort;
  while (ports.length < count) {
    if (next > MAX_PORT) {
      throw new RangeError(
        `Ran out of ports allocating ${count} instances from base ${basePort} ` +
          `(claimed: ${[...claimedSet].join(", ") || "none"}).`,
      );
    }
    if (!claimedSet.has(next)) ports.push(next);
    next++;
  }

  // Guard rails: the loop above is simple, but never hand back a duplicate or
  // a port we were told to avoid.
  if (new Set(ports).size !== ports.length) {
    throw new Error("internal: port ring produced duplicate ports");
  }
  for (const p of ports) {
    if (claimedSet.has(p)) throw new Error(`internal: allocated a claimed port (${p})`);
  }
  return ports;
}
