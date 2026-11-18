import { expect, test } from "vite-plus/test";
// @ts-expect-error plain script without type declarations
import { helperRoute } from "./maestro-ios-lib.mjs";

const settings = "com.apple.Preferences";

// Records each command; a command fails when its last argument is in `failing`.
function walk(url: string, failing: string[] = []) {
  const commands: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return { status: failing.includes(args.at(-1) ?? "") ? 1 : 0 };
  };
  const notify = (args: string[]) => {
    commands.push(["notify", ...args]);
    return { status: failing.includes("notify") ? 1 : 0 };
  };
  const done = helperRoute(url, { run, notify, udid: "U", bundleId: "app.id" });
  return { done, commands };
}

const launch = (id: string) => ["xcrun", "simctl", "launch", "U", id];

test("/away opens Settings", () => {
  expect(walk("/away")).toEqual({ done: true, commands: [launch(settings)] });
});

test("/back opens Justus", () => {
  expect(walk("/back")).toEqual({ done: true, commands: [launch("app.id")] });
});

test("/blink opens Settings, then Justus", () => {
  expect(walk("/blink")).toEqual({ done: true, commands: [launch(settings), launch("app.id")] });
});

test("/match sends the Face ID match", () => {
  expect(walk("/match")).toEqual({
    done: true,
    commands: [["notify", "-p", "com.apple.BiometricKit_Sim.fingerTouch.match"]],
  });
});

test("/blink fails when the first launch fails and does not open Justus", () => {
  expect(walk("/blink", [settings])).toEqual({ done: false, commands: [launch(settings)] });
});

test("/blink fails when the second launch fails", () => {
  expect(walk("/blink", ["app.id"]).done).toBe(false);
});

test("a failing command fails /away, /back and /match", () => {
  expect(walk("/away", [settings]).done).toBe(false);
  expect(walk("/back", ["app.id"]).done).toBe(false);
  expect(walk("/match", ["notify"]).done).toBe(false);
});

test("an unknown path is not a route and runs nothing", () => {
  expect(walk("/nope")).toEqual({ done: false, commands: [] });
  expect(walk("/toString")).toEqual({ done: false, commands: [] });
});
