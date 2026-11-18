// @vitest-environment happy-dom
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { render } from "lit-html";
import { inspectFile } from "@mantaq/inspect";
import type { JoinView } from "./join-request";
import { albumNoticeText, joinedText, whoLeftText } from "../../views/notices";
import { renderJoinSheet } from "../../views/join-sheet";

const ROOT = join(import.meta.dirname, "../../../../..");

type Row = { title: string; fail: string };

async function statesOf(id: string, file: string) {
  const loaded = await inspectFile(join(ROOT, file), { fuzz: false });
  const found = loaded.machines.find((m) => m.id === id);
  if (found === undefined) throw new Error(`could not read ${id} from ${file}`);
  return found.states;
}

/** A machine's endings are its final states; a screen machine that takes the next link has none, so every state counts. */
function ends(states: { id: string; final?: boolean }[]) {
  const finals = states.filter((s) => s.final === true);
  return (finals.length > 0 ? finals : states).map((s) => s.id);
}

const joinStates = ends(
  await statesOf("joinRequest", "apps/web/src/machines/sharing/join-request-machine.ts"),
);
const membershipStates = ends(
  await statesOf("membership", "apps/backend/src/membership/membership-machine.ts"),
);

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
const SAMPLE = { code: "a".repeat(64), owner: "b".repeat(64), album: "Holiday", ownerName: "Nils" };

/** Join states that draw no sheet, each with the reason. */
const NO_SHEET: Record<string, string> = {
  noInviteOpen: "no invite is open",
  showingWelcome: "the welcome is on screen",
  holdingInviteUntilWelcomeEnds: "the welcome is on screen; the question opens when it ends",
  checkingPastedLink: "the paste box button reads Checking the link…",
  sendingPastedRequest: "the paste box button reads Asking…",
  showingLinkProblem: "the paste box shows the problem line",
  alreadyInAlbum: "the album this phone is already in opens",
};

/** Join states whose words are not on the join sheet, and the line that shows them. */
const OFF_SHEET: Record<string, () => string[]> = {
  joinedAlbum: () => [joinedText("Holiday")],
};

/** Endings that show no words today. The list only shrinks; it is empty now. */
const SILENT_TODAY: Record<string, string> = {};

function joinLines(state: string): string[] {
  const div = document.createElement("div");
  render(
    renderJoinSheet({ state: state as JoinView["state"], invite: SAMPLE, error: "" }, actions),
    div,
  );
  return [...div.querySelectorAll("dialog h3, dialog p")].map((el) =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

function row(name: string, lines: () => string[]): Row {
  const noSheet = NO_SHEET[name.split(".")[1] ?? ""];
  if (name.startsWith("joinRequest.") && noSheet !== undefined) {
    return { title: `${name}: no sheet, ${noSheet}`, fail: "" };
  }
  const silent = SILENT_TODAY[name];
  let found: string[] = [];
  let reason = "";
  try {
    found = lines();
    if (found.length === 0 || found.some((l) => l.trim() === "")) reason = "no line is shown";
  } catch (error) {
    reason = `threw: ${String(error)}`;
  }
  if (reason === "") {
    return {
      title: `${name}: ${found.join(" · ")}`,
      fail: "",
    };
  }
  if (silent !== undefined) {
    return { title: `${name}: silent today (roadmap Next 5), ${silent}`, fail: "" };
  }
  return {
    title: `${name}: NO LINE, ${reason}`,
    fail: `${name} shows no plain-words line (${reason}). Write its line in en.json and its view, or, if a person truly reads nothing here, add it to NO_SHEET with why.`,
  };
}

const rows = [
  ...joinStates.map((s) => row(`joinRequest.${s}`, OFF_SHEET[s] ?? (() => joinLines(s)))),
  // The Admin reads who left on the album (views/notices.ts whoLeftText).
  ...membershipStates.map((s) => row(`membership.${s}`, () => [whoLeftText("Ben")])),
  row("albumNotice.removed", () => [albumNoticeText({ kind: "removed" }, "Holiday") ?? ""]),
];

for (const { title, fail } of rows) test(title, () => expect(fail).toBe(""));
