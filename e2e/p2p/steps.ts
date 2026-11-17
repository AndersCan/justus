// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { listenerPids, portHeldBy } from "../../apps/backend/scripts/port-utils.mjs";
import { readFileSync } from "node:fs";

export async function skipIntro(pages) {
  for (const page of pages) {
    await page.addInitScript(() => localStorage.setItem("justus:welcome-seen", "1"));
  }
}

export async function createAlbum(a, name, file, colour) {
  await a.goto("/sharing");
  await a.getByLabel("Album name").fill(name);
  await a.getByRole("button", { name: "Create album" }).click();
  await expect(a).toHaveURL(/\/sharing\/[^/]+$/, { timeout: 20_000 });
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(a).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await a.setInputFiles("input[type=file]", {
    name: file,
    mimeType: "image/png",
    buffer: pngOf(...runColour(colour)),
  });
  await expect(a.getByRole("button", { name: `View ${file}` }).locator("img")).toBeAttached({
    timeout: 20_000,
  });
}

export async function copyInviteLink(a) {
  await a.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  await a.evaluate(() => navigator.clipboard.writeText(""));
  await a.getByRole("button", { name: /^(Copy invite link|Copy link)$/ }).click();
  await expect
    .poll(() => a.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^https:\/\/anderscan\.github\.io\/justus\/join\/#i=/);
  const link = await a.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^https:\/\/anderscan\.github\.io\/justus\/join\/#i=/);
  expect(link).toMatch(/[#&]e=\d+/);
  return link;
}

export async function askToJoin(b, link, _album) {
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(link);
  await b.getByRole("button", { name: "Ask to join", exact: true }).click();
  await expect(b.getByRole("dialog", { name: /^You're done\. / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0, { timeout: 20_000 });
}

const catalogue = JSON.parse(
  readFileSync(new URL("../../apps/web/src/copy/en.json", import.meta.url), "utf8"),
);

/** The catalogue text for a copy id, filled the way the app's copy() does ({name}, {n?one:other}). copy.ts does not load in Playwright (lit-html, import.meta.env). */
export function words(id, params = {}) {
  const entry = catalogue[id];
  if (entry === undefined) throw new Error(`no copy id ${id}`);
  return entry.text.replace(/\{(\w+)(?:\?([^:}]*):([^}]*))?\}/g, (whole, key, one, other) => {
    const value = params[key];
    if (value === undefined) return whole;
    if (one === undefined) return String(value);
    return Number(value) === 1 ? one : other;
  });
}

const paused = new Set();

/** Pauses an instance's backend so the other phones lose it; returns a function that resumes it. `resumeAll()` resumes every paused instance. */
export async function pausePhone(instance) {
  const pids = (await listenerPids(instance.port)).map(Number);
  if (pids.length === 0) {
    throw new Error(`no process listens on port ${instance.port} (is lsof installed?)`);
  }
  if (!(await portHeldBy(instance.port, /\/apps\/backend\/dist\/main\.core\.gen\.js/))) {
    throw new Error(`port ${instance.port} is not a Justus worklet`);
  }
  for (const pid of pids) {
    process.kill(pid, "SIGSTOP");
    paused.add(pid);
  }
  return () => resume(pids);
}

function resume(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGCONT");
    } catch {
      // already gone
    }
    paused.delete(pid);
  }
}

export function resumeAll() {
  resume([...paused]);
}
