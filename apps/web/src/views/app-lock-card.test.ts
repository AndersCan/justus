// @vitest-environment happy-dom
import { render } from "lit-html";
import { expect, test, vi } from "vite-plus/test";
import type { LockStatus } from "@justus/core";

vi.mock("../gateway", () => ({ gateway: { lock: { status: vi.fn(), setEnabled: vi.fn() } } }));

import { appLockSection, refreshAppLock } from "./app-lock";

const status = (s: LockStatus) => () => Promise.resolve([null, s] as [null, LockStatus]);

test("the App lock switch is a choice card, drawn as chosen only when on", async () => {
  (window as unknown as { BareShell: boolean }).BareShell = true;
  const host = document.createElement("div");
  const card = () => host.querySelector("[role=switch]")!.className.split(" ");
  await refreshAppLock(status({ available: true, enabled: false }));
  render(appLockSection(), host);
  expect(card()).toContain("ui-radio-card");
  expect(card()).not.toContain("ui-radio-card-checked");
  await refreshAppLock(status({ available: true, enabled: true }));
  render(appLockSection(), host);
  expect(card()).toContain("ui-radio-card-checked");
  expect(card()).not.toContain("ui-radio-card");
  render(null, host);
});
