// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { JoinRequest } from "@justus/core";
import { open } from "../machines/router-machine";
import { raiseAsk } from "./ask-toast";

vi.mock("../gateway", () => ({
  gateway: { logs: { view: vi.fn(), clear: vi.fn() } },
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

  test("stays for another album", () => {
    raiseAsk([ask("Maya")]);
    open("/sharing/f2");
    expect(count()).toBe(1);
  });

  test("the plural toast stays on an album page", () => {
    raiseAsk([ask("Maya"), ask("Ben", "f2")]);
    open("/sharing/f1");
    expect(count()).toBe(1);
  });

  test("after it timed out, opening the album does nothing", () => {
    raiseAsk([ask("Maya")]);
    vi.advanceTimersByTime(6100);
    expect(count()).toBe(0);
    open("/sharing/f1");
    expect(count()).toBe(0);
  });
});
