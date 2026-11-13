// @vitest-environment happy-dom
import { describe, expect, test } from "vite-plus/test";
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
    expect(draw(state).querySelectorAll("[role=dialog]")).toHaveLength(0);
  });

  test.each(labels)("%s draws its sheet", (state, label) => {
    const dialogs = draw(state).querySelectorAll("[role=dialog]");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.getAttribute("aria-label")).toBe(label);
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
