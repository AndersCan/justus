// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { JoinRequest } from "@justus/core";
import { gateway } from "../gateway";
import { requests } from "../machines/requests-machine";
import { open } from "../machines/router-machine";
import { raiseAsk } from "./ask-toast";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() }, requests: vi.fn(), respond: vi.fn() },
}));

const ask = (name: string, folderId = "f1") =>
  ({
    folderId,
    folderName: "Spain",
    requesterKey: `k-${name}`,
    requesterName: name,
  }) as unknown as JoinRequest;

const count = () => document.querySelectorAll(".justus-toast").length;

describe("the ask toast on its album page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    open("/");
  });
  afterEach(() => {
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
  });

  test("closes when its album page opens", () => {
    raiseAsk([ask("Maya")]);
    expect(count()).toBe(1);
    open("/sharing/f1");
    expect(count()).toBe(0);
  });

  test("closes on another album", () => {
    raiseAsk([ask("Maya")]);
    open("/sharing/f2");
    expect(count()).toBe(0);
  });

  test("the plural toast closes on an album page", () => {
    raiseAsk([ask("Maya"), ask("Ben", "f2")]);
    open("/sharing/f1");
    expect(count()).toBe(0);
  });

  test("after it timed out, opening the album does nothing", () => {
    raiseAsk([ask("Maya")]);
    vi.advanceTimersByTime(6100);
    expect(count()).toBe(0);
    open("/sharing/f1");
    expect(count()).toBe(0);
  });
});

describe("the ask toast raised by the requests machine", () => {
  afterEach(() => {
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
  });

  test("a new ask from a reload toasts, Review opens its album and the toast is gone", async () => {
    open("/");
    const lists = [[], [ask("Maya")]];
    let i = 0;
    vi.mocked(gateway.requests).mockImplementation((async () => [
      null,
      { requests: lists[Math.min(i++, 1)] },
    ]) as never);
    requests.refresh();
    await vi.waitFor(() => expect(i).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    requests.refresh();
    await vi.waitFor(() => expect(count()).toBe(1));
    vi.useFakeTimers();
    document.querySelector<HTMLButtonElement>(".ui-toast-action")?.click();
    expect(location.pathname).toBe("/sharing/f1");
    expect(count()).toBe(0);
  });

  test("the photos page of the same id closes it", () => {
    vi.useFakeTimers();
    open("/");
    raiseAsk([ask("Maya")]);
    open("/albums/f1");
    expect(count()).toBe(0);
  });
});
