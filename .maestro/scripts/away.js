// Moves Justus to the background: scripts/maestro-ios.mjs serves /away on the port in FACE.
if (!FACE) throw new Error("No helper: run this flow with node scripts/maestro-ios.mjs");
var response = http.get("http://127.0.0.1:" + FACE + "/away");
if (!response.ok) throw new Error("away failed: " + response.body);
