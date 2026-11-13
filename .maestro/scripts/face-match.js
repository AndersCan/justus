// Presents a matching face: scripts/maestro-ios.mjs serves /match on the port in FACE.
if (!FACE) throw new Error("No Face ID helper: run this flow with pnpm test:native:ios");
var response = http.get("http://127.0.0.1:" + FACE + "/match");
if (!response.ok) throw new Error("face: match failed: " + response.body);
console.log("face: match");
