// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("../gateway", () => ({
  gateway: { friends: { list: async () => [null, { friends: [] }] } },
}));

import { join, joinActor, joinViewOf } from "../machines/sharing/join-request";
import { buildInviteLink } from "../utils/invite-link";
import { listenForHostInvites } from "./invite";

const make = (code: string) =>
  buildInviteLink({
    code: code.repeat(64),
    owner: "b".repeat(64),
    album: "Garden",
    ownerName: "Tom",
  });
const view = () => joinViewOf(joinActor.snapshot());

afterEach(() => {
  join.welcomeEnded();
  join.notNow();
  delete (window as unknown as { __justusInvite?: string }).__justusInvite;
});

describe("listenForHostInvites during the welcome", () => {
  test("holds the address link until the welcome ends", () => {
    join.welcomeStarted();
    listenForHostInvites(make("a"));
    expect(view().state).toBe("holdingInviteUntilWelcomeEnds");
    join.welcomeEnded();
    expect(view().state).toBe("decidingToAsk");
    expect(view().invite?.code).toBe("a".repeat(64));
    expect(view().invite?.album).toBe("");
  });

  test("the host's cold-start link replaces the address link, and a later event replaces both", () => {
    join.welcomeStarted();
    (window as unknown as { __justusInvite?: string }).__justusInvite = make("c");
    listenForHostInvites(make("d"));
    expect(view().invite?.code).toBe("c".repeat(64));
    expect((window as unknown as { __justusInvite?: string }).__justusInvite).toBeUndefined();
    window.dispatchEvent(new CustomEvent("justus:invite", { detail: make("e") }));
    expect(view().invite?.code).toBe("e".repeat(64));
  });
});
