// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { presenceStrip } from "./gallery";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const status = (otherConnected: boolean) =>
  ({
    folder: { id: "f1" },
    members: [
      { key: "k0", name: "Me", connected: true },
      { key: "k1", name: "Ada", admin: true, connected: otherConnected },
    ],
  }) as never;

const draw = (s: never, connectingTo: string | undefined) => {
  const host = document.createElement("div");
  render(presenceStrip(s, null, connectingTo, { now: Date.now() }), host);
  const label = host.querySelector("span.inline-flex");
  return { text: label?.textContent?.replace(/\s+/g, " ").trim(), html: label?.innerHTML ?? "" };
};

describe("presenceStrip", () => {
  test("while connecting it says who, with a still dot", () => {
    const { text, html } = draw(status(false), "Ada");
    expect(text).toBe("Connecting to Ada…");
    expect(html).not.toContain("animate-pulse");
  });

  test("after the wait it says nobody is connected, with a pulsing dot", () => {
    const { text, html } = draw(status(false), undefined);
    expect(text).toBe("Nobody connected right now");
    expect(html).toContain("animate-pulse");
  });

  test("someone connected wins over connecting", () => {
    const { text, html } = draw(status(true), "Ada");
    expect(text).toBe("1 connected now");
    expect(html).toContain("bg-ok");
  });

  test("alone wins over connecting", () => {
    const alone = { folder: { id: "f1" }, members: [{ key: "k0", name: "Me", connected: true }] };
    expect(draw(alone as never, "Ada").text).toBe("Only you so far");
  });

  test("a friend lost 10 s ago still counts as connected; at 30 s he does not", () => {
    const now = 1_000_000;
    const lostAt = (ago: number) =>
      ({
        folder: { id: "f1" },
        members: [
          { key: "k0", name: "Me", connected: true },
          { key: "k1", name: "Ada", admin: true, connected: false, lastSeenAt: now - ago },
        ],
      }) as never;
    const at = (s: never) => {
      const host = document.createElement("div");
      render(presenceStrip(s, null, undefined, { now }), host);
      return host.querySelector("span.inline-flex")?.textContent?.replace(/\s+/g, " ").trim();
    };
    expect(at(lostAt(10_000))).toBe("1 connected now");
    expect(at(lostAt(30_000))).toBe("Nobody connected right now");
  });
});
