/**
 * Two real bare instances (own storage, own worklet, one local DHT), driven
 * through the real UI end to end: A creates an album and adds a photo, B joins
 * with the invite and sees no photo until A accepts (never, when A declines).
 *
 *   pnpm test:e2e-p2p
 *
 * Set JUSTUS_HUB_DHT_PORT / JUSTUS_HUB_BASE_PORT when the defaults are taken.
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import type { Page } from "@playwright/test";
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

const ALBUM = "Hub trip";
const FRIEND_ALBUM = "Friends trip";
const PHOTO = "hub-join.png";
const RELOAD_ALBUM = "Reload trip";
const RELOAD_PHOTO = "hub-reload.png";
const REASK_ALBUM = "Second try";
const REASK_PHOTO = "hub-reask.png";

// The local DHT needs 5 nodes (apps/backend/scripts/local-dht.mjs): on 3, an idle
// album creator cannot NAT-sample enough nodes, aborts the joiner's holepunch,
// and the joiner times out. On failure the fixture attaches each instance's
// /__state and /__logs.
async function skipIntro(pages) {
  for (const page of pages) {
    await page.addInitScript(() => localStorage.setItem("justus:welcome-seen", "1"));
  }
}

async function createAlbum(a, name, file, colour) {
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

async function copyInviteLink(a) {
  await a.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  await a.getByRole("button", { name: /^(Copy invite link|Copy link)$/ }).click();
  await expect
    .poll(() => a.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^justus:\/\/join\?/);
  const link = await a.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^justus:\/\/join\?/);
  expect(link).toMatch(/[?&]e=\d+/);
  return link;
}

async function askToJoin(b, link, album) {
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(link);
  await b.getByRole("button", { name: "Continue", exact: true }).click();
  const ask = b.getByRole("dialog", { name: `Ask to join “${album}”?` });
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0);
  await ask.getByRole("button", { name: "Ask to join" }).click();
  await expect(b.getByRole("dialog", { name: /^Waiting for / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0);
}

test("B asks to join A's album by link, A accepts, B sees the photo", async ({ instancePages }) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await b.addInitScript(() => {
    const w = window as unknown as { __sawViewer: boolean };
    w.__sawViewer = false;
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("You're a Viewer")) w.__sawViewer = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await createAlbum(a, ALBUM, PHOTO, 11);
  const link = await copyInviteLink(a);
  await a.getByRole("link", { name: "Photos", exact: true }).click();
  await askToJoin(b, link, ALBUM);
  const asked = a.getByRole("status").filter({ hasText: `wants to join “${ALBUM}”` });
  await expect(asked).toBeVisible({ timeout: 60_000 });
  await asked.getByRole("button", { name: "Review" }).click();
  await expect(a).toHaveURL(/\/sharing\/[^/]+$/);
  await expect(asked).toHaveCount(0);
  const codeSpan = b
    .getByRole("dialog", { name: /^Waiting for / })
    .getByText(/^[a-z]+ [a-z]+ [a-z]+$/);
  await expect(codeSpan).toBeVisible({ timeout: 20_000 });
  const code = (await codeSpan.textContent())!;

  const askRow = a.locator("li", { hasText: `wants to join “${ALBUM}”` });
  await expect(askRow).toBeVisible({ timeout: 60_000 });
  await expect(askRow).toContainText(`Check code ${code}`);
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();

  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  const bImg = b.getByRole("button", { name: `View ${PHOTO}` }).locator("img");
  await expect(bImg).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => bImg.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);

  await expect(b.getByText("You can look, but not add photos yet.")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(b.getByRole("button", { name: `Add photos to ${ALBUM}` })).toBeVisible({
    timeout: 60_000,
  });
  expect(await b.evaluate(() => (window as unknown as { __sawViewer: boolean }).__sawViewer)).toBe(
    false,
  );
});

/** Records the text of every toast the page shows from now on, once per toast (the list re-inserts a toast's node when others move). Call again after a navigation. */
const LONG_NAME = "Alexandra Montgomery-Featherstonehaugh";

async function expectRowFits(page: Page, name: string) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  const buttons = [`Make ${name} a Viewer`, `Remove ${name}`].map((label) =>
    page.getByRole("button", { name: label, exact: true }),
  );
  const colours: string[] = [];
  for (const button of buttons) {
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    colours.push(await button.evaluate((el) => getComputedStyle(el).color));
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(colours[1]).not.toBe(colours[0]);
  if (original) await page.setViewportSize(original);
}

async function recordToasts(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __toasts?: string[] };
    w.__toasts = w.__toasts ?? [];
    const seen = new Set<string | null>();
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          const toasts = n.matches(".justus-toast")
            ? [n]
            : [...n.querySelectorAll(".justus-toast")];
          for (const t of toasts) {
            const key = t.getAttribute("data-motion-key");
            if (seen.has(key)) continue;
            seen.add(key);
            w.__toasts?.push(t.textContent?.trim() ?? "");
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);
}

test("A accepts B as a Viewer: B sees the photo, has no Add photos button, A's Members shows B as Viewer", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  const album = "Viewer trip";
  // A's first answer never leaves A's phone; frames are decoded as text to find it.
  let blockAnswer = true;
  await a.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const text = typeof m === "string" ? m : Buffer.from(m).toString("latin1");
      if (blockAnswer && text.includes('"photos.respond"')) return;
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await createAlbum(a, album, PHOTO, 11);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, album);

  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await expect(a.getByText("Sees every photo, can't add any")).toBeVisible();
  await a.getByRole("button", { name: "Accept as Viewer", exact: true }).click();

  const card = a.locator("li", { hasText: `wants to join “${album}”` });
  await expect(card.getByRole("alert")).toContainText("Couldn't connect", { timeout: 40_000 });
  await expect(a.getByText(/is in as a Viewer/)).toHaveCount(0);
  expect(b.url()).not.toMatch(/\/albums\//);
  blockAnswer = false;
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(a.getByText(/is in as a Viewer/)).toBeVisible({ timeout: 15_000 });

  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  const bImg = b.getByRole("button", { name: `View ${PHOTO}` }).locator("img");
  await expect(bImg).toBeAttached({ timeout: 60_000 });
  await expect(b.getByText("You're a Viewer: you see every photo here.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toHaveCount(0);
  const bToasts = await recordToasts(b);

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const row = members.locator("li", { hasText: "Viewer · sees every photo" });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("connected", { timeout: 30_000 });

  await row.getByRole("button", { name: /^Let .* add photos$/ }).click();
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(async () =>
      (await bToasts()).filter((t) => t.endsWith("made you a Collaborator in Viewer trip")),
    )
    .toHaveLength(1);
  expect((await bToasts()).filter((t) => /made you a Viewer/.test(t))).toEqual([]);
});

test("A makes B a Viewer: B loses Add photos, B's photo stays on both phones; A removes B: B is no longer in the album and keeps the photo", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  const album = "Kept trip";
  const kept = "hub-kept.png";
  await createAlbum(a, album, PHOTO, 11);
  const link = await copyInviteLink(a);
  await b.goto("/settings");
  const bName = b.getByRole("textbox", { name: "Your name", exact: true });
  await bName.fill(LONG_NAME);
  await b.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bName).toHaveValue(LONG_NAME);
  await askToJoin(b, link, album);

  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  const bFirst = await recordToasts(b);
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toBeVisible({
    timeout: 60_000,
  });
  expect((await bFirst()).filter((t) => /made you a/.test(t))).toEqual([]);

  await b.setInputFiles("input[type=file]", {
    name: kept,
    mimeType: "image/png",
    buffer: pngOf(...runColour(23)),
  });
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(a.getByRole("button", { name: `View ${kept}` })).toBeVisible({ timeout: 60_000 });
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();

  // Reload on the members page: the case where its buttons used to do nothing.
  await a.reload();
  const aToasts = await recordToasts(a);
  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await expect(members).toBeVisible({ timeout: 60_000 });
  await expectRowFits(a, LONG_NAME);
  await members.getByRole("button", { name: /^Make .* a Viewer$/ }).click();
  await a.getByRole("button", { name: "Make Viewer", exact: true }).click();
  await expect(a.getByText(/is a Viewer now$/)).toBeVisible({ timeout: 60_000 });

  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(b.getByText("You're a Viewer: you see every photo here.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(members.locator("li", { hasText: "Viewer" })).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await bFirst()).filter((t) => t.endsWith("made you a Viewer in Kept trip")))
    .toHaveLength(1);

  await a.getByRole("link", { name: "See photos in this album" }).click();
  for (const page of [a, b]) {
    await expect(page.getByRole("button", { name: `View ${kept}` })).toBeVisible();
  }
  await b.goto("/sharing");
  const bAfter = await recordToasts(b);
  await b.getByText(album).click();
  await b.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b.getByRole("button", { name: `View ${kept}` })).toBeVisible({ timeout: 60_000 });
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toHaveCount(0);

  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const people = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await people.getByRole("button", { name: /^Remove /, exact: false }).click();
  await a.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(a.getByText(`is no longer in ${album}`)).toBeVisible({ timeout: 60_000 });

  await expect(
    b.getByText(`You're no longer in ${album}. You can still see the photos you have.`),
  ).toBeVisible({ timeout: 60_000 });
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toHaveCount(0);
  await expect(b.getByRole("button", { name: `View ${kept}` })).toBeVisible();
  await b.goto("/sharing");
  await expect(b.getByText("No longer in this album")).toBeVisible({ timeout: 60_000 });
  expect((await bAfter()).filter((t) => /made you a/.test(t))).toEqual([]);
  expect((await aToasts()).filter((t) => /made you a/.test(t))).toEqual([]);
});

test("A saves B as a friend from the Members list and the name stays after a reload", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, FRIEND_ALBUM, PHOTO, 11);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, FRIEND_ALBUM);
  await expect(a.getByText(`wants to join “${FRIEND_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const row = members
    .locator("li", { hasText: "connected" })
    .filter({ hasNot: a.getByText("(you)") });
  const tap = row.getByRole("button").first();
  await expect(tap).toBeVisible({ timeout: 60_000 });
  const ownName = (((await tap.locator("p").first().innerText()) ?? "").split("·")[0] ?? "").trim();
  await tap.click();
  await a.getByRole("button", { name: "Add to friends", exact: true }).click();
  await a.getByRole("textbox", { name: "Name", exact: true }).fill("Sam");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await expect(a.getByText("Saved Sam as a friend")).toBeVisible();
  await expect(row.getByText("Sam", { exact: false }).first()).toBeVisible();
  await expect(row.getByText("Friend")).toBeVisible();
  await expect(row.getByText(ownName, { exact: true })).toBeVisible();

  await a.reload();
  await a.goto("/sharing");
  await a.getByText(FRIEND_ALBUM).click();
  await expect(a.locator("li", { hasText: "Friend" }).getByText("Sam").first()).toBeVisible({
    timeout: 30_000,
  });
});

test("B asks by link, A declines, B taps OK and the row goes, B asks again, A accepts, B sees the photo", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, REASK_ALBUM, REASK_PHOTO, 23);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, REASK_ALBUM);

  await expect(a.getByText(`wants to join “${REASK_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Decline" }).click();

  await expect(b.getByText(/didn.t accept your request/)).toBeVisible({ timeout: 60_000 });
  await expect(b.locator("img")).toHaveCount(0);
  await b.getByRole("button", { name: "OK" }).click();
  await expect(a.getByText(`wants to join “${REASK_ALBUM}”`)).toHaveCount(0);
  await b.goto("/sharing");
  await expect(b.getByText("Not accepted")).toHaveCount(0, { timeout: 20_000 });
  await expect(b.getByRole("button", { name: `View ${REASK_PHOTO}` })).toHaveCount(0);

  await askToJoin(b, link, REASK_ALBUM);
  await expect(a.getByText(`wants to join “${REASK_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();

  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  const bImg = b.getByRole("button", { name: `View ${REASK_PHOTO}` }).locator("img");
  await expect(bImg).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => bImg.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);
});

test("B asks by link, A turns off the links: B is told the link no longer works and sees nothing of the album; B asks with A's new link", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, "Off trip", PHOTO, 29);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, "Off trip");

  await expect(a.getByText("wants to join “Off trip”")).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Turn off links you sent" }).click();
  await a.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(a.getByText("wants to join “Off trip”")).toHaveCount(0);

  const sheet = b.getByRole("dialog", { name: "This invite link no longer works." });
  await expect(sheet).toBeVisible({ timeout: 60_000 });
  await expect(sheet.getByText(/^Ask .+ for a new one\.$/)).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect(b.locator("img")).toHaveCount(0);
  await expect(b.getByText(PHOTO)).toHaveCount(0);
  await expect(b.getByRole("link", { name: /Invite & members/ })).toHaveCount(0);

  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await b.goto("/join");
  const row = b.getByRole("button", { name: "Link no longer works: Off trip" });
  await expect(row).toBeVisible();
  await b.reload();
  await expect(row).toBeVisible();

  await a.getByRole("button", { name: /^(Send invite link|Copy invite link)$/ }).click({
    timeout: 20_000,
  });
  await expect
    .poll(() => a.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^justus:\/\/join\?/);
  const newLink = await a.evaluate(() => navigator.clipboard.readText());
  expect(newLink).toMatch(/^justus:\/\/join\?/);
  expect(newLink).not.toBe(link);
  await askToJoin(b, newLink, "Off trip");
  await expect(a.getByText("wants to join “Off trip”")).toBeVisible({ timeout: 60_000 });
  await b.goto("/join");
  await expect(b.getByRole("button", { name: "Link no longer works: Off trip" })).toHaveCount(0);
  await expect(
    b.getByRole("button", { name: /^Waiting for .+ to accept: Off trip$/ }),
  ).toBeVisible();

  await b.getByRole("button", { name: /^Waiting for .+ to accept: Off trip$/ }).click();
  await b.getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(b.getByRole("button", { name: /Off trip/ })).toHaveCount(0);
});

test("B asks from the first-run screen, closes the waiting sheet, A accepts, B opens the album by itself", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a]);
  await createAlbum(a, ALBUM, PHOTO, 31);
  const link = await copyInviteLink(a);

  await b.goto("/");
  await expect(b).toHaveURL(/\/welcome/);
  await b.getByRole("button", { name: "Skip" }).click();
  await b.getByLabel("Your name").fill("Ben");
  await b.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(b.getByRole("heading", { name: "Start sharing" })).toBeVisible();

  await b.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await b.evaluate((l) => navigator.clipboard.writeText(l), link);
  await b.getByRole("button", { name: "Paste from clipboard" }).click();
  await expect(b.getByLabel("Invite link")).toHaveValue(link);
  await b.getByRole("button", { name: "Continue", exact: true }).click();
  const ask = b.getByRole("dialog", { name: `Ask to join “${ALBUM}”?` });
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await ask.getByRole("button", { name: "Ask to join" }).click();
  const waiting = b.getByRole("dialog", { name: /^Waiting for / });
  await expect(waiting).toBeVisible({ timeout: 20_000 });
  await waiting.getByRole("button", { name: "Close" }).first().click();
  await expect(b.getByRole("dialog")).toHaveCount(0);
  await expect(b).toHaveURL(/\/welcome/);
  await expect(b.getByRole("region", { name: "Waiting to join" })).toContainText(
    /Waiting for .+ to accept/,
  );
  await expect(b.getByLabel("Invite link")).toHaveValue("");
  await expect(b.getByRole("region", { name: "Waiting to join" })).toHaveCount(1);

  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Viewer", exact: true }).click();
  const t0 = Date.now();

  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  const bImg = b.getByRole("button", { name: `View ${PHOTO}` }).locator("img");
  await expect(bImg).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => bImg.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(b.getByText("This album isn't on this phone.")).toHaveCount(0);
  test.info().annotations.push({
    type: "accept-to-album-ms",
    description: String(Date.now() - t0),
  });
});

test("B reloads while waiting, A declines, B sees the decline on Photos", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, RELOAD_ALBUM, RELOAD_PHOTO, 47);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, RELOAD_ALBUM);
  await b
    .getByRole("dialog", { name: /^Waiting for / })
    .getByRole("button", { name: "Close" })
    .first()
    .click();
  const waitingRow = b
    .getByRole("region", { name: "Waiting to join" })
    .getByRole("listitem")
    .filter({ hasText: RELOAD_ALBUM });
  await expect(waitingRow).toHaveCount(1);
  await expect(waitingRow).toContainText(/Waiting for .+ to accept/);
  await expect(b.getByLabel("Invite link")).toHaveValue("");
  await b.goto("/");
  await expect(b.getByRole("region", { name: "Waiting to join" })).toBeVisible({
    timeout: 20_000,
  });

  await expect(a.getByText(`wants to join “${RELOAD_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Decline" }).click();

  await expect(b.getByText(/didn.t accept your request/)).toBeVisible({ timeout: 60_000 });
  await b.getByRole("button", { name: "OK" }).click();
  await expect(b.getByRole("region", { name: "Waiting to join" })).toHaveCount(0);
  await expect(b.getByRole("button", { name: `View ${RELOAD_PHOTO}` })).toHaveCount(0);
});

test("A adds friend B to a new album without a link; B joins and sees the photo", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, FRIEND_ALBUM, PHOTO, 11);
  const firstLink = await copyInviteLink(a);
  await askToJoin(b, firstLink, FRIEND_ALBUM);
  await expect(a.getByText(`wants to join “${FRIEND_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const tap = members
    .locator("li", { hasText: "connected" })
    .filter({ hasNot: a.getByText("(you)") })
    .getByRole("button")
    .first();
  await expect(tap).toBeVisible({ timeout: 60_000 });
  await tap.click();
  // The instances outlive a test, so an earlier test may already have saved B as Sam.
  const add = a.getByRole("button", { name: "Add to friends", exact: true });
  const known = a.getByText("Saved as a friend");
  await expect(add.or(known)).toBeVisible();
  if (await add.isVisible()) {
    await add.click();
    await a.getByRole("textbox", { name: "Name", exact: true }).fill("Sam");
    await a.getByRole("button", { name: "Save", exact: true }).click();
    await expect(a.getByText("Saved Sam as a friend")).toBeVisible();
  } else {
    await a.getByRole("button", { name: "Close" }).click();
  }

  const lisbon = "Lisbon trip";
  const lisbonPhoto = "hub-lisbon.png";
  await createAlbum(a, lisbon, lisbonPhoto, 83);
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  await a.getByRole("button", { name: "Add a friend" }).click();
  await a.getByRole("dialog").getByRole("checkbox", { name: "Sam" }).check();
  await a.getByRole("button", { name: "Add Sam as Viewers", exact: true }).click();
  await expect(a.getByText("Asked Sam to join as Viewers")).toBeVisible({ timeout: 60_000 });

  // Hub state persists across tests, so other things may already be waiting for B.
  await b.goto("/");
  const waitingPill = b.getByLabel(/^\d+ waiting for you$/).filter({ visible: true });
  await expect(waitingPill).toBeVisible({ timeout: 60_000 });
  const waitingBefore = Number((await waitingPill.textContent()) ?? "0");
  expect(waitingBefore).toBeGreaterThanOrEqual(1);

  await b.goto("/sharing");
  const invite = b.locator("li", { hasText: "invited you" });
  await expect(invite).toContainText(lisbon, { timeout: 60_000 });
  await invite.getByRole("button", { name: "Join" }).click();

  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  const bImg = b.getByRole("button", { name: `View ${lisbonPhoto}` }).locator("img");
  await expect(bImg).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => bImg.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(b.getByText("You're a Viewer: you see every photo here.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(b.getByRole("button", { name: `Add photos to ${lisbon}` })).toHaveCount(0);
  await b.goto("/");
  if (waitingBefore === 1) await expect(waitingPill).toHaveCount(0);
  else await expect(waitingPill).toHaveText(String(waitingBefore - 1));

  await expect(a.getByText("wants to join")).toHaveCount(0);
  const lisbonMembers = a.locator("section", {
    has: a.getByRole("heading", { name: "Members" }),
  });
  await expect(lisbonMembers.locator("li", { hasText: "Sam" }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(lisbonMembers.locator("li", { hasText: "Sam" }).first()).toContainText("Viewer");
});

test("A accepts B and C in one tap as Viewers: both land, A's waiting list is empty", async ({
  instancePages,
}) => {
  test.setTimeout(180_000);
  const [a, b, c] = instancePages;
  await skipIntro([a, b, c]);
  const album = "Group trip";
  await createAlbum(a, album, PHOTO, 12);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, album);
  await askToJoin(c, link, album);

  await expect(a.getByText(`wants to join “${album}”`)).toHaveCount(2, { timeout: 60_000 });
  await a.getByRole("button", { name: "Accept all 2 as Viewers", exact: true }).click();
  await expect(a.getByText("2 people are in as Viewers")).toBeVisible({ timeout: 30_000 });
  await expect(a.getByText(/wants to join/)).toHaveCount(0);

  for (const p of [b, c]) {
    await expect(p).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    await expect(p.getByText("You're a Viewer: you see every photo here.")).toBeVisible({
      timeout: 60_000,
    });
    await expect(p.getByRole("button", { name: `Add photos to ${album}` })).toHaveCount(0);
  }
  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await expect(members.locator("li", { hasText: "Viewer" })).toHaveCount(2, { timeout: 60_000 });
});

test("A saved friend and a stranger with the friend's name ask by link: only the stranger is marked", async ({
  instancePages,
}) => {
  test.setTimeout(360_000);
  const [a, b, c] = instancePages;
  await skipIntro([a, b, c]);
  const first = "Friend first album";
  await createAlbum(a, first, PHOTO, 21);
  await askToJoin(b, await copyInviteLink(a), first);
  await expect(a.getByText(`wants to join “${first}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const tap = members
    .locator("li", { hasText: "connected" })
    .filter({ hasNot: a.getByText("(you)") })
    .getByRole("button")
    .first();
  await expect(tap).toBeVisible({ timeout: 60_000 });
  await tap.click();
  // The instances outlive a test, so an earlier test may already have saved B as Sam.
  const add = a.getByRole("button", { name: "Add to friends", exact: true });
  const known = a.getByText("Saved as a friend");
  await expect(add.or(known)).toBeVisible();
  if (await add.isVisible()) {
    await add.click();
    await a.getByRole("textbox", { name: "Name", exact: true }).fill("Sam");
    await a.getByRole("button", { name: "Save", exact: true }).click();
    await expect(a.getByText("Saved Sam as a friend")).toBeVisible();
  } else {
    await a.getByRole("button", { name: "Close" }).click();
  }

  const second = "Friend second album";
  await createAlbum(a, second, "friend-second.png", 44);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, second);
  const row = a.locator("li", { hasText: `wants to join “${second}”` });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("Sam");
  await expect(row).toContainText("Friend");

  await c.goto("/settings");
  const nameInput = c.getByRole("textbox", { name: "Your name", exact: true });
  await nameInput.fill("sam");
  await c.getByRole("button", { name: "Save", exact: true }).click();
  await expect(nameInput).toHaveValue("sam");
  await askToJoin(c, link, second);

  const stranger = a.locator("li", { hasText: "Not your friend Sam" });
  await expect(stranger).toBeVisible({ timeout: 60_000 });
  await expect(stranger).toContainText(`sam wants to join “${second}”`);
  await expect(row.filter({ hasNotText: "Not your friend" })).toContainText("Friend");
  await expect(row).toHaveCount(2);
  await expect(a.getByText("typed a friend's name.", { exact: false })).toBeVisible();
  await expect(a.getByRole("button", { name: /^Accept all/ })).toHaveCount(0);
  await stranger.getByRole("button", { name: "Accept as Viewer", exact: true }).click();
  await expect(c).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  const secondMembers = a.locator("section", {
    has: a.getByRole("heading", { name: "Members" }),
  });
  await expect(secondMembers.locator("li", { hasText: "Not your friend Sam" })).toBeVisible({
    timeout: 60_000,
  });
});

test("A takes back the invite sent to friend B: the row goes on A and the invite goes from B's Sharing page", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, FRIEND_ALBUM, PHOTO, 11);
  const firstLink = await copyInviteLink(a);
  await askToJoin(b, firstLink, FRIEND_ALBUM);
  await expect(a.getByText(`wants to join “${FRIEND_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Collaborator", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const tap = members
    .locator("li", { hasText: "connected" })
    .filter({ hasNot: a.getByText("(you)") })
    .getByRole("button")
    .first();
  await expect(tap).toBeVisible({ timeout: 60_000 });
  await tap.click();
  // The instances outlive a test, so an earlier test may already have saved B as Sam.
  const add = a.getByRole("button", { name: "Add to friends", exact: true });
  const known = a.getByText("Saved as a friend");
  await expect(add.or(known)).toBeVisible();
  if (await add.isVisible()) {
    await add.click();
    await a.getByRole("textbox", { name: "Name", exact: true }).fill("Sam");
    await a.getByRole("button", { name: "Save", exact: true }).click();
    await expect(a.getByText("Saved Sam as a friend")).toBeVisible();
  } else {
    await a.getByRole("button", { name: "Close" }).click();
  }

  const porto = "Porto trip";
  await createAlbum(a, porto, "hub-lisbon.png", 84);
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  await a.getByRole("button", { name: "Add a friend" }).click();
  await a.getByRole("dialog").getByRole("checkbox", { name: "Sam" }).check();
  await a.getByRole("button", { name: "Add Sam as Viewers", exact: true }).click();
  await expect(a.getByText("Asked Sam to join as Viewers")).toBeVisible({ timeout: 60_000 });

  const row = a.locator("li", { hasText: "Viewer" }).filter({
    has: a.getByRole("button", { name: "Take back Sam's invite" }),
  });
  await expect(a.getByText("Invited, not in yet")).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("Sam");
  await a.getByRole("button", { name: "Take back Sam's invite" }).click();
  await expect(a.getByText("Took back Sam's invite.")).toBeVisible({ timeout: 60_000 });
  await expect(row).toHaveCount(0);

  await b.goto("/sharing");
  await expect
    .poll(
      async () => b.locator("li", { hasText: "invited you" }).filter({ hasText: porto }).count(),
      {
        timeout: 60_000,
      },
    )
    .toBe(0);
});
