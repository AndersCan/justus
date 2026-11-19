/**
 * Splits the addresses the test phones used into what the test network allows and what it does not.
 * @param {{ phones: Array<{ name: string, log: { bound: Record<string, number>, sent: Record<string, number>, streams: Record<string, number> } }>, here: Set<string>, since: number }} input
 *   `log.bound` should be the union of two reads, the second taken after every other read: a phone binds a port before anyone connects to it.
 *   `here`: this machine's addresses (loopback and every interface address).
 *   `since`: only entries last used at or after it count (phones restarted by earlier specs leave old ports in other phones' logs).
 * @returns {string[]} one sentence per address outside the test network
 */
export function addressReport({ phones, here, since }) {
  const outside = [];
  for (const { name, log } of phones) {
    if (Object.keys(log.bound).length === 0) {
      outside.push(`${name}'s phone noted no sockets: the address log is not running`);
    }
    for (const [addr, last] of Object.entries(log.sent)) {
      if (last < since) continue;
      const host = hostOf(addr);
      if (!here.has(host) && !host.startsWith("127.")) {
        outside.push(`${name}'s phone sent packets to ${addr}, outside the test network`);
      }
    }
    for (const [addr, last] of Object.entries(log.streams)) {
      if (last < since) continue;
      const owned = phones.some(
        (other) => other.name !== name && boundBy({ bound: other.log.bound, addr, here }),
      );
      if (!owned) {
        outside.push(`${name}'s phone connected to ${addr}, which is no phone in the test network`);
      }
    }
  }
  return outside;
}

function hostOf(addr) {
  return addr.slice(0, addr.lastIndexOf(":"));
}

function portOf(addr) {
  return addr.slice(addr.lastIndexOf(":") + 1);
}

/** True when `addr` is a port another phone bound, on this machine. */
function boundBy({ bound, addr, here }) {
  const host = hostOf(addr);
  if (!here.has(host) && !host.startsWith("127.")) return false;
  return Object.keys(bound).some((b) => portOf(b) === portOf(addr));
}
