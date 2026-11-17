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

// The switcher routes: the screenshots are `shots` (one buffer each), the count is `count`.
function switcherWalk(
  url: string,
  opts: { shots: string[]; count: number; counts?: number[]; failing?: string[] },
) {
  const commands: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return {
      status: opts.failing?.includes(args[0] === "-e" ? "osascript" : (args[1] ?? "")) ? 1 : 0,
    };
  };
  let shot = 0;
  let counted = 0;
  const done = helperRoute(url, {
    run,
    notify: () => ({ status: 0 }),
    udid: "U",
    bundleId: "app.id",
    out: "/out",
    photoPixels: () => opts.counts?.[counted++] ?? opts.count,
    minPhotoPixels: 2000,
    read: () => Buffer.from(opts.shots[Math.min(shot++, opts.shots.length - 1)]),
    sleep: () => {},
  });
  return { done, commands, name: (i: number) => commands[i]?.[0] };
}

// The first buffer is the app before the switcher opens.
const settled = ["app", "a", "b", "b"];

test("/switcher-lock-on opens the switcher, shoots until stable, then launches Justus", () => {
  const walk = switcherWalk("/switcher-lock-on", { shots: settled, count: 0 });
  expect(walk.done).toBe(true);
  expect(walk.commands.map((command) => command[0])).toEqual([
    "xcrun",
    "osascript",
    "xcrun",
    "xcrun",
    "xcrun",
  ]);
  expect(walk.commands[2]).toEqual([
    "xcrun",
    "simctl",
    "io",
    "U",
    "screenshot",
    "/out/switcher-lock-on.png",
  ]);
  expect(walk.commands.at(-1)).toEqual(["xcrun", "simctl", "launch", "U", "app.id"]);
});

test("/switcher-lock-on fails on photo pixels, /switcher-lock-off fails on none", () => {
  expect(switcherWalk("/switcher-lock-on", { shots: settled, count: 5000 }).done).toBe(false);
  expect(switcherWalk("/switcher-lock-off", { shots: settled, count: 5000 }).done).toBe(true);
  expect(switcherWalk("/switcher-lock-off", { shots: settled, count: 1999 }).done).toBe(false);
  expect(switcherWalk("/switcher-lock-off", { shots: settled, count: 2000 }).done).toBe(true);
});

test("a switcher that never settles fails, takes at most 11 shots and still launches Justus", () => {
  const walk = switcherWalk("/switcher-lock-on", {
    shots: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
    count: 0,
    counts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  });
  expect(walk.done).toBe(false);
  expect(walk.commands.filter((command) => command[2] === "io")).toHaveLength(11);
  expect(walk.commands.at(-1)).toEqual(["xcrun", "simctl", "launch", "U", "app.id"]);
});

test("a switcher that cannot open runs nothing else", () => {
  const walk = switcherWalk("/switcher-lock-on", {
    shots: settled,
    count: 0,
    failing: ["osascript"],
  });
  expect(walk.done).toBe(false);
  expect(walk.commands.map((command) => command[0])).toEqual(["xcrun", "osascript"]);
});

test("frames that differ byte for byte settle once the photo count repeats", () => {
  const walk = switcherWalk("/switcher-lock-off", {
    shots: ["app", "a", "b", "c", "d"],
    count: 0,
    counts: [0, 4000, 9000, 9000],
  });
  expect(walk.done).toBe(true);
  expect(walk.commands.filter((command) => command[2] === "io")).toHaveLength(5);
});

test("a frame equal to the app before the switcher opened never counts as settled", () => {
  const walk = switcherWalk("/switcher-lock-on", { shots: ["app", "app", "app", "app"], count: 0 });
  expect(walk.done).toBe(false);
});

test("a failed launch fails the switcher route", () => {
  expect(
    switcherWalk("/switcher-lock-on", { shots: settled, count: 0, failing: ["launch"] }).done,
  ).toBe(false);
});

test("a failed screenshot fails the switcher route", () => {
  const before = switcherWalk("/switcher-lock-on", { shots: settled, count: 0, failing: ["io"] });
  expect(before.done).toBe(false);
  expect(before.commands.map((command) => command[0])).toEqual(["xcrun"]);
  let calls = 0;
  const commands: string[][] = [];
  const done = helperRoute("/switcher-lock-on", {
    run: (cmd: string, args: string[]) => {
      commands.push([cmd, ...args]);
      // The app frame works, every shot after the switcher opens fails.
      return { status: args[1] === "io" && calls++ > 0 ? 1 : 0 };
    },
    notify: () => ({ status: 0 }),
    udid: "U",
    bundleId: "app.id",
    out: "/out",
    photoPixels: () => 0,
    minPhotoPixels: 2000,
    read: () => Buffer.from("same"),
    sleep: () => {},
  });
  expect(done).toBe(false);
  expect(commands.filter((command) => command[2] === "io")).toHaveLength(2);
  expect(commands.at(-1)).toEqual(["xcrun", "simctl", "launch", "U", "app.id"]);
});
