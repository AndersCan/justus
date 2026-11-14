// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { albumHeader, presenceStrip } from "./gallery";
import { CONNECTING_FOR_MS } from "../utils/reach-hint";
import { reachActor } from "../machines/reach-hint-machine";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const album = { id: "f1", name: "Trip", role: "member", members: 2 };
const status = {
  folder: { id: "f1" },
  members: [
    { key: "k0", name: "Me", connected: true },
    { key: "k1", name: "Ada", admin: true, connected: false },
  ],
};

afterEach(() => reachActor.send({ type: "REACHED", payload: {} } as never));

describe("album header presence while connecting", () => {
  test("albumHeader reads the reach actor: Connecting to Ada…", () => {
    reachActor.send({ type: "UNREACHABLE", payload: { name: "Ada" } } as never);
    const host = document.createElement("div");
    const page = { status, folders: [album], requests: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    expect(host.textContent?.replace(/\s+/g, " ")).toContain("Connecting to Ada…");
  });

  test("before any reach event the first frame still says Connecting, never Nobody", () => {
    const host = document.createElement("div");
    const page = { status, folders: [album], requests: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    const text = host.textContent?.replace(/\s+/g, " ");
    expect(text).toContain("Connecting to Ada…");
    expect(text).not.toContain("Nobody connected");
  });

  test("after the first wait the header says Nobody connected", () => {
    vi.useFakeTimers();
    reachActor.send({ type: "UNREACHABLE", payload: { name: "Ada" } } as never);
    vi.advanceTimersByTime(CONNECTING_FOR_MS + 1);
    const host = document.createElement("div");
    const page = { status, folders: [album], requests: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    vi.useRealTimers();
    expect(host.textContent?.replace(/\s+/g, " ")).toContain("Nobody connected right now");
  });

  test("the connecting dot is the neutral dot, not the amber one", () => {
    const host = document.createElement("div");
    render(presenceStrip(status as never, null, "Ada"), host);
    const dot = host.querySelector("span.inline-flex > span")!;
    expect(dot.className).toContain("bg-surface");
    expect(dot.className).not.toContain("bg-warn");
  });
});
