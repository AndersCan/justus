// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { FolderSummary } from "@justus/core";
import { inviteLink } from "../machines/sharing/invite-link";
import { checkCodeLine, friendNamesLine, invitePanel, joinSheet, waitingLine } from "./invite";

vi.mock("../gateway", () => ({
  gateway: {
    friends: { list: async () => [null, { friends: [] }] },
    turnOffInvite: vi.fn(() => new Promise(() => {})),
    saveInviteLink: vi.fn(async () => [null, { ok: true }]),
  },
}));

const asksHolder = vi.hoisted(() => ({ asks: [] as { code: string; checkCode?: string }[] }));

vi.mock("@mantaq/lit", async (orig) => ({
  ...(await orig<object>()),
  watch: (actor: { snapshot(): unknown }, fn: (s: unknown) => unknown) => fn(actor.snapshot()),
}));
vi.mock("../machines/folders-machine", async (orig) => ({
  ...(await orig<object>()),
  foldersActor: {
    snapshot: () => ({ context: { asks: asksHolder.asks } }),
    on: () => () => {},
  },
}));
vi.mock("../machines/sharing/join-request", async (orig) => ({
  ...(await orig<object>()),
  joinActor: { snapshot: () => ({}) },
  joinViewOf: () => ({
    state: "waitingForAdminToAccept",
    invite: { code: "c1", album: "Lisbon", ownerName: "Anna" },
    error: "",
  }),
}));

const LINE = "Send it in any chat. They need Justus installed.";

const folder = (role: string) =>
  ({
    id: "f1",
    name: "Lisbon trip",
    role,
    invite: { code: "c", owner: "o" },
  }) as unknown as FolderSummary;

const mount = (role: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  render(
    invitePanel(folder(role), "Nils", "Nils", false, () => {}),
    host,
  );
  return host;
};

const copyButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) =>
    /^(Copy invite link|Copy link|Copied ✓)$/.test(b.textContent?.trim() ?? ""),
  );

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("invite card send hint", () => {
  test("the Admin sees where to send the link", () => {
    const host = mount("creator");
    expect(host.textContent).toContain(LINE);
  });

  test("the line stays after Copy turns back", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    const host = mount("creator");
    const label = copyButton(host)!.textContent!.trim();
    copyButton(host)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copyButton(host)!.textContent).toBe("Copied ✓");
    expect(host.textContent).toContain(LINE);
    await vi.advanceTimersByTimeAsync(3000);
    expect(copyButton(host)!.textContent!.trim()).toBe(label);
    expect(host.textContent).toContain(LINE);
  });

  test("a member sees no line", () => {
    const host = mount("member");
    expect(host.textContent).not.toContain(LINE);
  });

  test("no line while links are being turned off", async () => {
    inviteLink.turnOffLink("f1", "c");
    await new Promise((r) => setTimeout(r, 0));
    const host = mount("creator");
    expect(host.textContent).not.toContain(LINE);
    expect(copyButton(host)!.disabled).toBe(true);
  });
});

describe("friendNamesLine", () => {
  const names = (...n: string[]) => friendNamesLine(n.map((name) => ({ identity: name, name })));
  test.each([
    [["Ben"], "From your friends: Ben. They get the invite in Justus, no link needed."],
    [
      ["Ben", "Kari"],
      "From your friends: Ben or Kari. They get the invite in Justus, no link needed.",
    ],
    [
      ["Ånna", "Kari", "ole"],
      "From your friends: Ånna, Kari or ole. They get the invite in Justus, no link needed.",
    ],
    [
      ["A", "B", "C", "D", "E"],
      "From your friends: A, B, C or 2 more. They get the invite in Justus, no link needed.",
    ],
  ])("%j", (list, text) => {
    expect(names(...list)).toBe(text);
  });
});

describe("checkCodeLine", () => {
  test("is null without a code", () => {
    expect(checkCodeLine(undefined, "Anna")).toBeNull();
  });
  test("names the code and what to do with it", () => {
    const host = document.createElement("div");
    render(checkCodeLine("maple river stone", "Anna"), host);
    expect(host.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Your check code is maple river stone. If Anna asks, tell them these three words so Anna knows it's you.",
    );
  });
});

describe("joinSheet waiting screen", () => {
  const text = (asks: { code: string; checkCode?: string }[]) => {
    asksHolder.asks = asks;
    const host = document.createElement("div");
    render(joinSheet(), host);
    return host.textContent?.replace(/\s+/g, " ") ?? "";
  };
  test("shows the code stored on this invite's ask", () => {
    expect(text([{ code: "c1", checkCode: "maple river stone" }])).toContain(
      "Your check code is maple river stone",
    );
  });
  test("shows no code for another invite's ask", () => {
    expect(text([{ code: "c2", checkCode: "zoo wrap cat" }])).not.toContain("check code");
  });
  test("shows no code when the ask has none", () => {
    expect(text([{ code: "c1" }])).not.toContain("check code");
  });
});

describe("waiting invites line", () => {
  const WAIT = "Invites waiting for friends.";
  const mountWith = (role: string, waitingFor?: string[], friends: Record<string, string> = {}) => {
    const host = document.createElement("div");
    document.body.append(host);
    const f = { ...folder(role), waitingFor } as FolderSummary;
    render(
      invitePanel(f, "Nils", "Nils", false, () => {}, [], friends),
      host,
    );
    return host;
  };

  test("no line without waiting invites", () => {
    expect(waitingLine(undefined)).toBeNull();
    expect(waitingLine([])).toBeNull();
    expect(mountWith("creator", []).textContent).not.toContain(WAIT);
  });

  test("the Admin sees the line", () => {
    expect(waitingLine(["k"])).toContain(WAIT);
    expect(mountWith("creator", ["k"], { k: "Kari" }).textContent).toContain(WAIT);
  });

  test("the line shows when no friend can be added", () => {
    expect(mountWith("creator", ["k"]).textContent).toContain(WAIT);
  });

  test("a member never sees it", () => {
    expect(mountWith("member", ["k"]).textContent).not.toContain(WAIT);
  });
});

describe("invited friends list", () => {
  const takeBack = vi.hoisted(() => vi.fn());
  vi.mock("../machines/people-machine", async (orig) => ({
    ...(await orig<object>()),
    people: { takeBackInvite: takeBack },
  }));

  const mountInvited = (
    role: string,
    invitedFriends: { identity: string; role: "reader" | "member" }[] | undefined,
    opts: {
      friends?: Record<string, string>;
      members?: string[];
      busy?: boolean;
      error?: string;
    } = {},
  ) => {
    const host = document.createElement("div");
    document.body.append(host);
    const f = { ...folder(role), invitedFriends } as FolderSummary;
    render(
      invitePanel(
        f,
        "Nils",
        "Nils",
        false,
        () => {},
        opts.members ?? [],
        opts.friends ?? {},
        opts.busy ?? false,
        opts.error ?? null,
      ),
      host,
    );
    return host;
  };
  const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("li button");

  test("lists a friend with the role and a Take back button", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }], {
      friends: { k: "Kari" },
    });
    expect(host.textContent).toContain("Invited, not in yet");
    expect(host.querySelector("li")?.textContent).toContain("Kari");
    expect(host.querySelector("li")?.textContent).toContain("Viewer");
    expect(button(host)?.getAttribute("aria-label")).toBe("Take back Kari's invite");
  });

  test("a Collaborator row says Collaborator", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "member" }], {
      friends: { k: "Kari" },
    });
    expect(host.querySelector("li")?.textContent).toContain("Collaborator");
  });

  test("a friend without a saved name is Someone you invited", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }]);
    expect(host.textContent).toContain("Someone you invited");
    expect(button(host)?.getAttribute("aria-label")).toBe("Take back this invite");
  });

  test("someone already in the album is not listed", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }], { members: ["k"] });
    expect(host.textContent).not.toContain("Invited, not in yet");
    expect(host.querySelector("li")).toBeNull();
  });

  test("an invited friend is not offered again, but the list shows", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }], {
      friends: { k: "Kari" },
    });
    expect(host.textContent).not.toContain("From your friends");
    expect(host.textContent).not.toContain("Add a friend");
    expect(host.textContent).toContain("Kari");
  });

  test("busy disables Take back", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }], { busy: true });
    expect(button(host)?.disabled).toBe(true);
  });

  test("a member never sees the list", () => {
    const host = mountInvited("member", [{ identity: "k", role: "reader" }]);
    expect(host.textContent).not.toContain("Invited, not in yet");
  });

  test("clicking Take back asks the machine", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }], {
      friends: { k: "Kari" },
    });
    button(host)?.click();
    expect(takeBack).toHaveBeenCalledWith("f1", "k", "Kari");
  });

  test("a failed Take back shows an alert in the card", () => {
    const host = mountInvited("creator", [{ identity: "k", role: "reader" }], { error: "boom" });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't take back the invite.",
    );
  });
});

describe("joinSheet update screen", () => {
  test("renders as the waiting sheet, not the decline sheet", async () => {
    const mod = await import("../machines/sharing/join-request");
    const spy = vi.spyOn(mod, "joinViewOf").mockReturnValue({
      state: "waitingForYouToUpdate",
      invite: { code: "c1", album: "Lisbon", ownerName: "Anna" },
      error: "",
    } as ReturnType<typeof mod.joinViewOf>);
    const host = document.createElement("div");
    render(joinSheet(), host);
    spy.mockRestore();
    const text = host.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).not.toContain("didn't accept");
    expect(text).not.toContain("Request to join sent");
    expect(text).toContain("Update Justus to join “Lisbon”");
    expect(text).toContain(
      "Your request is saved on this phone. It reaches Anna once both phones have the same Justus.",
    );
    expect(text).toContain("Cancel request");
    expect(text).toContain("Close");
  });

  test("the plain waiting sheet keeps its own text", () => {
    const host = document.createElement("div");
    render(joinSheet(), host);
    const text = host.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Request to join sent");
    expect(text).not.toContain("Update Justus to join");
  });
});
