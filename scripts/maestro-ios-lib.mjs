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

// The Simulator starts LocalAuthenticationUIService when the first Face ID prompt asks for it; on a
// cold CI Simulator that outlasts the 5 s LAContext allows (-1000 "UI activation timed out"), so
// the first-run walk's Enable fails. Start it after boot and poll `launchctl list` until it has a
// pid, at most `limit` polls. Returns an error message, or null when it is running.
export function lockUiService({ run, capture, pause, udid, limit = 60 }) {
  const label = "com.apple.LocalAuthenticationUIService";
  const spawn = (...args) => ["simctl", "spawn", udid, "launchctl", ...args];
  run("xcrun", spawn("start", label));
  for (let poll = 0; poll < limit; poll++) {
    const listed = capture("xcrun", spawn("list"));
    const running = String(listed.stdout ?? "")
      .split("\n")
      .some((line) => line.includes("LocalAuthenticationUIService") && /^\s*\d+\s/.test(line));
    if (running) return null;
    pause();
  }
  return "LocalAuthenticationUIService never started";
}
