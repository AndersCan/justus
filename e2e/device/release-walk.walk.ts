/**
 * The release walk: Ada (web, in Chromium) makes an album and copies her invite link. Ben (the release
 * APK on an emulator) opens it in Chrome, taps Open in Justus, asks to join, Ada accepts, and Ben sees
 * her photo, opens it, and Ada's photo says it is on Ben's phone. Then Ada's phone goes off and Ben's
 * Members list says so, and back. Ben opens Leave album and the Keep button holds the sheet's words.
 * Ben's app is recorded from its start (apk-network.mjs). Run through
 * `JUSTUS_WALK=1 bash scripts/maestro-e2e.sh` (or the release-walk workflow).
 * Ben's words come from the copy catalogue by id, never as English written here.
 */
// @ts-nocheck: the p2p steps are untyped
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "@playwright/test";
import { recordApkNetwork, traceFacts } from "./apk-network.mjs";
import { networkInterfaces } from "node:os";
import { apkAddressReport } from "../hub/apk-trace.mjs";
import {
  copyInviteLink,
  createAlbum,
  pausePhone,
  resumeAll,
  setName,
  skipIntro,
} from "../p2p/steps";

const catalogue = JSON.parse(
  readFileSync(new URL("../../apps/web/src/copy/en.json", import.meta.url), "utf8"),
);
const words = (id, params = {}) =>
  catalogue[id].text.replace(/\{(\w+)\}/g, (whole, k) => String(params[k] ?? whole));
// Maestro reads text as a regular expression: match the words exactly.
const exact = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The text of an id up to its first placeholder, then anything.
const startsWith = (id) => exact(catalogue[id].text.split("{")[0]) + ".*";

const ADA = "Ada";
const phoneOff = (when) =>
  words("people.phone_off_last_seen", { when: words("people.last_seen", { when }) });
// Off for 30-60 s reads "just now", then "1 min ago": the two cover the first 2 minutes.
const OFF_WORDS = [phoneOff(words("time.just_now")), phoneOff(words("time.min_ago", { min: 1 }))];
// Maestro reads the whole Members row as one text, so match the words inside it, exactly once. Never a
// prefix such as "Phone off.*": it would match the footer's "Phone off means ...". Starting at Ada's name,
// not followed by a comma, keeps the status line "<name>, Phone off, ..." from matching.
const OFF_ANY = OFF_WORDS.map(exact).join("|");
const ROW_ONCE = `${exact(ADA)}(?!, )(?!.*(?:${OFF_ANY}).*(?:${OFF_ANY})).*(?:${OFF_ANY}).*`;
const CONNECTED_NOW = words("gallery.connected_now", { connected: 1 });

const ALBUM = "Walk";
const PHOTO = "walk.png";
const BEN = "Ben";
const LEAVE_TITLE = words("album.leave", { name: ALBUM });
// Ben added nothing to the album.
const LEAVE_DETAIL =
  words("album.leave_no_photos_added") + words("album.leave_come_back", { adminName: ADA });
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
  "Ben opens Ada's photo",
  `Ada reads “${words("holders.on_and_your_phone", { names: `${BEN}'s` })}” on her photo`,
  `Ada's phone goes off; with her photo open the page behind is out of reach; Ben closes it, opens Members and reads “${OFF_WORDS[0]}” or “${OFF_WORDS[1]}” once`,
  `Ada's phone comes back; Ben's album reads “${CONNECTED_NOW}”`,
  `Ben opens Leave album; TalkBack's tree holds “${LEAVE_TITLE}” and its text on the focused Keep`,
  "Ben's APK sent only to Ada's phone and DHT nodes, from its start to the end of the walk",
].map((name) => ({ name, result: "not run", ms: 0, error: "" }));

let record = "";

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
    ...(record ? [record, ""] : []),
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
  let recorder;
  try {
    await step(1, async () => {
      await skipIntro([a]);
      await setName(a, ADA);
      await createAlbum(a, ALBUM, PHOTO, 7);
    });
    await step(2, async () => {
      link = await copyInviteLink(a);
    });
    await step(3, () => ben("3-open-link", { LINK: link, OPEN }, 60_000));
    recorder = recordApkNetwork({
      adb: process.env.JUSTUS_WALK_ADB ?? "adb",
      serial,
      app: "no.cankode.justus",
    });
    await step(4, () =>
      ben(
        "4-open-in-justus",
        {
          OPEN,
          NAME: BEN,
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
        {
          ASK: exact(words("invite.ask_to_join_2")),
          DONE: startsWith("invite.waiting_for_to_let_you_in"),
        },
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
    await step(8, () =>
      ben("8-opens-photo", { TILE: exact(words("gallery.view", { name: PHOTO })) }, 60_000),
    );
    await step(9, async () => {
      try {
        await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
        await expect(a).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
        await a
          .getByRole("button", { name: words("gallery.view", { name: PHOTO }), exact: true })
          .click();
        // 120 s: Ben's phone reports it holds the photo; the wait ends when the text matches.
        await expect(a.locator(".justus-holders-text")).toHaveText(
          words("holders.on_and_your_phone", { names: `${BEN}'s` }),
          { timeout: 120_000 },
        );
      } finally {
        await a.screenshot({ path: join(out, "ada-9-holders.png") });
      }
    });
    let resumeAda = () => {};
    await step(10, async () => {
      resumeAda = await pausePhone({ port: Number(new URL(a.url()).port) });
      await ben(
        "10-ada-off",
        {
          CLOSE: exact(words("lightbox.close")),
          MEMBERS: exact(words("gallery.invite_members")),
          EVERYONE: exact(words("album.everyone_in_the_album_sees")),
          PHOTOS_TAB: exact(words("app.photos")),
          ROW_ONCE,
        },
        150_000,
      );
    });
    await step(11, async () => {
      resumeAda();
      await ben(
        "11-ada-back",
        {
          CONNECTED_NOW: exact(CONNECTED_NOW),
        },
        120_000,
      );
    });
    await step(12, () =>
      ben(
        "12-leave-sheet",
        {
          TILE: exact(words("gallery.view", { name: PHOTO })),
          MEMBERS: exact(words("gallery.invite_members")),
          MORE: exact(words("album.more_options")),
          LEAVE_ITEM: exact(words("album.leave_album")),
          LEAVE_TITLE: exact(LEAVE_TITLE),
          LEAVE_DETAIL: exact(LEAVE_DETAIL),
        },
        60_000,
      ),
    );
    await step(13, async () => {
      const seen = await recorder.stop();
      if (seen.error) throw new Error(`Ben's app could not be recorded: ${seen.error}`);
      const state = await (await a.context().request.get(new URL("/__state", a.url()).href)).json();
      const ports = Object.keys(state.addresses.bound).map((addr) => Number(addr.split(":").pop()));
      const hosts = [
        "10.0.2.2",
        ...Object.values(networkInterfaces()).flatMap((list) => list.map((i) => i.address)),
      ];
      const report = apkAddressReport({
        trace: seen.trace,
        ada: { hosts: new Set(hosts), ports: new Set(ports) },
      });
      if (report.outside.length > 0) {
        writeFileSync(join(out, "apk-trace.txt"), seen.trace);
        throw new Error(report.outside.join("; "));
      }
      STEPS.at(-1).name =
        `Ben's APK sent only to Ada's phone at ${report.adaAddresses.join(", ")} (${report.adaStream} stream packets) and ${report.dhtNodes} DHT nodes. Outside: none`;
    });
  } finally {
    resumeAll();
    if (recorder) {
      const seen = await recorder.stop();
      const facts = traceFacts(seen.trace);
      record = seen.error
        ? `Ben's app could not be recorded: ${seen.error}`
        : `Ben's app (pid ${seen.pid}) recorded: ${facts.lines} lines, ${facts.binds} binds, ${facts.dhtMessages} DHT messages, ${facts.streamPackets} stream packets.`;
    }
    const text = summary();
    writeFileSync(join(out, "walk-summary.md"), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
});
