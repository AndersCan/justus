// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import { copy } from "../copy/copy";
import type { JoinView } from "../machines/sharing/join-request";
import { EXPIRED_LINK } from "../machines/sharing/join-request-machine";
import { renderJoinSheet } from "./join-sheet";

const invite = {
  code: "a".repeat(64),
  owner: "b".repeat(64),
  album: "Spain 2026",
  ownerName: "Nils",
};
const owner = invite.ownerName;
const nothing = () => {};
const actions = {
  dismissExpired: nothing,
  closeStoppedLink: nothing,
  notNow: nothing,
  askToJoin: nothing,
  cancelRequest: nothing,
  closeWaiting: nothing,
  dismissDecline: nothing,
};

const noSheet: JoinView["state"][] = [
  "noInviteOpen",
  "showingLinkProblem",
  "joinedAlbum",
  "showingWelcome",
  "holdingInviteUntilWelcomeEnds",
];
const labels: [JoinView["state"], string][] = [
  ["checkingLink", copy("join_request.checking_owner_s_link", { owner })],
  ["decidingToAsk", copy("invite.ask_to_join", { album: invite.album })],
  ["sendingRequest", copy("invite.ask_to_join", { album: invite.album })],
  ["waitingForAdminToAccept", copy("invite.you_re_done", { owner })],
  ["waitingForYouToUpdate", copy("invite.update_justus_to_join", { album: invite.album })],
  ["declinedByAdmin", copy("invite.didn_t_accept_your_request", { owner })],
  ["linkExpired", EXPIRED_LINK],
  ["linkTurnedOffByAdmin", copy("join_request.owner_turned_off_this_link", { owner })],
  ["linkReplacedByAdmin", copy("join_request.owner_replaced_this_link", { owner })],
  ["albumDeletedByAdmin", copy("join_request.owner_deleted_this_album", { owner })],
  ["linkStoppedForUnknownReason", copy("join_request.this_invite_link_no_longer")],
];

function draw(state: JoinView["state"]) {
  const div = document.createElement("div");
  render(renderJoinSheet({ state, invite, error: "" }, actions), div);
  return div;
}

describe("renderJoinSheet", () => {
  test.each(noSheet)("%s draws no sheet", (state) => {
    expect(draw(state).querySelectorAll("dialog")).toHaveLength(0);
  });

  test.each(labels)("%s draws its sheet", (state, label) => {
    const dialogs = draw(state).querySelectorAll("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.getAttribute("aria-label")).toBe(label);
  });

  test("Not now is the dismiss button only while it is enabled", () => {
    const notNow = vi.fn();
    const sheetFor = (state: JoinView["state"]) => {
      const div = document.createElement("div");
      document.body.append(div);
      render(renderJoinSheet({ state, invite, error: "" }, { ...actions, notNow }), div);
      return div;
    };
    const deciding = sheetFor("decidingToAsk");
    deciding.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(notNow).toHaveBeenCalledTimes(1);
    const sending = sheetFor("sendingRequest");
    sending.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(notNow).toHaveBeenCalledTimes(1);
  });

  test("waiting backs out with Close, never Cancel request", () => {
    const closeWaiting = vi.fn();
    const cancelRequest = vi.fn();
    const div = document.createElement("div");
    document.body.append(div);
    render(
      renderJoinSheet(
        { state: "waitingForAdminToAccept", invite, error: "" },
        { ...actions, closeWaiting, cancelRequest },
      ),
      div,
    );
    div.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(closeWaiting).toHaveBeenCalledTimes(1);
    expect(cancelRequest).not.toHaveBeenCalled();
  });

  test("checking the link has nothing to dismiss it", () => {
    const div = draw("checkingLink");
    expect(div.querySelector("[data-dismiss]")).toBeNull();
  });

  test("lines appear only where given", () => {
    const div = document.createElement("div");
    render(
      renderJoinSheet({ state: "waitingForAdminToAccept", invite, error: "" }, actions, {
        checkCode: "one-two-three",
      }),
      div,
    );
    expect(div.textContent).toContain("one-two-three");
  });

  test("the asked line sits under stopped-link titles only", () => {
    const at = (state: JoinView["state"]) => {
      const div = document.createElement("div");
      render(renderJoinSheet({ state, invite, error: "" }, actions, { asked: "ASKED" }), div);
      return div.textContent;
    };
    expect(at("linkTurnedOffByAdmin")).toContain("ASKED");
    expect(at("linkReplacedByAdmin")).toContain("ASKED");
    expect(at("albumDeletedByAdmin")).not.toContain("ASKED");
    expect(at("linkStoppedForUnknownReason")).not.toContain("ASKED");
  });
});

describe("renderJoinSheet when the owner's name is not known", () => {
  const states = labels.map(([state]) => state);
  const drawFor = (state: JoinView["state"], ownerName: string) => {
    const div = document.createElement("div");
    render(renderJoinSheet({ state, invite: { ...invite, ownerName }, error: "" }, actions), div);
    return div;
  };

  test.each(
    states.flatMap(
      (s) =>
        [
          [s, ""],
          [s, "the Admin"],
        ] as const,
    ),
  )("%s with name %j never says Admin", (state, ownerName) => {
    const text = drawFor(state, ownerName).textContent ?? "";
    expect(text).not.toContain("Admin");
    expect(
      drawFor(state, ownerName).querySelector("dialog")?.getAttribute("aria-label"),
    ).not.toContain("Admin");
  });

  test("the checking line names the person who invited you", () => {
    expect(drawFor("checkingLink", "").querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "Checking the link from the person who invited you…",
    );
  });

  test("a stopped link starts its title with a capital", () => {
    expect(drawFor("linkTurnedOffByAdmin", "").querySelector("h3")?.textContent).toBe(
      "The person who invited you turned off this link.",
    );
  });

  test("the ask sheet starts its body with a capital", () => {
    expect(drawFor("decidingToAsk", "the Admin").querySelector("p")?.textContent).toContain(
      "The person who invited you will see your name",
    );
  });

  test("a mid-sentence line uses the lowercase form", () => {
    expect(drawFor("waitingForAdminToAccept", "").textContent).toContain(
      "Waiting for the person who invited you to let you in.",
    );
  });
});
