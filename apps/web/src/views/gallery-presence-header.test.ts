// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { albumHeader, presenceStrip } from "./gallery";
import { CONNECTING_FOR_MS, REACH_HINT_AFTER_MS } from "../utils/reach-hint";
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
    const page = { status, folders: [album], requests: [], photos: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    expect(host.textContent?.replace(/\s+/g, " ")).toContain("Connecting to Ada…");
  });

  test("before any reach event the first frame still says Connecting, never Nobody", () => {
    const host = document.createElement("div");
    const page = { status, folders: [album], requests: [], photos: [], lastSync: Date.now() };
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
    const page = { status, folders: [album], requests: [], photos: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    vi.useRealTimers();
    expect(host.textContent?.replace(/\s+/g, " ")).toContain("Nobody connected right now");
  });

  test("the connecting dot is the neutral dot, not the amber one", () => {
    const host = document.createElement("div");
    render(presenceStrip(status as never, null, "Ada", { now: Date.now() }), host);
    const dot = host.querySelector("span.inline-flex > span")!;
    expect(dot.className).toContain("bg-surface");
    expect(dot.className).not.toContain("bg-warn");
  });

  const textFor = (name: string) => {
    const host = document.createElement("div");
    const st = {
      folder: { id: "f1" },
      members: [
        { key: "k0", name: "Me", connected: true },
        { key: "k1", name, admin: true, connected: false },
      ],
    };
    const page = { status: st, folders: [album], requests: [], photos: [], lastSync: Date.now() };
    render(albumHeader(page as never, album as never), host);
    return host.textContent?.replace(/\s+/g, " ") ?? "";
  };

  test("the name comes from the album's members, not a fixed one", () => {
    expect(textFor("Maya")).toContain("Connecting to Maya…");
  });

  test("an unknown or empty name says Connecting…, never Nobody and never 'to …'", () => {
    for (const name of ["Unknown device", ""]) {
      const text = textFor(name);
      expect(text).toContain("Connecting…");
      expect(text).not.toContain("Nobody connected");
      expect(text).not.toMatch(/Connecting to/);
    }
  });

  test("once the WiFi hint shows, the header says Nobody connected", () => {
    vi.useFakeTimers();
    reachActor.send({ type: "UNREACHABLE", payload: { name: "Maya" } } as never);
    vi.advanceTimersByTime(REACH_HINT_AFTER_MS + 1);
    const text = textFor("Maya");
    vi.useRealTimers();
    expect(text).toContain("Nobody connected right now");
    expect(text).not.toContain("Connecting");
  });
});

describe("album header still-to-drop line", () => {
  const withLine = {
    folder: { id: "f1" },
    members: [
      { key: "k0", name: "Me", connected: true },
      { key: "k1", name: "Ben", connected: false, stillToDrop: ["p1"] },
    ],
  };
  const line = "Ben's phone still has a deleted photo.";
  const textOf = (page: object, a: object = album) => {
    const host = document.createElement("div");
    render(albumHeader(page as never, a as never), host);
    return host.textContent?.replace(/\s+/g, " ");
  };
  const base = { folders: [album], requests: [], photos: [], lastSync: Date.now() };

  test("renders under the presence strip", () => {
    expect(textOf({ ...base, status: withLine })).toContain(line);
  });

  test("renders while a join request line holds the slot", () => {
    const admin = { ...album, role: "creator" };
    const request = { folderId: "f1", requestedAt: 1, requesterName: "Cy", requesterKey: "x" };
    const page = { ...base, status: withLine, requests: [request] };
    expect(textOf(page, admin)).toContain(line);
  });

  test("is absent for a removed album", () => {
    const removed = { ...album, notice: { kind: "removed" } };
    expect(textOf({ ...base, status: withLine }, removed)).not.toContain(line);
  });

  test("is absent while there is no status", () => {
    expect(textOf({ ...base, status: null })).not.toContain(line);
  });
});
