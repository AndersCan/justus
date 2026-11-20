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
let inviteLink: typeof import("../machines/sharing/invite-link").inviteLink;
let actor: typeof import("../machines/sharing/invite-link").inviteLinkActor;

beforeEach(async () => {
  vi.resetModules();
  for (const m of Object.values(mock)) m.mockReset();
  mock.saveInviteLink.mockResolvedValue([null, { ok: true }]);
  mock.endInviteLink.mockResolvedValue([null, { ok: true }]);
  mod = await import("./invite");
  ({ inviteLink, inviteLinkActor: actor } = await import("../machines/sharing/invite-link"));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = (f: FolderSummary) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    mod.invitePanel(f, "Nils", "Nils", false, () => {}),
    host,
  );
  return host;
};
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-link-row]")];
const button = (host: HTMLElement, label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) => label.test(b.textContent ?? ""));

describe("repro #948", () => {
  test("Make a new link while a link is shown saves another end and copies it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    inviteLink.createLink("f1", "c");
    await actor.settled();
    expect(mock.saveInviteLink).toHaveBeenCalledTimes(1);
    const [, first] = mock.saveInviteLink.mock.calls[0] as unknown as [string, number];
    const host = mount(folder([{ madeAt: NOW, endsAt: first }]));
    button(host, /Make a new link/)?.click();
    await vi.waitFor(() => expect(mock.saveInviteLink).toHaveBeenCalledTimes(2));
    const [, second] = mock.saveInviteLink.mock.calls[1] as unknown as [string, number];
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain(`e=${second / 1000}`);
  });

  test("Make a new link that cannot copy says so", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("no");
        }),
      },
    });
    const host = mount(folder([{ madeAt: NOW, endsAt: SOON }]));
    button(host, /Make a new link/)?.click();
    await vi.waitFor(() => expect(mock.toast).toHaveBeenCalledTimes(1));
    expect(mock.toast).not.toHaveBeenCalledWith("Invite link copied");
  });

  test("a row's End is off while that link is ending", async () => {
    let finish: (v: unknown) => void = () => {};
    mock.endInviteLink.mockReturnValue(new Promise((r) => (finish = r)));
    mock.confirm.mockResolvedValue(true);
    const host = mount(
      folder([
        { madeAt: NOW, endsAt: LATER },
        { madeAt: NOW, endsAt: SOON },
      ]),
    );
    rows(host)[1]?.querySelectorAll("button")[1]?.click();
    await vi.waitFor(() => expect(mock.endInviteLink).toHaveBeenCalledWith("f1", SOON));
    expect(rows(host)[1]?.querySelectorAll("button")[1]?.disabled).toBe(true);
    expect(rows(host)[0]?.querySelectorAll("button")[1]?.disabled).toBe(false);
    finish([null, { ok: true }]);
    await actor.settled();
  });

  test("Make a new link is off for a code just turned off", async () => {
    mock.turnOffInvite.mockResolvedValue([null, { invite: { code: "c2" } }]);
    inviteLink.turnOffLink("f1", "c");
    await actor.settled();
    const host = mount(folder([{ madeAt: NOW, endsAt: SOON }], "c"));
    expect(button(host, /Make a new link/)?.disabled).toBe(true);
  });

  test("plan: the album row's Copy reuses the newest live link instead of making one", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const host = document.createElement("div");
    document.body.append(host);
    render(
      mod.inviteRow(
        folder([
          { madeAt: NOW, endsAt: LATER },
          { madeAt: NOW - 1000, endsAt: SOON },
        ]),
        "Nils",
      ),
      host,
    );
    button(host, /Copy invite link|Copy link/)?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(mock.saveInviteLink).not.toHaveBeenCalled();
    expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain(`e=${LATER / 1000}`);
  });
});
