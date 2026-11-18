import { expect, test } from "vite-plus/test";
// @ts-expect-error plain script without type declarations
import { helperRoute, lockUiService } from "./maestro-ios-lib.mjs";

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

function uiWalk(lists: string[]) {
  const commands: string[][] = [];
  let pauses = 0;
  let polled = 0;
  const run = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return { status: 0 };
  };
  const capture = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return { stdout: lists[Math.min(polled++, lists.length - 1)] };
  };
  const result = lockUiService({ run, capture, pause: () => pauses++, udid: "U", limit: 3 });
  return { result, commands, pauses };
}

const start = [
  "xcrun",
  "simctl",
  "spawn",
  "U",
  "launchctl",
  "start",
  "com.apple.LocalAuthenticationUIService",
];
const list = ["xcrun", "simctl", "spawn", "U", "launchctl", "list"];
const up = "PID\tStatus\tLabel\n412\t0\tcom.apple.LocalAuthenticationUIService\n";
const down = "PID\tStatus\tLabel\n-\t0\tcom.apple.LocalAuthenticationUIService\n";

test("the UI service is started, then listed, and no pause when it is already up", () => {
  expect(uiWalk([up])).toEqual({ result: null, commands: [start, list], pauses: 0 });
});

test("it polls until the service has a pid", () => {
  const walk = uiWalk([down, "", up]);
  expect(walk.result).toBeNull();
  expect(walk.commands).toEqual([start, list, list, list]);
  expect(walk.pauses).toBe(2);
});

test("it gives up after the limit with the failure message", () => {
  const walk = uiWalk([down]);
  expect(walk.result).toBe("LocalAuthenticationUIService never started");
  expect(walk.commands).toEqual([start, list, list, list]);
  expect(walk.pauses).toBe(3);
});
