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

// Simulator's Device menu has App Switcher; the click needs Simulator.app open on the device (the
// walk opens it once after boot).
const openSwitcher = [
  "-e",
  'tell application "System Events" to tell process "Simulator" to click menu item "App Switcher" of menu "Device" of menu bar 1',
];

// /switcher-lock-on and /switcher-lock-off: open the app switcher, take screenshots 300 ms apart
// until two in a row are byte-identical, count the photo pixels in the last one, and open Justus
// again. True only when the switcher settled, Justus launched and the count matches.
function switcher(
  { run, udid, bundleId, out, photoPixels, minPhotoPixels, read, sleep },
  name,
  expected,
) {
  const file = `${out}/switcher-${name}.png`;
  if (run("osascript", openSwitcher).status !== 0) return false;
  let settled = false;
  let previous = null;
  for (let shot = 0; shot < 10 && !settled; shot++) {
    if (shot > 0) sleep(300);
    if (run("xcrun", ["simctl", "io", udid, "screenshot", file]).status !== 0) break;
    const bytes = read(file);
    settled = previous !== null && bytes.equals(previous);
    previous = bytes;
  }
  if (!settled) console.log("the switcher never settled");
  const count = settled ? photoPixels(file) : 0;
  const shows = count >= minPhotoPixels;
  console.log(
    `${file}: ${count} photo pixels (expected ${expected === "shows" ? "shows" : "none"})`,
  );
  const launched = run("xcrun", ["simctl", "launch", udid, bundleId]).status === 0;
  return settled && launched && shows === (expected === "shows");
}
