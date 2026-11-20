const STREAM = /^"\\xff\\x01/;
const DHT = /^"(?:\\x03|\\x13)|^"\\x00"/;
const PAYLOAD = /iov_base="((?:[^"\\]|\\.)*)"|^[^(]*\([^,]*, "((?:[^"\\]|\\.)*)"/;
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

function payload(message) {
  const m = PAYLOAD.exec(message);
  return m ? `"${m[1] ?? m[2]}"` : "";
}

function messages(call, line) {
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
  const connected = new Map();
  let adaStream = 0;
  for (const line of trace.split("\n")) {
    const call = /^\d+\s+[\d.]+\s+(\w+)\(/.exec(line)?.[1];
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
    for (const message of messages(call, line)) {
      const to = destination(message) ?? connected.get(fd);
      const bytes = payload(message);
      const toAda = to !== undefined && ada.hosts.has(to.host) && ada.ports.has(to.port);
      if (STREAM.test(bytes)) {
        if (!to) {
          outside.add(`Could not read this line of the record: ${line.slice(0, 100)}`);
        } else if (toAda) {
          adaStream += 1;
          adaAddresses.add(show(to));
        } else if (!isLoopback(to.host)) {
          outside.add(`Ben's APK sent stream packets to ${show(to)}, which is not Ada's phone`);
        }
      } else if (to && !isLoopback(to.host) && !toAda) {
        if (DHT.test(bytes)) nodes.add(show(to));
        else outside.add(`Ben's APK sent a packet that is not a DHT message to ${show(to)}`);
      }
    }
  }
  if (adaStream === 0) {
    outside.add(
      "Ben's APK sent no stream packet to Ada's phone: the record missed the photo's path",
    );
  }
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    outside: [...outside].sort(byText),
    adaStream,
    dhtNodes: nodes.size,
    adaAddresses: [...adaAddresses].sort(byText),
  };
}
