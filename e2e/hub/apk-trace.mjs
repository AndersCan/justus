const STREAM = /iov_base="\\xff\\x01|, "\\xff\\x01/;
const V4 = /sin_port=htons\((\d+)\), sin_addr=inet_addr\("([\d.]+)"\)/;
const V6 = /sin6_port=htons\((\d+)\), .*?inet_pton\(AF_INET6, "([^"]+)"/;

function destination(line) {
  const v4 = V4.exec(line);
  if (v4) return { host: v4[2], port: Number(v4[1]) };
  const v6 = V6.exec(line);
  if (!v6) return undefined;
  const mapped = v6[2].replace(/^::ffff:/, "");
  return { host: mapped, port: Number(v6[1]), v6: mapped === v6[2] };
}

function show(to) {
  return to.v6 ? `[${to.host}]:${to.port}` : `${to.host}:${to.port}`;
}

function isLoopback(host) {
  return host.startsWith("127.") || host === "::1";
}

/**
 * Reads an strace record of Ben's app (recordApkNetwork) and names every address it should not have used.
 * Allowed: Ada's phone (host in `ada.hosts`, port in `ada.ports`), DHT messages to any node, loopback.
 * Not allowed: a stream packet to anyone but Ada's phone, and a connect to any non-loopback address.
 * @param {{ trace: string, ada: { hosts: Set<string>, ports: Set<number> } }} input
 * @returns {{ outside: string[], adaStream: number, dhtNodes: number }}
 *   `outside`: one sentence each, sorted, no duplicates; empty means the record is clean.
 */
export function apkAddressReport({ trace, ada }) {
  if (trace.trim() === "") return { outside: ["The record is empty"], adaStream: 0, dhtNodes: 0 };
  const outside = new Set();
  const nodes = new Set();
  const connected = new Map();
  let adaStream = 0;
  for (const line of trace.split("\n")) {
    const call = /^(?:\[pid\s+\d+\]\s+)?\d+\s+[\d.]+\s+(\w+)\(/.exec(line)?.[1];
    const fd = /\((\d+)</.exec(line)?.[1];
    if (call === "connect") {
      const to = destination(line);
      if (!to || isLoopback(to.host)) continue;
      if (/<UDP/.test(line)) {
        connected.set(fd, to);
        continue;
      }
      const kind = /<TCP/.test(line) ? "TCP" : "network";
      outside.add(`Ben's APK opened a ${kind} connection to ${show(to)}`);
      continue;
    }
    if (call !== "sendto" && call !== "sendmsg" && call !== "sendmmsg") continue;
    const to = destination(line) ?? connected.get(fd);
    if (STREAM.test(line)) {
      if (!to) {
        outside.add(`Could not read this line of the record: ${line.slice(0, 100)}`);
      } else if (ada.hosts.has(to.host) && ada.ports.has(to.port)) {
        adaStream += 1;
      } else if (!isLoopback(to.host)) {
        outside.add(`Ben's APK sent stream packets to ${show(to)}, which is not Ada's phone`);
      }
    } else if (to && !isLoopback(to.host)) {
      nodes.add(show(to));
    }
  }
  if (adaStream === 0) {
    outside.add(
      "Ben's APK sent no stream packet to Ada's phone: the record missed the photo's path",
    );
  }
  return { outside: [...outside].sort(), adaStream, dhtNodes: nodes.size };
}
