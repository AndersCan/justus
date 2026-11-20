import { apkAddressReport } from "./apk-trace.mjs";
import { describe, expect, it } from "vite-plus/test";

const ada = { hosts: new Set(["10.1.0.4"]), ports: new Set([41234]) };

const send = (host, port, bytes) =>
  `123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, msg_namelen=16, msg_iov=[{iov_base="${bytes}", iov_len=3}], msg_iovlen=1}, 0) = 3`;
const connect = (host, port) =>
  `123 1.6 connect(9<TCP:[1]>, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, 16) = 0`;

const sample = [
  '123 1.1 bind(7<UDP:[0.0.0.0:0]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("0.0.0.0")}, 16) = 0',
  send("198.18.0.9", 49737, "\\x03\\x00"),
  send("10.1.0.4", 41234, "\\xff\\x01\\x00"),
  connect("127.0.0.1", 8080),
].join("\n");

describe("apkAddressReport", () => {
  it("passes a record that sends streams to Ada and DHT messages to nodes", () => {
    const report = apkAddressReport({ trace: sample, ada });
    expect(report).toEqual({ outside: [], adaStream: 1, dhtNodes: 1 });
  });
  it("names a stream packet to an address that is not Ada's phone", () => {
    const trace = `${sample}\n${send("203.0.113.7", 9, "\\xff\\x01\\x00")}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 203.0.113.7:9, which is not Ada's phone",
    ]);
  });
  it("names a stream packet to Ada's port on another host", () => {
    const trace = `${sample}\n${send("203.0.113.7", 41234, "\\xff\\x01\\x00")}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 203.0.113.7:41234, which is not Ada's phone",
    ]);
  });
  it("names a connection to a non-loopback address", () => {
    const trace = `${sample}\n${connect("93.184.216.34", 443)}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK opened a TCP connection to 93.184.216.34:443",
    ]);
  });
  it("passes a UDP connect nothing is sent on, and judges a later send by the connected address", () => {
    const udp = (host, port) =>
      `123 1.7 connect(11<UDP:[1]>, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, 16) = 0`;
    const bare = (fd) => `123 1.8 sendto(${fd}<UDP:[1]>, "\\xff\\x01\\x00", 3, 0, NULL, 0) = 3`;
    expect(apkAddressReport({ trace: `${sample}\n${udp("203.0.113.7", 9)}`, ada }).outside).toEqual(
      [],
    );
    expect(
      apkAddressReport({ trace: `${sample}\n${udp("203.0.113.7", 9)}\n${bare(11)}`, ada }).outside,
    ).toEqual(["Ben's APK sent stream packets to 203.0.113.7:9, which is not Ada's phone"]);
  });
  it("fails an empty record", () => {
    expect(apkAddressReport({ trace: "", ada }).outside).toEqual(["The record is empty"]);
  });
  it("fails a record with no stream packet to Ada", () => {
    const trace = send("198.18.0.9", 49737, "\\x03\\x00");
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent no stream packet to Ada's phone: the record missed the photo's path",
    ]);
  });
});
