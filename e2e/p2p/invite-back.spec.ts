/**
 * Two real bare instances, driven through the real UI: after the Admin opens
 * "Invite & members" from Photos and taps "← Sharing", the Sharing list stays
 * on screen when the other phone adds photos.
 *
 *   pnpm test:e2e-p2p -g "Back from the invite page"
 *
 * Anna must not open /sharing before she taps Back: lit's cache would hide a
 * stale page (#234).
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

async function skipIntro(pages) {
  for (const page of pages) {
    await page.addInitScript(() => localStorage.setItem("justus:welcome-seen", "1"));
  }
}

// Counts the sync pushes ("add") a page has received. Call before any goto.
function addPushes(page) {
  const texts = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) =>
      texts.push(
        typeof f.payload === "string" ? f.payload : Buffer.from(f.payload).toString("latin1"),
      ),
    ),
  );
  return () => texts.filter((t) => t.includes('"cause":"add"')).length;
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
  await ask.getByRole("button", { name: "Ask to join" }).click();
  await expect(b.getByRole("dialog", { name: /^You're done\. / })).toBeVisible({ timeout: 20_000 });
}

test("Back from the invite page shows Sharing after Ben adds photos", async ({
  instancePages,
}, testInfo) => {
  test.setTimeout(200_000);
  const run = `${testInfo.repeatEachIndex}-${testInfo.retry}`;
  const album = `Back trip ${run}`;
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  const adds = addPushes(a);

  await a.goto("/albums");
  // "Start an album" while Photos has no albums, "New album" once it has one (repeat runs share the instance)
  await a.getByRole("button", { name: /^(Start an album|New album)$/ }).click();
  const sheet = a.getByRole("dialog", { name: "Start an album" });
  await sheet.getByLabel("Album name").fill(album);
  await sheet.getByRole("button", { name: "Create album" }).click();
  await expect(a).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });

  const link = await copyInviteLink(a);
  await askToJoin(b, link, album);
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept as Viewer", exact: true }).click();

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const row = members.locator("li", { hasText: "Viewer" });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /^Let .* add photos$/ }).click();
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toBeVisible({
    timeout: 60_000,
  });

  await b.setInputFiles("input[type=file]", {
    name: `back-ben-1-${run}.png`,
    mimeType: "image/png",
    buffer: pngOf(...runColour(31)),
  });
  await expect.poll(adds, { timeout: 60_000 }).toBeGreaterThan(0);
  const before = adds();

  await a.getByRole("link", { name: "← Sharing" }).click();
  await expect(a).toHaveURL(/\/sharing$/);

  await b.setInputFiles("input[type=file]", {
    name: `back-ben-2-${run}.png`,
    mimeType: "image/png",
    buffer: pngOf(...runColour(37)),
  });
  await expect.poll(adds, { timeout: 60_000 }).toBeGreaterThan(before);
  // the stale page draws back after the sync reload this push starts; give it time to show (#234)
  await a.waitForTimeout(2000);

  await expect(a.getByRole("heading", { name: "Sharing", exact: true })).toBeVisible();
  await expect(a.getByRole("button", { name: "Copy invite link" })).toHaveCount(0);
  await expect(a.getByRole("link", { name: `Invite & members of ${album}` })).toBeVisible();
  await expect(a).toHaveURL(/\/sharing$/);
});
