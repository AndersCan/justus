// @vitest-environment happy-dom
// Put in apps/web/src/views/. Fails on 31e3fcd0 (waitingSheet is a second template, so lit swaps the <dialog>); passes on main and with sheet(label, body, describedBy?).
import { expect, test } from "vite-plus/test";
import { render } from "lit-html";
import type { JoinView } from "../machines/sharing/join-request";
import { renderJoinSheet } from "./join-sheet";

const invite = {
  code: "a".repeat(64),
  owner: "b".repeat(64),
  album: "Spain 2026",
  ownerName: "Nils",
};
const nothing = () => {};
const actions = {
  dismissExpired: nothing,
  closeStoppedLink: nothing,
  notNow: nothing,
  askToJoin: nothing,
  cancelRequest: nothing,
  closeWaiting: nothing,
  dismissDecline: nothing,
  askAgain: nothing,
};

test("sending the request keeps the open dialog: it does not close and reopen", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const draw = (state: JoinView["state"]) =>
    render(renderJoinSheet({ state, invite, error: "" }, actions), host);
  draw("sendingRequest");
  await Promise.resolve();
  const asking = host.querySelector("dialog");
  let closed = 0;
  asking?.addEventListener("close", () => closed++);
  draw("waitingForAdminToAccept");
  await Promise.resolve();
  expect(host.querySelector("dialog")).toBe(asking);
  expect(closed).toBe(0);
  draw("declinedByAdmin");
  expect(host.querySelector("dialog")).toBe(asking);
  host.remove();
});
