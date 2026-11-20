const STREAM = /^"\\xff\\x01/;
const DHT = /^"(?:\\x03|\\x13)|^"\\x00"/;
const PAYLOAD = /iov_base="((?:[^"\\]|\\.)*)"|^[^(]*\([^,]*, "((?:[^"\\]|\\.)*)"/;
const IPV4 = /sin_port=htons\((\d+)\), sin_addr=inet_addr\("([\d.]+)"\)/;
const IPV6 = /sin6_port=htons\((\d+)\), .*?inet_pton\(AF_INET6, "([^"]+)"/;

function destination(line) {
  const ipv4 = IPV4.exec(line);
  if (ipv4) return { host: ipv4[2], port: Number(ipv4[1]) };
  const ipv6 = IPV6.exec(line);
  if (!ipv6) return undefined;
  const mapped = ipv6[2].replace(/^::ffff:/, "");
  return { host: mapped, port: Number(ipv6[1]), v6: mapped === ipv6[2] };
}

const PEER = /^\d+\s+[\d.]+\s+\w+\(\d+<UDP(?:v6)?:\[[^>]*->\[?([^\]>]+?)\]?:(\d+)\]>/;

function peerOfSocket(line) {
  const peer = PEER.exec(line);
  if (!peer) return undefined;
  const mapped = peer[1].replace(/^::ffff:/, "");
  return { host: mapped, port: Number(peer[2]), v6: mapped.includes(":") };
}

function show(target) {
  return target.v6 ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
}

function isLoopback(host) {
  return host.startsWith("127.") || host === "::1";
}

function payload(message) {
  const found = PAYLOAD.exec(message);
  return found ? `"${found[1] ?? found[2]}"` : "";
}

function messages({ call, line }) {
  if (call !== "sendmmsg") return [line];
  return line.split("msg_hdr=").slice(1);
}

/**
 * Reads an strace record of Ben's app (recordApkNetwork) and names every address it should not have used.
 * Allowed: Ada's phone (host in `ada.hosts`, port in `ada.ports`), DHT messages to any node, loopback.
 * Not allowed: a stream packet to anyone but Ada's phone, any other packet to an address that is not Ada's,
 * and a connect to any non-loopback address.
 * @param {{ trace: string, ada: { hosts: Set<string>, ports: Set<number> } }} input
 * @returns {{ outside: string[], adaStream: number, dhtNodes: number, adaAddresses: string[] }}
 *   `outside`: one sentence each, sorted, no duplicates; empty means the record is clean.
 */
export function apkAddressReport({ trace, ada }) {
  if (trace.trim() === "") {
    return { outside: ["The record is empty"], adaStream: 0, dhtNodes: 0, adaAddresses: [] };
  }
  const outside = new Set();
  const nodes = new Set();
  const adaAddresses = new Set();
  let adaStream = 0;
  for (const line of trace.split("\n")) {
    const call = /^\d+\s+[\d.]+\s+(\w+)\(/.exec(line)?.[1];
    if (call === "connect") {
      const target = destination(line);
      if (!target || isLoopback(target.host)) continue;
      if (/<UDP/.test(line)) continue;
      const kind = /<TCP/.test(line) ? "TCP" : "network";
      outside.add(`Ben's APK opened a ${kind} connection to ${show(target)}`);
      continue;
    }
    if (call !== "sendto" && call !== "sendmsg" && call !== "sendmmsg") continue;
    for (const message of messages({ call, line })) {
      const target = destination(message) ?? peerOfSocket(line);
      const bytes = payload(message);
      const toAda =
        target !== undefined && ada.hosts.has(target.host) && ada.ports.has(target.port);
      if (STREAM.test(bytes)) {
        if (!target) {
          outside.add(`Could not read this line of the record: ${line.slice(0, 100)}`);
          continue;
        }
        if (toAda) {
          adaStream += 1;
          adaAddresses.add(show(target));
          continue;
        }
        if (!isLoopback(target.host)) {
          outside.add(`Ben's APK sent stream packets to ${show(target)}, which is not Ada's phone`);
        }
        continue;
      }
      if (!target || isLoopback(target.host) || toAda) continue;
      if (DHT.test(bytes)) nodes.add(show(target));
      else outside.add(`Ben's APK sent a packet that is not a DHT message to ${show(target)}`);
    }
  }
  if (adaStream === 0) {
    outside.add(
      "Ben's APK sent no stream packet to Ada's phone: the record missed the photo's path",
    );
  }
  return {
    outside: [...outside].sort(),
    adaStream,
    dhtNodes: nodes.size,
    adaAddresses: [...adaAddresses].sort(),
  };
}
