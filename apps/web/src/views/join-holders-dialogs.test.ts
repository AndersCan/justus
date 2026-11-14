// @vitest-environment happy-dom
import { afterEach, describe, expect, it, test, vi } from "vite-plus/test";
import { render } from "lit-html";
import type { Photo } from "@justus/core";
import type { JoinView } from "../machines/sharing/join-request";
import { renderJoinSheet } from "./join-sheet";
import { closeLightbox, lightboxView, openLightbox } from "./lightbox";
import { openHolders } from "./photo-holders";

vi.mock("../gateway", () => ({
  gateway: { list: vi.fn(), add: vi.fn(), upload: vi.fn(), remove: vi.fn() },
}));

const invite = { code: "a".repeat(64), owner: "b".repeat(64), album: "Spain", ownerName: "Nils" };
const tick = () => new Promise((r) => setTimeout(r, 0));

function actionsWith() {
  return {
    dismissExpired: vi.fn(),
    closeStoppedLink: vi.fn(),
    notNow: vi.fn(),
    askToJoin: vi.fn(),
    cancelRequest: vi.fn(),
    closeWaiting: vi.fn(),
    dismissDecline: vi.fn(),
    askAgain: vi.fn(),
  };
}

function drawJoin(state: JoinView["state"], actions: ReturnType<typeof actionsWith>) {
  const div = document.createElement("div");
  document.body.append(div);
  render(renderJoinSheet({ state, invite, error: "" }, actions), div);
  return div;
}

describe("join sheet: Escape and a tap outside press each state's button", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  const cases: [JoinView["state"], keyof ReturnType<typeof actionsWith>, string][] = [
    ["linkExpired", "dismissExpired", "OK"],
    ["declinedByAdmin", "dismissDecline", "Not now"],
    ["linkTurnedOffByAdmin", "closeStoppedLink", "Close"],
    ["decidingToAsk", "notNow", "Not now"],
    ["waitingForAdminToAccept", "closeWaiting", "Close"],
  ];
  test.each(cases)("%s: Escape and outside tap call %s", (state, action) => {
    const actions = actionsWith();
    const dialog = drawJoin(state, actions).querySelector("dialog")!;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(actions[action]).toHaveBeenCalledTimes(1);
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    dialog.click();
    expect(actions[action]).toHaveBeenCalledTimes(2);
  });

  test.each(cases)("%s opens with focus on %s's button (%s)", async (state, _action, label) => {
    const div = drawJoin(state, actionsWith());
    await tick();
    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe(label);
    expect(div.querySelector("dialog")!.contains(document.activeElement)).toBe(true);
  });
});

const photo: Photo = {
  id: "a",
  url: "blob:a",
  name: "a",
  mime: "image/jpeg",
  size: 1,
  addedAt: 0,
  member: { key: "m", name: "M" },
  holders: { here: true, others: [], unsure: [], waiting: [], previews: [], former: [], left: [] },
};

describe("Who has this photo: focus", () => {
  afterEach(() => {
    closeLightbox();
    document.body.innerHTML = "";
  });

  it("opens with focus on Close", async () => {
    openLightbox(photo);
    const el = document.createElement("div");
    document.body.append(el);
    render(lightboxView(), el);
    openHolders();
    await tick();
    const close = el.querySelector("dialog button[data-dismiss]");
    expect(document.activeElement).toBe(close);
  });

  // WebKit (iPhone, macOS) does not focus a tapped button, so the opener is body:
  // focus must still go back to the row.
  it("Close puts focus back on the row even when the row was not focused on open", async () => {
    openLightbox(photo);
    const el = document.createElement("div");
    document.body.append(el);
    render(lightboxView(), el);
    (document.activeElement as HTMLElement | null)?.blur();
    openHolders();
    await tick();
    el.querySelector<HTMLButtonElement>("dialog button[data-dismiss]")!.click();
    await vi.waitFor(() => expect(el.querySelector("dialog")).toBeNull());
    expect(el.querySelector("[data-holders-row]")).not.toBeNull();
    await tick();
    expect(document.activeElement).toBe(el.querySelector("[data-holders-row]"));
  });
});
