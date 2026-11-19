/**
 * The update walk: Ben's emulator has the last release (JUSTUS_WALK_FROM, built by
 * scripts/walk-from.sh). Ada runs that release's own server and makes the album "Walk"; Ben joins and
 * opens her photo. Then this build installs over his (`adb install -r`, no uninstall) and Ben must still
 * have Walk and the photo. Ada stays on the old release: nothing here checks a sync across versions.
 * Run through `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh` (or the release-walk workflow).
 * Before the update Ben's words come from the old release's catalogue, after it from this one's.
 */
// @ts-nocheck: the p2p steps are untyped
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "@playwright/test";
import { isPortInUse } from "../../apps/backend/scripts/port-utils.mjs";
import { copyInviteLink, createAlbum, skipIntro } from "../p2p/steps";

const serial = process.env.JUSTUS_WALK_SERIAL;
const out = process.env.JUSTUS_WALK_OUT;
const apk = process.env.JUSTUS_WALK_APK;
const adb = process.env.JUSTUS_WALK_ADB;
const from = process.env.JUSTUS_WALK_FROM;
const tag = process.env.JUSTUS_WALK_FROM_TAG;
const APP = "no.cankode.justus";

const catalogueOf = (root) =>
  JSON.parse(readFileSync(join(root, "apps/web/src/copy/en.json"), "utf8"));
const wordsFrom =
  (catalogue, which) =>
  (id, params = {}) => {
    if (!catalogue[id]) throw new Error(`the ${which} build has no copy id "${id}"`);
    return catalogue[id].text.replace(/\{(\w+)\}/g, (whole, k) => String(params[k] ?? whole));
  };
// Maestro reads text as a regular expression: match the words exactly.
const exact = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (words, id) => exact(words(id).split("{")[0]) + ".*";

const ALBUM = "Walk";
const PHOTO = "walk.png";
const BEN = "Ben";
// The invite page's button is page copy, not an app catalogue entry.
const OPEN = exact(
  /<a id="open"[^>]*>([^<]+)<\/a>/.exec(
    readFileSync(new URL("../../docs/site/public/join/index.html", import.meta.url), "utf8"),
  )[1],
);

const rows = [
  `Ada makes the album “${ALBUM}” with one photo on ${tag} and copies her invite link (Chromium)`,
  `Ben, on ${tag}, joins her album and opens her photo`,
  "This build installs over Ben's phone without uninstalling",
  `Ben's phone still has the album “${ALBUM}” and the photo ${PHOTO}`,
].map((name) => ({ name, result: "not run", ms: 0, error: "" }));

function summary() {
  const failed = rows.findIndex((s) => s.result === "FAILED");
  const title =
    failed === -1
      ? `Update walk from ${tag}: passed`
      : `Update walk from ${tag}: FAILED at step ${failed + 1}`;
  const lines = rows.map((s, i) => {
    const time = s.result === "not run" ? "" : `${Math.round(s.ms / 1000)} s`;
    return `| ${i + 1} | ${s.name} | ${s.result} | ${time} |`;
  });
  const errors = rows.flatMap((s, i) => (s.error ? [`Step ${i + 1}: ${s.error}`] : []));
  return [
    `### ${title}`,
    "| # | Step | Result | Time |",
    "|---|------|--------|------|",
    ...lines,
    "",
    ...errors,
    "Screenshots: download `release-walk`, see walk-update/maestro/<flow>/.",
    "",
  ].join("\n");
}

async function step(n, fn) {
  const s = rows[n - 1];
  const started = Date.now();
  s.result = "FAILED";
  try {
    await test.step(s.name, fn);
    s.result = "pass";
  } catch (error) {
    const lines = stripVTControlCharacters(String(error?.message ?? error)).split("\n");
    s.error = [lines[0], lines.find((l) => l.trim().startsWith("Locator:"))?.trim()]
      .filter(Boolean)
      .join(" ");
    throw error;
  } finally {
    s.ms = Date.now() - started;
  }
}

// Ben's phone: one short Maestro flow, no shell. The flow's own timeouts are the step budget.
function ben(flow, env, budgetMs) {
  const args = ["--device", serial, "test", "--test-output-dir", join(out, "maestro", flow)];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(join(".maestro", "walk", `${flow}.yaml`));
  return new Promise((resolve, reject) => {
    const child = spawn("maestro", args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const take = (chunk) => {
      log += chunk;
      process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), budgetMs + 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      mkdirSync(join(out, "maestro"), { recursive: true });
      writeFileSync(join(out, "maestro", `${flow}.txt`), log);
      if (code === 0) return resolve();
      const line = log
        .split("\n")
        .filter((l) => /FAILED|Assertion|not found/i.test(l))
        .pop();
      reject(new Error(`Ben's phone: ${line?.trim() ?? flow} (exit ${code})`));
    });
  });
}

// Ada on the last release: that tag's own e2e server, on the port the web page talks to.
async function startOldAda() {
  const log = openSync(join(out, "ada-old.log"), "w");
  const child = spawn("node", ["scripts/e2e-server.mjs"], {
    cwd: from,
    stdio: ["ignore", log, log],
  });
  const stop = async () => {
    child.kill("SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await isPortInUse(8091))) {
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (
      await fetch("http://127.0.0.1:8091/index.html").then(
        (r) => r.ok,
        () => false,
      )
    )
      return stop;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  throw new Error(`Ada's ${tag} did not start in 180 s: see walk-update/ada-old.log`);
}

function adbRun(...args) {
  const r = spawnSync(adb, ["-s", serial, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, text: `${r.stdout}${r.stderr}`.trim() };
}

test(`Ben's album and photo survive an update from ${tag}`, async ({ page: a }) => {
  if (!serial || !out || !apk || !adb || !from || !tag) {
    throw new Error(
      "Run through `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh` (it builds the last release and boots the emulator)",
    );
  }
  mkdirSync(out, { recursive: true });
  const before = wordsFrom(catalogueOf(from), tag);
  const after = wordsFrom(catalogueOf(process.cwd()), "this");
  let stopAda = async () => {};
  let link = "";
  try {
    await step(1, async () => {
      // Ben's phone starts from the last release, with nothing of an earlier walk on it.
      adbRun("uninstall", APP);
      const old = join(from, "apps/android/app/build/outputs/apk/release/app-release.apk");
      const installed = adbRun("install", old);
      if (!installed.ok)
        throw new Error(`could not install ${tag} on Ben's phone: ${installed.text}`);
      stopAda = await startOldAda();
      await skipIntro([a]);
      await createAlbum(a, ALBUM, PHOTO, 7);
      link = await copyInviteLink(a);
    });
    await step(2, async () => {
      await ben("3-open-link", { LINK: link, OPEN }, 60_000);
      await ben(
        "4-open-in-justus",
        {
          OPEN,
          NAME: BEN,
          SKIP: exact(before("welcome.skip")),
          YOUR_NAME: exact(before("welcome.your_name")),
          ASK_TITLE: exact(before("invite.ask_to_join_2")),
        },
        120_000,
      );
      await ben(
        "5-ask",
        {
          ASK: exact(before("invite.ask_to_join_2")),
          DONE: startsWith(before, "invite.you_re_done"),
        },
        60_000,
      );
      await expect(a.getByText(before("album.wants_to_join", { folderName: ALBUM }))).toBeVisible({
        timeout: 120_000,
      });
      await a
        .getByRole("button", { name: before("album.accept_as_collaborator"), exact: true })
        .click();
      await ben("7-sees-photo", { TILE: exact(before("gallery.view", { name: PHOTO })) }, 120_000);
      await ben("8-opens-photo", { TILE: exact(before("gallery.view", { name: PHOTO })) }, 60_000);
    });
    await step(3, async () => {
      // Ada is done: nothing in this walk talks to her after the update.
      await stopAda();
      const updated = adbRun("install", "-r", apk);
      if (!updated.ok) throw new Error(`adb install -r failed on Ben's phone: ${updated.text}`);
    });
    await step(4, () =>
      ben(
        "update-opens",
        {
          SHARING: exact(after("app.sharing")),
          ALBUM: exact(ALBUM),
          SEE_PHOTOS: exact(after("album.see_photos_in_this_album")),
          TILE: exact(after("gallery.view", { name: PHOTO })),
        },
        120_000,
      ),
    );
  } finally {
    await stopAda();
    const text = summary();
    writeFileSync(join(out, "update-walk-summary.md"), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
});
