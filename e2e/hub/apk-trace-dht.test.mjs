import { apkAddressReport } from "./apk-trace.mjs";
import { describe, expect, it } from "vite-plus/test";

const ada = { hosts: new Set(["10.1.0.4"]), ports: new Set([41234]) };
function send({ host, port, bytes }) {
  return `123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, msg_namelen=16, msg_iov=[{iov_base="${bytes}", iov_len=3}], msg_iovlen=1}, 0) = 3`;
}
const toAda = send({ host: "10.1.0.4", port: 41234, bytes: "\\xff\\x01\\x00" });

describe("apkAddressReport DHT messages", () => {
  it("returns a DHT response and a one-byte probe as DHT nodes", () => {
    const trace = [
      toAda,
      send({ host: "198.18.0.9", port: 49737, bytes: "\\x13\\x00" }),
      send({ host: "10.0.2.15", port: 5, bytes: "\\x00" }),
    ];
    expect(apkAddressReport({ trace: trace.join("\n"), ada })).toMatchObject({
      outside: [],
      dhtNodes: 2,
    });
  });
  it("returns a sentence for a packet that starts with a zero byte but is longer than the probe", () => {
    const trace = [toAda, send({ host: "203.0.113.7", port: 9, bytes: "\\x00\\x01\\x02" })];
    expect(apkAddressReport({ trace: trace.join("\n"), ada }).outside).toEqual([
      "Ben's APK sent a packet that is not a DHT message to 203.0.113.7:9",
    ]);
  });
});
