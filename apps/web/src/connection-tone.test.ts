import { describe, expect, test } from "vite-plus/test";
import { connectionLabel, connectionTone } from "./connection-tone";

describe("connectionTone", () => {
  test("no peers, not fatal -> amber (direct but alone)", () => {
    expect(connectionTone(0, false)).toBe("amber");
  });

  test("one or more peers -> green", () => {
    expect(connectionTone(1, false)).toBe("green");
    expect(connectionTone(5, false)).toBe("green");
  });

  test("fatal overrides the peer count -> red", () => {
    expect(connectionTone(3, true)).toBe("red");
    expect(connectionTone(0, true)).toBe("red");
  });
});

describe("connectionLabel", () => {
  test("singular peer count", () => {
    expect(connectionLabel(1, false)).toBe("direct · 1 peer");
  });

  test("plural peer count", () => {
    expect(connectionLabel(2, false)).toBe("direct · 2 peers");
  });

  test("no peers yet", () => {
    expect(connectionLabel(0, false)).toBe("direct · no peers yet");
  });

  test("fatal -> sync stopped", () => {
    expect(connectionLabel(4, true)).toBe("sync stopped");
  });
});
