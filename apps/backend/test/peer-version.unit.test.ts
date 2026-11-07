import c from "compact-encoding";
import Protomux from "protomux";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { VERSION_PROTOCOL, openVersion } from "../src/adapters/peer-version.ts";

function pair(): [Duplex, Duplex] {
  const make = (peer: () => Duplex) =>
    new Duplex({
      write(chunk, _enc, cb) {
        peer().push(chunk);
        cb();
      },
      read() {},
    });
  const a: Duplex = make(() => b);
  const b: Duplex = make(() => a);
  return [a, b];
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe("openVersion", () => {
  it("routes versions 1..1000 to onVersion and 0, 1001, huge to onIgnored", async () => {
    const [a, b] = pair();
    const seen: number[] = [];
    const ignored: number[] = [];
    openVersion(
      a,
      1,
      (v) => seen.push(v),
      (v) => ignored.push(v),
    );

    const raw = Protomux.from(b);
    const channel = raw.createChannel({ protocol: VERSION_PROTOCOL, unique: true })!;
    const msg = channel.addMessage({ encoding: c.uint });
    channel.open();
    await tick();
    for (const n of [1000, 1001, 0, 1, 5, 2 ** 40]) msg.send(n);
    await tick();

    expect(seen).toEqual([1000, 1, 5]);
    expect(ignored).toEqual([1001, 0, 2 ** 40]);
  });

  it("second openVersion on the same connection is a no-op", () => {
    const [a] = pair();
    openVersion(a, 1, () => {});
    expect(() => openVersion(a, 1, () => {})).not.toThrow();
  });
});
