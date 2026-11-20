// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";

const mock = vi.hoisted(() => ({ turnOffInvite: vi.fn() }));
vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: mock.turnOffInvite,
    saveInviteLink: async () => [null, { ok: true }],
    folders: async () => [null, { folders: [] }],
    requests: async () => [null, { requests: [] }],
    status: async () => [null, {}],
  },
}));

const LINE = "Links turned off. Links you sent no longer work.";
const OFF = "Turn off links you sent";

const folder = (id: string, code: string, live = false) =>
  ({
    id,
    name: `Album ${id}`,
    role: "creator",
    invite: {
      code,
      owner: "o",
      ...(live ? { links: [{ madeAt: Date.now(), endsAt: Date.now() + 86_400_000 }] } : {}),
    },
  }) as unknown as FolderSummary;

let invitePanel: typeof import("./invite").invitePanel;
let inviteLink: typeof import("../machines/sharing/invite-link").inviteLink;
let actor: typeof import("../machines/sharing/invite-link").inviteLinkActor;

beforeEach(async () => {
  vi.resetModules();
  mock.turnOffInvite.mockReset();
  ({ invitePanel } = await import("./invite"));
  ({ inviteLink, inviteLinkActor: actor } = await import("../machines/sharing/invite-link"));
});

afterEach(() => document.body.replaceChildren());

const mount = (id: string, code: string, live = false) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    invitePanel(folder(id, code, live), "Nils", "Nils", false, () => {}),
    host,
  );
  return host;
};

const status = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="status"]')].filter((e) => e.textContent?.includes(LINE));
const hasOff = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === OFF);

const turnOff = async () => {
  mock.turnOffInvite.mockResolvedValue([null, { invite: { code: "c2" } }]);
  inviteLink.turnOffLink("f1", "c");
  await actor.settled();
};

describe("invite card after links are turned off", () => {
  test("album f1 says so and has no Turn off button; album f2 is unchanged", async () => {
    await turnOff();
    const f1 = mount("f1", "c2");
    expect(status(f1)).toHaveLength(1);
    expect(hasOff(f1)).toBe(false);
    const f2 = mount("f2", "x");
    expect(status(f2)).toHaveLength(0);
    expect(hasOff(f2)).toBe(true);
  });

  test("a failed turn-off shows no line", async () => {
    mock.turnOffInvite.mockResolvedValue([new Error("no"), null]);
    inviteLink.turnOffLink("f1", "c");
    await actor.settled();
    const f1 = mount("f1", "c");
    expect(status(f1)).toHaveLength(0);
    expect(hasOff(f1)).toBe(true);
  });

  test("a new link clears the line", async () => {
    await turnOff();
    inviteLink.createLink("f1", "c2");
    await actor.settled();
    const f1 = mount("f1", "c2", true);
    expect(status(f1)).toHaveLength(0);
    expect(f1.textContent).toContain("Works until");
    expect(hasOff(f1)).toBe(true);
  });
});
