import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LockStatus } from "@justus/core";

vi.mock("./toast", () => ({ toast: vi.fn() }));
vi.mock("../gateway", () => ({ gateway: { lock: { status: vi.fn(), setEnabled: vi.fn() } } }));

import { appLockActor, appLockEvents } from "../machines/app-lock-machine";
import { appLockView, refreshAppLock, toggleAppLock } from "./app-lock";
import { toast } from "./toast";

const shell = (on: boolean) => {
  vi.stubGlobal("window", { BareShell: on });
};
const ok = <T>(v: T) => Promise.resolve([null, v] as [null, T]);
const fail = () => Promise.resolve([new Error("x"), null] as [Error, null]);
const status = (s: LockStatus) => () => ok(s);

const view = () =>
  appLockView({
    status: appLockActor.snapshot().context.status,
    busy: appLockActor.snapshot().path[0] === "saving",
  });

beforeEach(() => {
  shell(true);
  appLockActor.send(appLockEvents.statusRead.create({ status: undefined }));
  vi.mocked(toast).mockClear();
});

describe("app lock card", () => {
  it("does nothing outside the Android host", async () => {
    shell(false);
    const load = vi.fn(status({ available: true, enabled: false }));
    await refreshAppLock(load);
    expect(load).not.toHaveBeenCalled();
    expect(view()).toBeUndefined();
  });

  it("stays absent when the status call errors", async () => {
    await refreshAppLock(fail);
    expect(view()).toBeUndefined();
  });

  it("stays absent on a malformed result", async () => {
    await refreshAppLock((() => ok({ available: "yes" })) as never);
    expect(appLockActor.snapshot().context.status).toBeUndefined();
  });

  it("disables the switch without a screen lock", async () => {
    await refreshAppLock(status({ available: false, enabled: false }));
    expect(view()?.disabled).toBe(true);
    expect(view()?.hint).toBe("Set a screen lock in your phone's Settings to use App lock.");
  });

  it("turns on and toasts", async () => {
    await refreshAppLock(status({ available: true, enabled: false }));
    await toggleAppLock(() => ok({ enabled: true }));
    expect(view()?.on).toBe(true);
    expect(toast).toHaveBeenCalledWith("App lock is on");
  });

  it("turns off and toasts", async () => {
    await refreshAppLock(status({ available: true, enabled: true }));
    await toggleAppLock(() => ok({ enabled: false }));
    expect(view()?.on).toBe(false);
    expect(toast).toHaveBeenCalledWith("App lock is off");
  });

  it("stays off without a toast when the prompt is cancelled", async () => {
    await refreshAppLock(status({ available: true, enabled: false }));
    await toggleAppLock(() => ok({ enabled: false }));
    expect(view()?.on).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("toasts and reloads the status when setEnabled errors", async () => {
    await refreshAppLock(status({ available: true, enabled: false }));
    const load = vi.fn(status({ available: false, enabled: false }));
    await toggleAppLock(fail, load);
    expect(toast).toHaveBeenCalledWith("Couldn't turn on App lock. Try again.");
    expect(load).toHaveBeenCalledTimes(1);
    expect(view()?.disabled).toBe(true);
  });

  it("ignores a second toggle while busy", async () => {
    await refreshAppLock(status({ available: true, enabled: false }));
    const set = vi.fn(() => ok({ enabled: true }));
    await Promise.all([toggleAppLock(set), toggleAppLock(set)]);
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe("app lock busy state", () => {
  it("is busy while the host is asked, then idle", async () => {
    await refreshAppLock(status({ available: true, enabled: false }));
    let release: (v: [null, { enabled: boolean }]) => void = () => {};
    const pending = toggleAppLock(
      () => new Promise<[null, { enabled: boolean }]>((r) => (release = r)),
    );
    expect(appLockActor.snapshot().path[0]).toBe("saving");
    expect(view()?.disabled).toBe(true);
    release([null, { enabled: true }]);
    await pending;
    expect(appLockActor.snapshot().path[0]).toBe("idle");
  });
});
