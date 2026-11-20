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
    expect(report).toEqual({
      outside: [],
      adaStream: 1,
      dhtNodes: 1,
      adaAddresses: ["10.1.0.4:41234"],
    });
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
  it("names a connect on a socket that is neither TCP nor UDP as a network connection", () => {
    const trace = `${sample}\n${connect("93.184.216.34", 443).replace("<TCP:", "<RAW:")}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK opened a network connection to 93.184.216.34:443",
    ]);
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

const toAda =
  '123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(41234), sin_addr=inet_addr("10.1.0.4")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1}, 0) = 3';

describe("apkAddressReport non-DHT packets and batches", () => {
  it("a UDP-connected socket to Google DNS passes only while nothing is sent on it", () => {
    const trace = [
      toAda,
      '123 1.7 connect(11<UDPv6:[1]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) = 0',
      '123 1.8 sendto(11<UDPv6:[1]>, "\\xc3\\x00\\x00\\x00\\x01", 1200, 0, NULL, 0) = 1200',
    ].join("\n");
    const report = apkAddressReport({ trace, ada });
    expect(report.outside).not.toEqual([]);
  });
  it("names a stream packet to an outside address batched in one sendmmsg after one to Ada", () => {
    const trace =
      '123 1.9 sendmmsg(7<UDP:[0.0.0.0:5]>, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(41234), sin_addr=inet_addr("10.1.0.4")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=3}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("203.0.113.7")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=3}], 2, 0) = 2';
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 203.0.113.7:9, which is not Ada's phone",
    ]);
  });
  it("does not blame a DHT node for a stream packet to Ada batched after it", () => {
    const trace =
      '123 1.9 sendmmsg(7<UDP:[0.0.0.0:5]>, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(49737), sin_addr=inet_addr("198.18.0.9")}, msg_namelen=16, msg_iov=[{iov_base="\\x03\\x00", iov_len=2}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=2}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(41234), sin_addr=inet_addr("10.1.0.4")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=3}], 2, 0) = 2';
    expect(apkAddressReport({ trace, ada }).outside).toEqual([]);
  });
});

describe("apkAddressReport address forms and batches", () => {
  const tcp6 = (host) =>
    `123 1.6 connect(9<TCPv6:[1]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "${host}", &sin6_addr), sin6_scope_id=0}, 28) = -1 EINPROGRESS`;
  it("prints a real IPv6 address as [H]:P and a mapped one as a.b.c.d:P", () => {
    const trace = [toAda, tcp6("2001:4860:4840::1"), tcp6("::ffff:93.184.216.34")].join("\n");
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK opened a TCP connection to 93.184.216.34:443",
      "Ben's APK opened a TCP connection to [2001:4860:4840::1]:443",
    ]);
  });
  it("names a stream packet to Ada's host on another port", () => {
    const trace = `${toAda}\n${toAda.replace("htons(41234)", "htons(5555)")}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 10.1.0.4:5555, which is not Ada's phone",
    ]);
  });
  it("fails a stream line whose address cannot be read", () => {
    const cut = "123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_po";
    const trace = `${toAda}\n${cut}..., msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}]}, 0) = 3`;
    expect(apkAddressReport({ trace, ada }).outside[0]).toMatch(/^Could not read this line/);
  });
});

describe("apkAddressReport packets that stay with Ada or on the phone", () => {
  const batch = (host, port, bytes) =>
    `123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, msg_namelen=16, msg_iov=[{iov_base="${bytes}", iov_len=3}], msg_iovlen=1}, 0) = 3`;
  it("passes any packet to Ada's address and any packet to loopback", () => {
    const trace = [
      batch("10.1.0.4", 41234, "\\xff\\x01\\x00"),
      batch("10.1.0.4", 41234, "\\xc3\\x00"),
      batch("127.0.0.1", 9, "\\xc3\\x00"),
      batch("127.0.0.1", 9, "\\xff\\x01\\x00"),
    ].join("\n");
    expect(apkAddressReport({ trace, ada }).outside).toEqual([]);
  });
  it("names a packet that is not a DHT message to an outside address", () => {
    const trace = [
      batch("10.1.0.4", 41234, "\\xff\\x01\\x00"),
      batch("203.0.113.7", 9, "\\xc3\\x00"),
    ];
    expect(apkAddressReport({ trace: trace.join("\n"), ada }).outside).toEqual([
      "Ben's APK sent a packet that is not a DHT message to 203.0.113.7:9",
    ]);
  });
});
