import { describe, expect, test } from "vite-plus/test";
import { createP2pLog, formatP2pEvent, short } from "./p2p-log";

describe("p2p-log", () => {
  test("short cuts keys to 8 hex chars", () => {
    expect(short("abcdef0123456789")).toBe("abcdef01");
    expect(short(Buffer.from("abcdef0123456789", "hex"))).toBe("abcdef01");
    expect(short(undefined)).toBeUndefined();
  });

  test("formats one greppable line, skipping undefined and quoting spaces", () => {
    expect(
      formatP2pEvent({
        event: "conn.open",
        fields: { conn: 3, noise: "ab12cd34", gone: undefined, err: "bad thing" },
      }),
    ).toBe('[p2p] conn.open conn=3 noise=ab12cd34 err="bad thing"');
  });

  test("a throwing sink never breaks the caller", () => {
    const log = createP2pLog(() => {
      throw new Error("sink");
    });
    expect(() => log("x")).not.toThrow();
  });
});
