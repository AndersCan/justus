/**
 * Builds the JSON registry the multi-instance hub prints for Playwright
 * globalSetup (issue #18). globalSetup reads this registry to map each worker
 * index → its own instance URL / port / storage dir, so every browser tab is
 * backed by a distinct bare instance.
 *
 * Pure: it only shapes data from the allocation inputs. The orchestrator fills
 * the real per-instance storage dirs, boots the worklets on the assigned ports,
 * and brings up the local DHT — none of that network/process work lives here,
 * which keeps buildRegistry unit-testable (see hub.test.mjs).
 */

import { allocateInstancePorts } from "./ports.mjs";

/**
 * @param {object} opts
 * @param {number} opts.basePort     first instance port
 * @param {number} opts.count        number of instances (tabs)
 * @param {string} opts.storageRoot  parent dir for per-instance storage
 * @param {number} [opts.dhtPort]    DHT port (defaults to basePort - 1)
 * @param {object} [opts.dht]         extra DHT descriptor fields to merge
 * @returns {{ dht: object, instances: Array<{id:string,port:number,url:string,storageDir:string}> }}
 */
export function buildRegistry({ basePort, count, storageRoot, dhtPort, dht = {} }) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, got ${count}`);
  }
  if (typeof storageRoot !== "string" || storageRoot.length === 0) {
    throw new TypeError("storageRoot must be a non-empty string");
  }

  const dhtPortResolved = dhtPort ?? basePort - 1;
  // The DHT port is reserved so no instance ever collides with it.
  const instancePorts = allocateInstancePorts({
    basePort,
    count,
    claimed: new Set([dhtPortResolved]),
  });

  const instances = instancePorts.map((port, i) => ({
    id: `tab-${i + 1}`,
    port,
    url: `http://127.0.0.1:${port}`,
    storageDir: `${storageRoot}/instance-${i + 1}`,
  }));

  return {
    dht: {
      port: dhtPortResolved,
      bootstrap: `http://127.0.0.1:${dhtPortResolved}`,
      ...dht,
    },
    instances,
  };
}
