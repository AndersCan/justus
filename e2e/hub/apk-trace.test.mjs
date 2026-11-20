import { apkAddressReport } from "./apk-trace.mjs";
import { describe, expect, it } from "vite-plus/test";

const ada = { hosts: new Set(["10.1.0.4"]), ports: new Set([41234]) };

function send({ host, port, bytes }) {
  return `123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, msg_namelen=16, msg_iov=[{iov_base="${bytes}", iov_len=3}], msg_iovlen=1}, 0) = 3`;
}
function connect({ host, port }) {
  return `123 1.6 connect(9<TCP:[1]>, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, 16) = 0`;
}

const sample = [
  '123 1.1 bind(7<UDP:[0.0.0.0:0]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("0.0.0.0")}, 16) = 0',
  send({ host: "198.18.0.9", port: 49737, bytes: "\\x03\\x00" }),
  send({ host: "10.1.0.4", port: 41234, bytes: "\\xff\\x01\\x00" }),
  connect({ host: "127.0.0.1", port: 8080 }),
].join("\n");

describe("apkAddressReport", () => {
  it("returns no outside address for streams to Ada and DHT messages to nodes", () => {
    const report = apkAddressReport({ trace: sample, ada });
    expect(report).toEqual({
      outside: [],
      adaStream: 1,
      dhtNodes: 1,
      adaAddresses: ["10.1.0.4:41234"],
    });
  });
  it("returns a sentence for a stream packet to an address that is not Ada's phone", () => {
    const trace = `${sample}\n${send({ host: "203.0.113.7", port: 9, bytes: "\\xff\\x01\\x00" })}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 203.0.113.7:9, which is not Ada's phone",
    ]);
  });
  it("returns a sentence for a stream packet to Ada's port on another host", () => {
    const trace = `${sample}\n${send({ host: "203.0.113.7", port: 41234, bytes: "\\xff\\x01\\x00" })}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 203.0.113.7:41234, which is not Ada's phone",
    ]);
  });
  it("returns a sentence for a connection to a non-loopback address", () => {
    const trace = `${sample}\n${connect({ host: "93.184.216.34", port: 443 })}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK opened a TCP connection to 93.184.216.34:443",
    ]);
  });
  it("returns no sentence for a UDP connect, even when a later socket reuses its fd number", () => {
    const googleConnect =
      '123 1.7 connect(40<UDPv6:[1]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) = 0';
    const reused =
      '123 1.8 sendmsg(40<UDP:[10.1.0.2:5000->10.1.0.4:41234]>, {msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1}, 0) = 3';
    expect(apkAddressReport({ trace: `${googleConnect}\n${reused}`, ada })).toEqual({
      outside: [],
      adaStream: 1,
      dhtNodes: 0,
      adaAddresses: ["10.1.0.4:41234"],
    });
  });
  it("returns a mapped IPv4 peer of a connected socket as Ada's address", () => {
    const line =
      '123 1.8 sendto(11<UDPv6:[[::1]:5->[::ffff:10.1.0.4]:41234]>, "\\xff\\x01\\x00", 3, 0, NULL, 0) = 3';
    expect(apkAddressReport({ trace: line, ada }).adaAddresses).toEqual(["10.1.0.4:41234"]);
  });
  it("returns a DHT node, not a sentence, for a connected sendmmsg to a node", () => {
    const line =
      '123 1.9 sendmmsg(11<UDP:[10.1.0.2:5->198.18.0.9:49737]>, [{msg_hdr={msg_iov=[{iov_base="\\x03\\x00", iov_len=2}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=2}], 1, 0) = 1';
    expect(apkAddressReport({ trace: `${toAda}\n${line}`, ada })).toMatchObject({
      outside: [],
      dhtNodes: 1,
    });
  });
  it("returns no sentence for a send on a unix socket that passes a UDP fd to Google DNS", () => {
    const line =
      '123 1.8 sendmsg(235<\\x73\\x6f\\x63>, {msg_name=NULL, msg_namelen=0, msg_iov=[{iov_base="\\x06\\x00", iov_len=2}], msg_iovlen=1, msg_control=[{cmsg_len=20, cmsg_level=SOL_SOCKET, cmsg_type=SCM_RIGHTS, cmsg_data=[234<UDPv6:[[fec0::d964:5263:9f8b:f5b9]:48913->[2001:4860:4860::8888]:443]>]}], msg_controllen=24, msg_flags=0}, 0) = 52';
    expect(apkAddressReport({ trace: `${toAda}\n${line}`, ada }).outside).toEqual([]);
  });
  it("returns a sentence for an address-less stream send on a socket connected elsewhere", () => {
    const line =
      '123 1.8 sendto(11<UDPv6:[[::1]:5->[2001:4860:4860::8888]:443]>, "\\xff\\x01\\x00", 3, 0, NULL, 0) = 3';
    expect(apkAddressReport({ trace: `${toAda}\n${line}`, ada }).outside).toEqual([
      "Ben's APK sent stream packets to [2001:4860:4860::8888]:443, which is not Ada's phone",
    ]);
  });
  it("returns a could-not-read sentence for an address-less stream send on an unconnected socket", () => {
    const line = '123 1.8 sendto(11<UDP:[10.1.0.2:5000]>, "\\xff\\x01\\x00", 3, 0, NULL, 0) = 3';
    expect(apkAddressReport({ trace: `${toAda}\n${line}`, ada }).outside[0]).toMatch(
      /^Could not read this line/,
    );
  });
  it("returns a network-connection sentence for a connect on a socket that is neither TCP nor UDP", () => {
    const trace = `${sample}\n${connect({ host: "93.184.216.34", port: 443 }).replace("<TCP:", "<RAW:")}`;
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK opened a network connection to 93.184.216.34:443",
    ]);
  });
  it("fails an empty record", () => {
    expect(apkAddressReport({ trace: "", ada }).outside).toEqual(["The record is empty"]);
  });
  it("fails a record with no stream packet to Ada", () => {
    const trace = send({ host: "198.18.0.9", port: 49737, bytes: "\\x03\\x00" });
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent no stream packet to Ada's phone: the record missed the photo's path",
    ]);
  });
});

const toAda =
  '123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(41234), sin_addr=inet_addr("10.1.0.4")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1}, 0) = 3';

describe("apkAddressReport non-DHT packets and batches", () => {
  it("returns a sentence for a stream packet to an outside address batched in one sendmmsg after one to Ada", () => {
    const trace =
      '123 1.9 sendmmsg(7<UDP:[0.0.0.0:5]>, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(41234), sin_addr=inet_addr("10.1.0.4")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=3}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr("203.0.113.7")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=3}], 2, 0) = 2';
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK sent stream packets to 203.0.113.7:9, which is not Ada's phone",
    ]);
  });
  it("returns no sentence for a stream packet to Ada batched after a DHT message", () => {
    const trace =
      '123 1.9 sendmmsg(7<UDP:[0.0.0.0:5]>, [{msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(49737), sin_addr=inet_addr("198.18.0.9")}, msg_namelen=16, msg_iov=[{iov_base="\\x03\\x00", iov_len=2}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=2}, {msg_hdr={msg_name={sa_family=AF_INET, sin_port=htons(41234), sin_addr=inet_addr("10.1.0.4")}, msg_namelen=16, msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}], msg_iovlen=1, msg_controllen=0, msg_flags=0}, msg_len=3}], 2, 0) = 2';
    expect(apkAddressReport({ trace, ada }).outside).toEqual([]);
  });
});

describe("apkAddressReport address forms and batches", () => {
  function tcp6(host) {
    return `123 1.6 connect(9<TCPv6:[1]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, "${host}", &sin6_addr), sin6_scope_id=0}, 28) = -1 EINPROGRESS`;
  }
  it("returns a real IPv6 address as [H]:P and a mapped one as a.b.c.d:P", () => {
    const trace = [toAda, tcp6("2001:4860:4840::1"), tcp6("::ffff:93.184.216.34")].join("\n");
    expect(apkAddressReport({ trace, ada }).outside).toEqual([
      "Ben's APK opened a TCP connection to 93.184.216.34:443",
      "Ben's APK opened a TCP connection to [2001:4860:4840::1]:443",
    ]);
  });
  it("returns a sentence for a stream packet to Ada's host on another port", () => {
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
  function batch({ host, port, bytes }) {
    return `123 1.5 sendmsg(7<UDP:[0.0.0.0:5]>, {msg_name={sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${host}")}, msg_namelen=16, msg_iov=[{iov_base="${bytes}", iov_len=3}], msg_iovlen=1}, 0) = 3`;
  }
  it("returns no sentence for any packet to Ada's address or to loopback", () => {
    const trace = [
      batch({ host: "10.1.0.4", port: 41234, bytes: "\\xff\\x01\\x00" }),
      batch({ host: "10.1.0.4", port: 41234, bytes: "\\xc3\\x00" }),
      batch({ host: "127.0.0.1", port: 9, bytes: "\\xc3\\x00" }),
      batch({ host: "127.0.0.1", port: 9, bytes: "\\xff\\x01\\x00" }),
    ].join("\n");
    expect(apkAddressReport({ trace, ada }).outside).toEqual([]);
  });
  it("returns a sentence for a packet that is not a DHT message to an outside address", () => {
    const trace = [
      batch({ host: "10.1.0.4", port: 41234, bytes: "\\xff\\x01\\x00" }),
      batch({ host: "203.0.113.7", port: 9, bytes: "\\xc3\\x00" }),
    ];
    expect(apkAddressReport({ trace: trace.join("\n"), ada }).outside).toEqual([
      "Ben's APK sent a packet that is not a DHT message to 203.0.113.7:9",
    ]);
  });
  it("returns Ada's addresses and the outside sentences in sorted order", () => {
    const second = { ...ada, hosts: new Set(["10.1.0.4", "10.1.0.3"]) };
    const trace = [
      send({ host: "10.1.0.4", port: 41234, bytes: "\\xff\\x01\\x00" }),
      send({ host: "10.1.0.3", port: 41234, bytes: "\\xff\\x01\\x00" }),
      send({ host: "203.0.113.9", port: 9, bytes: "\\xff\\x01\\x00" }),
      send({ host: "203.0.113.7", port: 9, bytes: "\\xff\\x01\\x00" }),
    ].join("\n");
    expect(apkAddressReport({ trace, ada: second })).toEqual({
      outside: [
        "Ben's APK sent stream packets to 203.0.113.7:9, which is not Ada's phone",
        "Ben's APK sent stream packets to 203.0.113.9:9, which is not Ada's phone",
      ],
      adaStream: 2,
      dhtNodes: 0,
      adaAddresses: ["10.1.0.3:41234", "10.1.0.4:41234"],
    });
  });
});
