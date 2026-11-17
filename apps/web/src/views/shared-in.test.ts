// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { SharedBatch } from "@justus/core";

const list = vi.fn();
vi.mock("../gateway", () => ({ gateway: { sharedIn: { list: () => list() } } }));

const batch = (id: string): SharedBatch => ({
  id,
  receivedAt: "2026-11-17T21:30:00.000Z",
  photos: [],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

const added: EventListener[] = [];

async function load() {
  vi.resetModules();
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((type: string, fn: EventListener) => {
    if (type === "justus:shared") added.push(fn);
    add(type, fn);
  }) as never);
  return (await import("./shared-in")).listenForSharedPhotos;
}

afterEach(() => {
  for (const fn of added.splice(0)) window.removeEventListener("justus:shared", fn);
  list.mockReset();
  vi.restoreAllMocks();
});

describe("listenForSharedPhotos", () => {
  test("lists once at start and delivers each batch", async () => {
    list.mockResolvedValue([null, { batches: [batch("a"), batch("b")] }]);
    const got: string[] = [];
    (await load())((b) => got.push(b.id));
    await tick();
    expect(list).toHaveBeenCalledTimes(1);
    expect(got).toEqual(["a", "b"]);
  });

  test("a nudge after the list finished lists again", async () => {
    list.mockResolvedValue([null, { batches: [] }]);
    (await load())(() => {});
    await tick();
    window.dispatchEvent(new CustomEvent("justus:shared"));
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("nudges during an in-flight list run exactly one more list, never in parallel", async () => {
    let release: (v: unknown) => void = () => {};
    let active = 0;
    let peak = 0;
    list.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => (release = r));
      active--;
      return [null, { batches: [] }];
    });
    (await load())(() => {});
    await tick();
    window.dispatchEvent(new CustomEvent("justus:shared"));
    window.dispatchEvent(new CustomEvent("justus:shared"));
    release(null);
    await tick();
    release(null);
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  test("a list error delivers nothing and warns", async () => {
    list.mockResolvedValue([new Error("boom"), null]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const got: string[] = [];
    (await load())((b) => got.push(b.id));
    await tick();
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledWith("justus:share-in.list-failed", "boom");
  });

  test("a nudge during a failed list still runs one more list", async () => {
    let release: (v: unknown) => void = () => {};
    list.mockImplementationOnce(async () => {
      await new Promise((r) => (release = r));
      return [new Error("timeout"), null];
    });
    list.mockResolvedValue([null, { batches: [batch("late")] }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const got: string[] = [];
    (await load())((b) => got.push(b.id));
    await tick();
    window.dispatchEvent(new CustomEvent("justus:shared"));
    release(null);
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    expect(got).toEqual(["late"]);
  });
});
