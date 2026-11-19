import { addressReport } from "./addresses.mjs";
import { describe, it, expect } from "vite-plus/test";

const here = new Set(["127.0.0.1", "10.1.0.5"]);

function report(ada, ben = { "0.0.0.0:6001": 150 }) {
  return addressReport({
    since: 100,
    here,
    phones: [
      { name: "Ada", log: { bound: { "0.0.0.0:5001": 150 }, sent: {}, streams: {}, ...ada } },
      { name: "Ben", log: { bound: ben, sent: {}, streams: {} } },
    ],
  });
}

describe("addressReport", () => {
  it("returns nothing for lookup nodes, its own interface and another phone's port", () => {
    expect(
      report({
        sent: { "127.0.0.1:4001": 200, "10.1.0.5:5001": 200 },
        streams: { "127.0.0.1:6001": 200 },
      }),
    ).toEqual([]);
  });

  it("returns a line for a packet sent to an outside host", () => {
    expect(report({ sent: { "93.184.216.34:443": 200 } })).toEqual([
      "Ada's phone sent packets to 93.184.216.34:443, outside the test network",
    ]);
  });

  it("returns a line for a connection to a port no other phone bound", () => {
    expect(report({ streams: { "127.0.0.1:7777": 200 } })).toEqual([
      "Ada's phone connected to 127.0.0.1:7777, which is no phone in the test network",
    ]);
  });

  it("returns a line for a connection to an outside host, even on a phone's port", () => {
    expect(report({ streams: { "203.0.113.7:6001": 200 } })).toEqual([
      "Ada's phone connected to 203.0.113.7:6001, which is no phone in the test network",
    ]);
  });

  it("returns a line for a connection to its own port", () => {
    expect(report({ streams: { "127.0.0.1:5001": 200 } })).toHaveLength(1);
  });

  it("returns nothing for entries last used before since", () => {
    expect(
      report({ streams: { "127.0.0.1:7777": 50 }, sent: { "93.184.216.34:443": 50 } }),
    ).toEqual([]);
  });

  it("returns a line for a phone that noted no sockets", () => {
    expect(report({}, {})).toEqual([
      "Ben's phone noted no sockets: the address log is not running",
    ]);
  });
});
