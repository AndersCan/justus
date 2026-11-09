// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";

const mock = vi.hoisted(() => ({ saveInviteLink: vi.fn(), toast: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: async () => [null, {}],
    saveInviteLink: mock.saveInviteLink,
    folders: async () => [null, { folders: [] }],
    requests: async () => [null, { requests: [] }],
    status: async () => [null, {}],
  },
}));
vi.mock("./toast", () => ({ toast: mock.toast }));

const LINE = "Cy was removed, so your old invite link stopped working. Copy a new one to send.";

const folder = (id: string, code: string) =>
  ({
    id,
    name: `Album ${id}`,
    role: "creator",
    invite: { code, owner: "o" },
  }) as unknown as FolderSummary;

let invitePanel: typeof import("./invite").invitePanel;
let copyInviteLink: typeof import("./invite").copyInviteLink;
let inviteLink: typeof import("../machines/sharing/invite-link").inviteLink;
let actor: typeof import("../machines/sharing/invite-link").inviteLinkActor;

beforeEach(async () => {
  vi.resetModules();
  mock.toast.mockReset();
  mock.saveInviteLink.mockReset();
  mock.saveInviteLink.mockResolvedValue([null, { ok: true }]);
  ({ invitePanel, copyInviteLink } = await import("./invite"));
  ({ inviteLink, inviteLinkActor: actor } = await import("../machines/sharing/invite-link"));
});

afterEach(() => document.body.replaceChildren());

const mount = (id: string, code: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    invitePanel(folder(id, code), "Nils", "Nils", false, () => {}),
    host,
  );
  return host;
};

const hasLine = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="status"]')].some((e) => e.textContent?.includes(LINE));

describe("invite card after a removal", () => {
  test("the line and the picker replace 'works until'; a new link clears the line", async () => {
    inviteLink.createLink("f1", "c");
    await actor.settled();
    expect(mount("f1", "c").textContent).toContain("This link works until");
    inviteLink.linkReplaced("f1", "c", "Cy");
    await actor.settled();
    const f1 = mount("f1", "c2");
    expect(hasLine(f1)).toBe(true);
    expect(f1.textContent).not.toContain("This link works until");
    expect(f1.querySelector("select")).not.toBeNull();
    expect(hasLine(mount("f2", "x"))).toBe(false);
    inviteLink.createLink("f1", "c2");
    await actor.settled();
    const again = mount("f1", "c2");
    expect(hasLine(again)).toBe(false);
    expect(again.textContent).toContain("This link works until");
  });

  test("a removal with no link shown adds no line", async () => {
    inviteLink.linkReplaced("f1", "c", "Cy");
    await actor.settled();
    expect(hasLine(mount("f1", "c2"))).toBe(false);
  });
});

describe("copyInviteLink", () => {
  test("a failed save toasts that the link could not be copied", async () => {
    mock.saveInviteLink.mockResolvedValue([new Error("no"), null]);
    await copyInviteLink(folder("f1", "c"), "Nils");
    expect(mock.toast).toHaveBeenCalledWith("Couldn't copy the invite link");
  });

  test("a refused clipboard toasts that the link could not be copied", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    await copyInviteLink(folder("f1", "c"), "Nils");
    expect(mock.toast).toHaveBeenCalledWith("Couldn't copy the invite link");
    vi.unstubAllGlobals();
  });

  test("a copied link toasts Invite link copied", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyInviteLink(folder("f1", "c"), "Nils");
    expect(writeText).toHaveBeenCalledOnce();
    expect(mock.toast).toHaveBeenCalledWith("Invite link copied");
    vi.unstubAllGlobals();
  });
});
