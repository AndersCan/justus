// The walk's helper routes: /away puts Justus in the background by opening Settings, /back opens
// Justus again, /blink does both in one call, /match is a Face ID match. Returns whether the path
// is a route and every command it ran succeeded.
export function helperRoute(url, { run, notify, udid, bundleId, switcher }) {
  const launch = (id) => run("xcrun", ["simctl", "launch", udid, id]).status === 0;
  const settings = "com.apple.Preferences";
  // /blink: both launches in one call, so no Maestro step (slow on CI) sits between them and
  // eats into the 30 s the app allows without a lock.
  const actions = {
    "/match": () => notify(["-p", "com.apple.BiometricKit_Sim.fingerTouch.match"]).status === 0,
    "/away": () => launch(settings),
    "/back": () => launch(bundleId),
    "/blink": () => launch(settings) && launch(bundleId),
  };
  if (switcher) {
    actions["/switcher-lock-on"] = () => switcherShot("lock-on", false);
    actions["/switcher-lock-off"] = () => switcherShot("lock-off", true);
  }
  return actions[url]?.() ?? false;

  // Opens the app switcher from the Simulator's Device menu, shoots until two shots in a row are
  // identical, counts the test photo's pixels, and returns to Justus. True only when the count
  // matches `shows` and every command worked.
  function switcherShot(name, shows) {
    const { out, open, read, count, minPixels, wait } = switcher;
    const file = `${out}/switcher-${name}.png`;
    if (!open()) return false;
    let before = null;
    let settled = false;
    for (let attempt = 0; attempt < 10 && !settled; attempt++) {
      wait(300);
      if (run("xcrun", ["simctl", "io", udid, "screenshot", file]).status !== 0) return false;
      const bytes = read(file);
      settled = before !== null && bytes.equals(before);
      before = bytes;
    }
    if (!settled) {
      console.error("the switcher never settled");
      return false;
    }
    const pixels = count(file);
    console.log(`${file}: ${pixels} photo pixels (expected ${shows ? "shows" : "none"})`);
    return launch(bundleId) && pixels >= minPixels === shows;
  }
}
