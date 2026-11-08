// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { FolderSummary } from "@justus/core";
import { shareInvite } from "./invite";

const save = vi.hoisted(() => ({
  fn: vi.fn<() => Promise<[unknown, unknown]>>(),
}));

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(),
    saveInviteLink: save.fn,
  },
}));

const folder = {
  id: "f1",
  name: "Lisbon trip",
  role: "creator",
  invite: { code: "c", owner: "o" },
} as unknown as FolderSummary;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sharing waits for the saved time", () => {
  test("a failing save hands out no link", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    save.fn.mockResolvedValueOnce([new Error("no"), null]);
    await shareInvite(folder, "Nils");
    expect(share).not.toHaveBeenCalled();
  });

  test("a pending save hands out nothing until it succeeds", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    let finish: (v: [unknown, unknown]) => void = () => {};
    save.fn.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const sent = shareInvite(folder, "Nils");
    await new Promise((r) => setTimeout(r, 10));
    expect(share).not.toHaveBeenCalled();
    finish([null, { ok: true }]);
    await sent;
    expect(share).toHaveBeenCalledTimes(1);
  });
});
