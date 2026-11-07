// @ts-expect-error release-note.mjs is a plain script without type declarations
import { releaseNote } from "./release-note.mjs";
import { expect, test } from "vite-plus/test";

const fixture = [
  "Android: App lock after 30s away (#264)",
  "Keep album grid tiles in place when photos change (#270)",
  "Show the new-key album line and the update lines in the app (#269)",
  "Refuse a peer on another version and say who must update (#268)",
  "Give links from before the new key their own message (#266)",
  "Saved state version 2: every album you started moves to a new key (#261)",
  "Test accept and decline of a join request in two browsers (#267)",
  "Bound peer record reads so a vanished peer cannot hang requests() (#265)",
  "Ask to join through the new invite link: join screens, ask rows, Accept and Decline (#259)",
  "ci: run Android emulator tests on pull requests that touch the app (#262)",
  "Add App lock card to Settings (Android host only) (#263)",
  "Add the justus/version peer channel (#260)",
];

test("keeps (#n) subjects and strips the suffix", () => {
  expect(releaseNote(["Fix crash (#1)"])).toBe("Fix crash.");
});

test("returns only titles with a PR number", () => {
  expect(releaseNote(["Fix crash", "Add thing (#2)"])).toBe("Add thing.");
});

test("returns the fallback when only internal titles remain", () => {
  expect(
    releaseNote([
      "ci: speed up (#1)",
      "test: more (#2)",
      "chore(android): tidy (#3)",
      "docs: words (#4)",
      "refactor!: rename (#5)",
      "vision: new (#6)",
      "Bump @mantaq/inspect to 0.5.1 (#249)",
    ]),
  ).toBe("Bug fixes and improvements.");
});

test("returns titles without the Android prefix", () => {
  expect(releaseNote(["Android: App lock (#1)"])).toBe("App lock.");
});

test("adds an and-N-more tail when only some titles fit", () => {
  const a = "a".repeat(50);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const line = releaseNote([`${a} (#1)`, `${b} (#2)`, `${c} (#3)`]);
  expect(line).toBe(`${a}; ${b}; and 1 more.`);
});

test("returns a line ending in a period when all titles fit", () => {
  expect(releaseNote(["One (#1)", "Two (#2)"])).toBe("One; Two.");
});

test("returns a long title cut with an ellipsis to 120 characters", () => {
  const line = releaseNote([`${"x".repeat(200)} (#1)`]);
  expect(line).toBe(`${"x".repeat(118)}….`);
});

test("returns the fallback note when nothing is kept", () => {
  expect(releaseNote([])).toBe("Bug fixes and improvements.");
  expect(releaseNote(["no pr here"])).toBe("Bug fixes and improvements.");
});

test("returns two titles and a count for the real v0.2.1..654b64e history", () => {
  expect(releaseNote(fixture)).toBe(
    "App lock after 30s away; Keep album grid tiles in place when photos change; and 9 more.",
  );
});
