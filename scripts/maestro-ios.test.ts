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
function switcherWalk(url: string, opts: { shots: string[]; count: number; failing?: string[] }) {
  const commands: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return {
      status: opts.failing?.includes(args[0] === "-e" ? "osascript" : (args[1] ?? "")) ? 1 : 0,
    };
  };
  let shot = 0;
  const done = helperRoute(url, {
    run,
    notify: () => ({ status: 0 }),
    udid: "U",
    bundleId: "app.id",
    out: "/out",
    photoPixels: () => opts.count,
    minPhotoPixels: 2000,
    read: () => Buffer.from(opts.shots[Math.min(shot++, opts.shots.length - 1)]),
    sleep: () => {},
  });
  return { done, commands, name: (i: number) => commands[i]?.[0] };
}

const settled = ["a", "b", "b"];

test("/switcher-lock-on opens the switcher, shoots until stable, then launches Justus", () => {
  const walk = switcherWalk("/switcher-lock-on", { shots: settled, count: 0 });
  expect(walk.done).toBe(true);
  expect(walk.commands.map((command) => command[0])).toEqual([
    "osascript",
    "xcrun",
    "xcrun",
    "xcrun",
    "xcrun",
  ]);
  expect(walk.commands[1]).toEqual([
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

test("a switcher that never settles fails, takes at most 10 shots and still launches Justus", () => {
  const walk = switcherWalk("/switcher-lock-on", {
    shots: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
    count: 0,
  });
  expect(walk.done).toBe(false);
  expect(walk.commands.filter((command) => command[2] === "io")).toHaveLength(10);
  expect(walk.commands.at(-1)).toEqual(["xcrun", "simctl", "launch", "U", "app.id"]);
});

test("a switcher that cannot open runs nothing else", () => {
  const walk = switcherWalk("/switcher-lock-on", {
    shots: settled,
    count: 0,
    failing: ["osascript"],
  });
  expect(walk.done).toBe(false);
  expect(walk.commands).toHaveLength(1);
});

test("a failed launch fails the switcher route", () => {
  expect(
    switcherWalk("/switcher-lock-on", { shots: settled, count: 0, failing: ["launch"] }).done,
  ).toBe(false);
});
