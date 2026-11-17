// Opens the app switcher and checks the picture: scripts/maestro-ios.mjs serves /switcher-<SHOT> on the port in FACE.
if (!FACE) throw new Error("No helper: run this flow with node scripts/maestro-ios.mjs");
var response = http.get("http://127.0.0.1:" + FACE + "/switcher-" + SHOT);
if (!response.ok) throw new Error("switcher " + SHOT + " failed: " + response.body);
