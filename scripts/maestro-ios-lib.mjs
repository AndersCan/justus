// The walk's helper routes: /away puts Justus in the background by opening Settings, /back opens
// Justus again, /blink does both in one call, /match is a Face ID match. Returns whether the path
// is a route and every command it ran succeeded.
export function helperRoute(url, { run, notify, udid, bundleId }) {
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
  return actions[url]?.() ?? false;
}
