// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";

const mock = vi.hoisted(() => ({
  endInviteLink: vi.fn(),
  saveInviteLink: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: async () => [null, {}],
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

const folder = (links: { madeAt: number; endsAt: number }[]) =>
  ({
    id: "f1",
    name: "Album",
    role: "creator",
    invite: { code: "c", owner: "o", links },
  }) as unknown as FolderSummary;

let invitePanel: typeof import("./invite").invitePanel;
let actor: typeof import("../machines/sharing/invite-link").inviteLinkActor;

beforeEach(async () => {
  vi.resetModules();
  for (const m of Object.values(mock)) m.mockReset();
  mock.saveInviteLink.mockResolvedValue([null, { ok: true }]);
  mock.endInviteLink.mockResolvedValue([null, { ok: true }]);
  ({ invitePanel } = await import("./invite"));
  ({ inviteLinkActor: actor } = await import("../machines/sharing/invite-link"));
});

afterEach(() => document.body.replaceChildren());

const mount = (links: { madeAt: number; endsAt: number }[]) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    invitePanel(folder(links), "Nils", "Nils", false, () => {}),
    host,
  );
  return host;
};

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-link-row]")];
const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));

describe("the links you sent", () => {
  test("each live link is a row with its end time, Copy and End; the picker stays", () => {
    const host = mount([
      { madeAt: NOW, endsAt: LATER },
      { madeAt: NOW, endsAt: SOON },
    ]);
    expect(rows(host).map((r) => r.dataset.endsAt)).toEqual([String(LATER), String(SOON)]);
    const ends = rows(host).map((r) => r.querySelectorAll("button")[1]?.getAttribute("aria-label"));
    expect(new Set(ends).size).toBe(2);
    expect(rows(host)[0]?.textContent).toContain("Works until");
    for (const r of rows(host)) expect(r.textContent).toContain("Anyone with it can ask to join.");
    expect(host.textContent).toContain("Nobody sees a photo until you accept them.");
    expect(host.querySelector("select")).not.toBeNull();
    expect(button(host, /^\s*Make a new link\s*$/)).toBeDefined();
    expect(button(host, /Copy invite link|Copy link/)).toBeUndefined();
  });

  test("a run-out link has no row; with none the first-link buttons show", () => {
    const host = mount([{ madeAt: NOW - 2 * DAY, endsAt: NOW - DAY }]);
    expect(rows(host)).toHaveLength(0);
    expect(button(host, /Make a new link/)).toBeUndefined();
    expect(button(host, /Copy invite link|Copy link/)).toBeDefined();
  });

  test("a row's Copy copies that row's end", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const host = mount([
      { madeAt: NOW, endsAt: LATER },
      { madeAt: NOW, endsAt: SOON },
    ]);
    rows(host)[1]?.querySelectorAll("button")[0]?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const first = writeText.mock.calls[0] as unknown as [string];
    expect(first[0]).toContain(`e=${SOON / 1000}`);
    await vi.waitFor(() => expect(mock.toast).toHaveBeenCalledWith("Invite link copied"));
  });

  test("End asks first, then ends that row's link; Cancel ends nothing", async () => {
    const host = mount([
      { madeAt: NOW, endsAt: LATER },
      { madeAt: NOW, endsAt: SOON },
    ]);
    mock.confirm.mockResolvedValueOnce(false);
    rows(host)[0]?.querySelectorAll("button")[1]?.click();
    await vi.waitFor(() => expect(mock.confirm).toHaveBeenCalledTimes(1));
    await actor.settled();
    expect(mock.endInviteLink).not.toHaveBeenCalled();
    mock.confirm.mockResolvedValueOnce(true);
    rows(host)[1]?.querySelectorAll("button")[1]?.click();
    await vi.waitFor(() => expect(mock.endInviteLink).toHaveBeenCalledWith("f1", SOON));
  });

  test("Make a new link saves a second end and copies it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const host = mount([{ madeAt: NOW, endsAt: SOON }]);
    button(host, /Make a new link/)?.click();
    await vi.waitFor(() => expect(mock.saveInviteLink).toHaveBeenCalledTimes(1));
    const saved = mock.saveInviteLink.mock.calls[0] as unknown as [string, number];
    expect(saved[0]).toBe("f1");
    await vi.waitFor(() => expect(mock.toast).toHaveBeenCalledWith("Invite link copied"));
  });
});
