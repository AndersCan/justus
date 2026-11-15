// Moves Justus back to the front: scripts/maestro-ios.mjs serves /back on the port in FACE.
if (!FACE) throw new Error("No helper: run this flow with node scripts/maestro-ios.mjs");
var response = http.get("http://127.0.0.1:" + FACE + "/back");
if (!response.ok) throw new Error("back failed: " + response.body);
