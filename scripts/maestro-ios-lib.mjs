// The walk's helper routes: /away puts Justus in the background by opening Settings, /back opens
// Justus again, /blink does both in one call, /match is a Face ID match. Returns whether the path
// is a route and every command it ran succeeded.
export function helperRoute(url, context) {
  const { run, notify, udid, bundleId } = context;
  const launch = (id) => run("xcrun", ["simctl", "launch", udid, id]).status === 0;
  const settings = "com.apple.Preferences";
  // /blink: both launches in one call, so no Maestro step (slow on CI) sits between them and
  // eats into the 30 s the app allows without a lock.
  const actions = {
    "/match": () => notify(["-p", "com.apple.BiometricKit_Sim.fingerTouch.match"]).status === 0,
    "/away": () => launch(settings),
    "/back": () => launch(bundleId),
    "/blink": () => launch(settings) && launch(bundleId),
    "/switcher-lock-on": () => switcher(context, "lock-on", "hidden"),
    "/switcher-lock-off": () => switcher(context, "lock-off", "shows"),
  };
  return actions[url]?.() ?? false;
}

// Simulator.app in front, then Home (shift-command-H) twice: the app switcher on any device.
const openSwitcher = [
  "-e",
  'tell application "Simulator" to activate',
  "-e",
  "delay 1",
  "-e",
  'tell application "System Events" to tell process "Simulator" to keystroke "h" using {command down, shift down}',
  "-e",
  "delay 0.2",
  "-e",
  'tell application "System Events" to tell process "Simulator" to keystroke "h" using {command down, shift down}',
];

// /switcher-lock-on and /switcher-lock-off: open the app switcher, take screenshots 300 ms apart
// until two in a row have the same photo-pixel count (the blurred wallpaper behind the card is never
// byte-identical twice), and open Justus again. True only when the switcher settled, Justus launched and the count matches.
function switcher(
  { run, udid, bundleId, out, photoPixels, minPhotoPixels, read, sleep },
  name,
  expected,
) {
  const file = `${out}/switcher-${name}.png`;
  // The frame before the switcher opens: a settled pair only counts once it differs from this.
  if (run("xcrun", ["simctl", "io", udid, "screenshot", file]).status !== 0) return false;
  const app = read(file);
  // Run 44154667936: the keystrokes did nothing (the last shot was the app itself). So when 4 shots
  // in a row are still the app frame, press Home again; once any shot differs the switcher is
  // opening and a second press would close it. At most 3 presses, 10 shots 300 ms apart in all.
  let settled = false;
  let previous = -1;
  let count = 0;
  let opened = false;
  let presses = 0;
  for (let shot = 0; shot < 10 && !settled; shot++) {
    if (!opened && shot % 4 === 0) {
      if (run("osascript", openSwitcher).status !== 0) return false;
      presses++;
    }
    if (shot > 0) sleep(300);
    if (run("xcrun", ["simctl", "io", udid, "screenshot", file]).status !== 0) break;
    const bytes = read(file);
    count = photoPixels(file);
    opened = opened || !bytes.equals(app);
    settled = opened && count === previous;
    previous = count;
  }
  const shows = count >= minPhotoPixels;
  console.log(
    settled
      ? `${file}: ${count} photo pixels (expected ${expected === "shows" ? "shows" : "none"})`
      : `${file}: the switcher ${opened ? "never settled" : `never opened after ${presses} presses`}, no pixels counted`,
  );
  const launched = run("xcrun", ["simctl", "launch", udid, bundleId]).status === 0;
  return settled && launched && shows === (expected === "shows");
}
