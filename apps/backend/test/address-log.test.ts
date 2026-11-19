import { expect, it } from "vite-plus/test";
import { emptyAddressLog, watchAddresses } from "../src/adapters/address-log.ts";

function stubUdx(opts: { throwOnSend?: boolean; throwOnBind?: boolean } = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    createSocket() {
      return {
        bind(...args: unknown[]) {
          calls.push(["bind", ...args]);
          if (opts.throwOnBind) throw new Error("bind failed");
          return "bound";
        },
        address: () => ({ host: "0.0.0.0", port: 5001 }),
        send(...args: unknown[]) {
          calls.push(["send", ...args]);
          if (opts.throwOnSend) throw new Error("send failed");
          return "sent";
        },
        trySend(...args: unknown[]) {
          calls.push(["trySend", ...args]);
          if (opts.throwOnSend) throw new Error("send failed");
          return "tried";
        },
      };
    },
    createStream(id: number) {
      return {
        connect(...args: unknown[]) {
          calls.push(["connect", ...args]);
          return "connected";
        },
        changeRemote(...args: unknown[]) {
          calls.push(["changeRemote", ...args]);
          return "changed";
        },
        id,
      };
    },
  };
}

it("notes the address a socket is bound to, and passes the call through", () => {
  const udx = stubUdx();
  const log = emptyAddressLog();
  const socket = watchAddresses(udx, log).createSocket();
  expect(socket.bind(5001, "0.0.0.0")).toBe("bound");
  expect(Object.keys(log.bound)).toEqual(["0.0.0.0:5001"]);
  expect(udx.calls).toEqual([["bind", 5001, "0.0.0.0"]]);
});

it("notes nothing when bind throws", () => {
  const log = emptyAddressLog();
  const socket = watchAddresses(stubUdx({ throwOnBind: true }), log).createSocket();
  expect(() => socket.bind(5001, "0.0.0.0")).toThrow("bind failed");
  expect(log.bound).toEqual({});
});

it("notes the destination of send and trySend, even when the send throws", () => {
  const udx = stubUdx();
  const log = emptyAddressLog();
  const socket = watchAddresses(udx, log).createSocket();
  const buf = Buffer.from("x");
  expect(socket.send(buf, 443, "1.2.3.4", 64)).toBe("sent");
  expect(socket.trySend(buf, 444, "5.6.7.8", 64)).toBe("tried");
  expect(Object.keys(log.sent).sort()).toEqual(["1.2.3.4:443", "5.6.7.8:444"]);
  expect(udx.calls[0]).toEqual(["send", buf, 443, "1.2.3.4", 64]);

  const failing = emptyAddressLog();
  const bad = watchAddresses(stubUdx({ throwOnSend: true }), failing).createSocket();
  expect(() => bad.send(buf, 443, "1.2.3.4")).toThrow("send failed");
  expect(() => bad.trySend(buf, 444, "5.6.7.8")).toThrow("send failed");
  expect(Object.keys(failing.sent).sort()).toEqual(["1.2.3.4:443", "5.6.7.8:444"]);
});

it("notes the far end of a stream on connect and changeRemote", () => {
  const udx = stubUdx();
  const log = emptyAddressLog();
  const stream = watchAddresses(udx, log).createStream(7);
  expect(stream.id).toBe(7);
  expect(stream.connect("sock", 1, 9000, "10.0.0.1")).toBe("connected");
  expect(stream.changeRemote("sock", 1, 9001, "10.0.0.2")).toBe("changed");
  expect(Object.keys(log.streams).sort()).toEqual(["10.0.0.1:9000", "10.0.0.2:9001"]);
  expect(udx.calls).toEqual([
    ["connect", "sock", 1, 9000, "10.0.0.1"],
    ["changeRemote", "sock", 1, 9001, "10.0.0.2"],
  ]);
});
