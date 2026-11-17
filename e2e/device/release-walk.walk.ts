/**
 * The release walk: Ada (web, in Chromium) makes an album and copies her invite link. Ben (the release
 * APK on an emulator) opens it in Chrome, taps Open in Justus, asks to join, Ada accepts, and Ben sees
 * her photo. Run through `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh` (or the release-walk workflow).
 * Ben's words come from the copy catalogue by id, never as English written here.
 */
// @ts-nocheck: the p2p steps are untyped
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "@playwright/test";
import { copyInviteLink, createAlbum, skipIntro } from "../p2p/steps";

const catalogue = JSON.parse(
  readFileSync(new URL("../../apps/web/src/copy/en.json", import.meta.url), "utf8"),
);
const words = (id, params = {}) =>
  catalogue[id].text.replace(/\{(\w+)\}/g, (whole, k) => String(params[k] ?? whole));
// Maestro reads text as a regular expression: match the words exactly.
const exact = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The text of an id up to its first placeholder, then anything.
const startsWith = (id) => exact(catalogue[id].text.split("{")[0]) + ".*";

const ALBUM = "Walk";
const PHOTO = "walk.png";
// The invite page's button is page copy, not an app catalogue entry.
const OPEN = exact(
  /<a id="open"[^>]*>([^<]+)<\/a>/.exec(
    readFileSync(new URL("../../docs/site/public/join/index.html", import.meta.url), "utf8"),
  )[1],
);

const serial = process.env.JUSTUS_WALK_SERIAL;
const out = process.env.JUSTUS_WALK_OUT;

const STEPS = [
  `Ada makes the album “${ALBUM}” with one photo (Chromium)`,
  "Ada copies her invite link",
  "Ben opens Ada's link in Chrome; the invite page shows Open in Justus",
  `Ben taps Open in Justus; after the welcome Justus asks to join this album`,
  "Ben asks to join",
  "Ada sees Ben's request and accepts",
  "Ben sees Ada's photo",
].map((name) => ({ name, result: "not run", ms: 0, error: "" }));

function summary() {
  const failed = STEPS.findIndex((s) => s.result === "FAILED");
  const title =
    failed === -1 ? "Release walk: passed" : `Release walk: FAILED at step ${failed + 1}`;
  const rows = STEPS.map((s, i) => {
    const time = s.result === "not run" ? "" : `${Math.round(s.ms / 1000)} s`;
    return `| ${i + 1} | ${s.name} | ${s.result} | ${time} |`;
  });
  const errors = STEPS.flatMap((s, i) => (s.error ? [`Step ${i + 1}: ${s.error}`] : []));
  return [
    `### ${title}`,
    "| # | Step | Result | Time |",
    "|---|------|--------|------|",
    ...rows,
    "",
    ...errors,
    "Screenshots: download `release-walk`, see walk/maestro/<flow>/ (ben-<n>-<step>.png under takeScreenshot/, Maestro's failure shot beside it).",
    "",
  ].join("\n");
}

async function step(n, fn) {
  const s = STEPS[n - 1];
  const started = Date.now();
  s.result = "FAILED";
  try {
    await test.step(s.name, fn);
    s.result = "pass";
  } catch (error) {
    // Playwright colours its messages; keep the first line and the locator it waited for.
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

test("Ben joins Ada's album from her invite link on the release build", async ({ page: a }) => {
  if (!serial || !out) {
    throw new Error(
      "Run through `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh` (it boots the emulator and installs the release APK)",
    );
  }
  mkdirSync(out, { recursive: true });
  let link = "";
  try {
    await step(1, async () => {
      await skipIntro([a]);
      await createAlbum(a, ALBUM, PHOTO, 7);
    });
    await step(2, async () => {
      link = await copyInviteLink(a);
    });
    await step(3, () => ben("3-open-link", { LINK: link, OPEN }, 60_000));
    await step(4, () =>
      ben(
        "4-open-in-justus",
        {
          OPEN,
          SKIP: exact(words("welcome.skip")),
          YOUR_NAME: exact(words("welcome.your_name")),
          ASK_TITLE: exact(words("invite.ask_to_join_unnamed")),
        },
        120_000,
      ),
    );
    await step(5, () =>
      ben(
        "5-ask",
        { ASK: exact(words("invite.ask_to_join_2")), DONE: startsWith("invite.you_re_done") },
        60_000,
      ),
    );
    await step(6, async () => {
      // Ada is on the album's page, so the request is listed there (no toast).
      await expect(a.getByText(words("album.wants_to_join", { folderName: ALBUM }))).toBeVisible({
        timeout: 120_000,
      });
      await a
        .getByRole("button", { name: words("album.accept_as_collaborator"), exact: true })
        .click();
      await a.screenshot({ path: join(out, "ada-6-accepted.png") });
    });
    await step(7, () =>
      ben("7-sees-photo", { TILE: exact(words("gallery.view", { name: PHOTO })) }, 120_000),
    );
  } finally {
    const text = summary();
    writeFileSync(join(out, "walk-summary.md"), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
});
