// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../gateway", () => ({
  gateway: { friends: { list: async () => [null, { friends: [] }] } },
}));

import { join, joinActor, joinViewOf } from "../machines/sharing/join-request";
import { buildInviteLink } from "../utils/invite-link";
import { listenForHostInvites } from "./invite";

const make = (album: string) =>
  buildInviteLink({ code: "a".repeat(64), owner: "b".repeat(64), album, ownerName: "Tom" });
const view = () => joinViewOf(joinActor.snapshot());

afterEach(() => {
  join.welcomeEnded();
  join.notNow();
  delete (window as unknown as { __justusInvite?: string }).__justusInvite;
});

describe("listenForHostInvites during the welcome", () => {
  test("holds the address link until the welcome ends", () => {
    join.welcomeStarted();
    listenForHostInvites(make("Garden"));
    expect(view().state).toBe("holdingInviteUntilWelcomeEnds");
    join.welcomeEnded();
    expect(view().state).toBe("decidingToAsk");
    expect(view().invite?.album).toBe("Garden");
  });

  test("the host's cold-start link replaces the address link, and a later event replaces both", () => {
    join.welcomeStarted();
    (window as unknown as { __justusInvite?: string }).__justusInvite = make("Host");
    listenForHostInvites(make("Address"));
    expect(view().invite?.album).toBe("Host");
    expect((window as unknown as { __justusInvite?: string }).__justusInvite).toBeUndefined();
    window.dispatchEvent(new CustomEvent("justus:invite", { detail: make("Later") }));
    expect(view().invite?.album).toBe("Later");
  });
});
