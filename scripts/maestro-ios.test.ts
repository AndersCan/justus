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

// The switcher routes: `shots` are the bytes each screenshot returns; `pixels` the photo count.
function switcherWalk(url: string, shots: string[], pixels: number, failing: string[] = []) {
  const commands: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return { status: failing.includes(args.at(-1) ?? "") || failing.includes(args[1]) ? 1 : 0 };
  };
  let next = 0;
  const switcher = {
    out: "out",
    minPixels: 2000,
    open: () => {
      commands.push(["open-switcher"]);
      return !failing.includes("open");
    },
    wait: () => {},
    read: () => Buffer.from(shots[Math.min(next++, shots.length - 1)]),
    count: () => pixels,
  };
  const done = helperRoute(url, {
    run,
    notify: () => ({ status: 0 }),
    udid: "U",
    bundleId: "app.id",
    switcher,
  });
  return { done, commands };
}

const shoot = ["xcrun", "simctl", "io", "U", "screenshot", "out/switcher-lock-on.png"];

test("/switcher-lock-on opens the switcher, shoots until stable, then opens Justus", () => {
  expect(switcherWalk("/switcher-lock-on", ["a", "b", "b"], 0)).toEqual({
    done: true,
    commands: [["open-switcher"], shoot, shoot, shoot, launch("app.id")],
  });
});

test("/switcher-lock-on fails when the photo shows", () => {
  expect(switcherWalk("/switcher-lock-on", ["a", "a"], 5000).done).toBe(false);
});

test("/switcher-lock-off passes with the photo and fails without it", () => {
  expect(switcherWalk("/switcher-lock-off", ["a", "a"], 5000).done).toBe(true);
  expect(switcherWalk("/switcher-lock-off", ["a", "a"], 0).done).toBe(false);
});

test("a switcher shot fails when it never settles and does not open Justus", () => {
  const shots = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
  const { done, commands } = switcherWalk("/switcher-lock-on", shots, 0);
  expect(done).toBe(false);
  expect(commands).not.toContainEqual(launch("app.id"));
});

test("a switcher shot fails when the switcher cannot open or Justus cannot be opened", () => {
  expect(switcherWalk("/switcher-lock-on", ["a", "a"], 0, ["open"]).done).toBe(false);
  expect(switcherWalk("/switcher-lock-on", ["a", "a"], 0, ["app.id"]).done).toBe(false);
  expect(switcherWalk("/switcher-lock-on", ["a", "a"], 0, ["io"]).done).toBe(false);
});

test("the switcher routes do not exist without the switcher helpers", () => {
  expect(walk("/switcher-lock-on")).toEqual({ done: false, commands: [] });
});
