// @vitest-environment happy-dom
import { expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { LogEntry } from "@justus/core";

const entries: LogEntry[] = [
  { seq: 1, ts: 1_700_000_000_000, level: "info", source: "backend", message: "b" },
  { seq: 2, ts: 1_700_000_000_001, level: "info", source: "web", message: "w" },
];
vi.mock("../gateway", () => ({
  gateway: {
    logs: {
      view: async () => [null, { entries }],
      clear: async () => [null, { cleared: 0 }],
    },
  },
}));

const { logsPanel, logsController } = await import("./logs");

test("a log source chip wears ui-chip off and ui-chip-on when pressed", async () => {
  const host = document.createElement("div");
  render(logsPanel(), host);
  const chips = () =>
    Object.fromEntries(
      [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].map((b) => [
        b.textContent!.trim(),
        [b.getAttribute("aria-pressed"), b.className],
      ]),
    );
  await vi.waitFor(() => expect(Object.keys(chips())).toEqual(["backend", "web"]));
  const before = chips();
  for (const [pressed, cls] of Object.values(before))
    expect(cls).toBe(pressed === "true" ? "ui-chip-on" : "ui-chip");
  logsController.toggleSource("backend");
  await vi.waitFor(() => expect(chips().backend![0]).not.toBe(before.backend![0]));
  expect(new Set(Object.values(chips()).map(([, c]) => c))).toEqual(
    new Set(["ui-chip", "ui-chip-on"]),
  );
  for (const [pressed, cls] of Object.values(chips()))
    expect(cls).toBe(pressed === "true" ? "ui-chip-on" : "ui-chip");
  logsController.stop();
});
