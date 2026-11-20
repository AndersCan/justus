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
  await a.getByRole("button", { name: /^(Copy invite link|Copy link|Make a new link)$/ }).click();
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
  await expect(
    b.getByRole("dialog", { name: pattern("invite.waiting_for_to_let_you_in") }),
  ).toBeVisible({ timeout: 20_000 });
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

/** The text of a copy id as a pattern, anything standing for each placeholder. */
export function pattern(id) {
  return new RegExp(
    catalogue[id].text
      .split(/\{\w+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+"),
  );
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

const WORKLET = /\/apps\/backend\/dist\/main\.core\.gen\.js/;

/** Restarts a phone the way the app restarts: its backend stops and starts again on the same storage (the hub starts it; `beforeKill` runs first, for a change to its storage), and its page opens afresh at /index.html. */
export async function restartPhone(page, instance, { beforeKill = () => {} } = {}) {
  const old = (await listenerPids(instance.port)).map(Number);
  if (old.some((pid) => paused.has(pid))) {
    throw new Error(`${instance.id} is paused; resume it before restarting it`);
  }
  if (old.length === 0 || !(await portHeldBy(instance.port, WORKLET))) {
    throw new Error(`port ${instance.port} is not a Justus worklet`);
  }
  // The hub starts it again at once, so a change to its storage is made before the kill.
  await beforeKill();
  for (const pid of old) process.kill(pid, "SIGKILL");
  // 30 s: the worklet binds again in 0.2-0.4 s; one stuck reading an absent phone never binds.
  await expect
    .poll(
      async () => {
        const now = (await listenerPids(instance.port)).map(Number);
        return (
          now.length > 0 &&
          now.every((pid) => !old.includes(pid)) &&
          (await portHeldBy(instance.port, WORKLET))
        );
      },
      {
        message: `${instance.id} did not start again within 30 s`,
        timeout: 30_000,
        intervals: [100],
      },
    )
    .toBe(true);
  // A phone's page origin is new on every start.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/index.html");
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

export async function setName(page, name) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Your name", exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveValue(name);
  // Settings draws the saved name as avatar initials; the field alone only echoes the typing, so
  // the phone could still send its device name in a join request.
  await expect(page.locator(".ui-avatar-lg")).toHaveText(name.slice(0, 2).toUpperCase());
}

export async function closePhoto(page) {
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".justus-holders-text")).toHaveCount(0);
}
