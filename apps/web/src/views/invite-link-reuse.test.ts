// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";

const mock = vi.hoisted(() => ({
  endInviteLink: vi.fn(),
  saveInviteLink: vi.fn(),
  turnOffInvite: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: mock.turnOffInvite,
    saveInviteLink: mock.saveInviteLink,
    endInviteLink: mock.endInviteLink,
    folders: async () => [null, { folders: [] }],
    requests: async () => [null, { requests: [] }],
    status: async () => [null, {}],
  },
}));
vi.mock("./toast", () => ({ toast: mock.toast }));
vi.mock("./confirm", () => ({ confirmAction: mock.confirm }));

const DAY = 86_400_000;
const NOW = Date.now();
const SOON = Math.floor((NOW + DAY) / 1000) * 1000;
const LATER = Math.floor((NOW + 7 * DAY) / 1000) * 1000;

const folder = (links: { madeAt: number; endsAt: number }[], code = "c") =>
  ({
    id: "f1",
    name: "Album",
    role: "creator",
    invite: { code, owner: "o", links },
  }) as unknown as FolderSummary;

let mod: typeof import("./invite");

beforeEach(async () => {
  vi.resetModules();
  for (const m of Object.values(mock)) m.mockReset();
  mock.saveInviteLink.mockResolvedValue([null, { ok: true }]);
  mock.endInviteLink.mockResolvedValue([null, { ok: true }]);
  mod = await import("./invite");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));

const rowCopy = async (f: FolderSummary) => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const host = document.createElement("div");
  document.body.append(host);
  render(mod.inviteRow(f, "Nils"), host);
  button(host, /Copy invite link|Copy link/)?.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  return (writeText.mock.calls[0] as unknown as [string])[0];
};

describe("repro #948 r2: which link the album row's Copy reuses", () => {
  test("plan: the newest made link, the top row, even when an older one ends later", async () => {
    const copied = await rowCopy(
      folder([
        { madeAt: NOW, endsAt: SOON },
        { madeAt: NOW - 1000, endsAt: LATER },
      ]),
    );
    expect(mock.saveInviteLink).not.toHaveBeenCalled();
    expect(copied).toContain(`e=${SOON / 1000}`);
  });

  test("a link that ran out since the list was read is not reused: a new end is saved", async () => {
    const gone = Math.floor((NOW - 1000) / 1000) * 1000;
    const copied = await rowCopy(folder([{ madeAt: NOW - 2 * DAY, endsAt: gone }]));
    expect(mock.saveInviteLink).toHaveBeenCalledTimes(1);
    expect(copied).not.toContain(`e=${gone / 1000}`);
  });
});

test("the first link's Copy says Copied on the button and shows no toast", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const host = document.createElement("div");
  document.body.append(host);
  render(
    mod.invitePanel(folder([]), "Nils", "Nils", false, () => {}),
    host,
  );
  button(host, /Copy invite link/)?.click();
  await vi.waitFor(() => expect(button(host, /Copied/)).toBeDefined());
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(mock.toast).not.toHaveBeenCalled();
});
