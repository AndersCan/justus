// Face ID helpers for scripts/maestro-ios.mjs: enrol a face on a Simulator, and a small HTTP
// helper the Maestro flow calls (.maestro/scripts/face-match.js) to present a matching face.
import { execFile } from "node:child_process";
import { createServer } from "node:http";

const enrolment = "com.apple.BiometricKit.enrollmentChanged";
const matchNotification = "com.apple.BiometricKit_Sim.fingerTouch.match";

// "/match" maps to the match notification, any other path to null.
export function faceRoute(path) {
  return path === "/match" ? "match" : null;
}

function xcrun(args, env) {
  return new Promise((resolve) => {
    execFile("xcrun", args, { env, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr: stderr || (error ? error.message : "") });
    });
  });
}

function notifyutil(udid, args, env) {
  return xcrun(["simctl", "spawn", udid, "notifyutil", ...args], env);
}

// The enrolment state notifyutil prints, "name 1" -> true.
export function parseEnrolled(output) {
  return output.trim().split(/\s+/).at(-1) === "1";
}

export async function readEnrolled(udid, env = process.env) {
  const result = await notifyutil(udid, ["-g", enrolment], env);
  return result.ok && parseEnrolled(result.stdout);
}

export async function setEnrolled(udid, enrolled, env = process.env) {
  await notifyutil(udid, ["-s", enrolment, enrolled ? "1" : "0"], env);
  await notifyutil(udid, ["-p", enrolment], env);
  return (await readEnrolled(udid, env)) === enrolled;
}

// Serves GET /match: posts the matching-face notification. 200 on success, 404 for other
// paths, 500 with the error text when xcrun fails. Resolves to { port, close }.
export function startFaceHelper(udid, env = process.env) {
  const server = createServer(async (request, response) => {
    if (faceRoute(request.url) !== "match") {
      response.writeHead(404).end("not found");
      return;
    }
    const result = await notifyutil(udid, ["-p", matchNotification], env);
    response.writeHead(result.ok ? 200 : 500).end(result.ok ? "match" : result.stderr);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}
