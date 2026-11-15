// Opens Settings over Justus and Justus again in one call: scripts/maestro-ios.mjs serves /blink on the port in FACE.
if (!FACE) throw new Error("No helper: run this flow with node scripts/maestro-ios.mjs");
var response = http.get("http://127.0.0.1:" + FACE + "/blink");
if (!response.ok) throw new Error("blink failed: " + response.body);
