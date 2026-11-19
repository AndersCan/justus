import { traceFacts } from "../device/apk-network.mjs";
import { describe, expect, it } from "vite-plus/test";

const trace = [
  '123 1.1 bind(7<UDP:[0.0.0.0:0]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr("0.0.0.0")}, 16) = 0',
  '123 1.2 sendto(7<UDP:[1]>, "\\x03\\x00", 2, 0, {sa_family=AF_INET}, 16) = 2',
  '123 1.3 sendmsg(7<UDP:[1]>, {msg_iov=[{iov_base="\\x13\\x00", iov_len=2}]}, 0) = 2',
  '123 1.4 sendmsg(7<UDP:[1]>, {msg_iov=[{iov_base="\\xff\\x01\\x00", iov_len=3}]}, 0) = 3',
].join("\n");

describe("traceFacts", () => {
  it("returns the counts of binds, DHT messages and stream packets", () => {
    expect(traceFacts(trace)).toEqual({ lines: 4, binds: 1, streamPackets: 1, dhtMessages: 2 });
  });
  it("returns zero counts for an empty record", () => {
    expect(traceFacts("")).toEqual({ lines: 0, binds: 0, streamPackets: 0, dhtMessages: 0 });
  });
});
