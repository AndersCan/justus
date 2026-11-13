/**
 * Two real bare instances, driven through the real UI: B archives and restores
 * A's album without A noticing; A deletes it and it leaves B's phone, with a
 * notice that stays until B dismisses it.
 *
 *   pnpm test:e2e-p2p -g "archives and restores"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

const ALBUM = "Hytta";
const PHOTO = "lifecycle.png";

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
  await expect(b.getByRole("dialog", { name: /^You're done\. / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0);
}

async function openAlbumPage(page, name) {
  await page.goto("/sharing");
  await page.getByRole("link", { name: `Invite & members of ${name}` }).click();
}

test("B archives and restores A's album without A noticing; A deletes it and it leaves B's phone with a notice", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, ALBUM, PHOTO, 11);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  await openAlbumPage(b, ALBUM);
  // B's phone is still catching up after joining; a tap that lands while the
  // album list reloads is ignored, so open the menu and tap again until it sticks.
  await expect(async () => {
    if (b.url().endsWith("/sharing")) return;
    await b.getByRole("button", { name: "More options" }).click({ timeout: 5_000 });
    await b.getByRole("menuitem", { name: "Archive" }).click({ timeout: 5_000 });
    await expect(b).toHaveURL(/\/sharing$/, { timeout: 5_000 });
  }).toPass({ timeout: 40_000 });
  const rowOf = (page) => page.getByRole("link", { name: `Invite & members of ${ALBUM}` });
  await expect(rowOf(b)).toHaveCount(0);
  await expect(b.getByText("Archived (1)")).toBeVisible();
  const aMembers = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await openAlbumPage(a, ALBUM);
  await expect(aMembers.locator("li")).toHaveCount(2);

  await b.getByText("Archived (1)").click();
  await b.getByRole("button", { name: `Restore ${ALBUM}` }).click();
  await expect(rowOf(b)).toBeVisible();

  await openAlbumPage(a, ALBUM);
  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete album" }).click();
  await a.getByRole("button", { name: "Delete album", exact: true }).click();
  await expect(a).toHaveURL(/\/sharing$/);
  await expect(rowOf(a)).toHaveCount(0);

  await expect(rowOf(b)).toHaveCount(0, { timeout: 30_000 });
  await expect(b.getByText(`deleted “${ALBUM}”`)).toBeVisible();
  const dismiss = b.getByRole("button", { name: `Dismiss notice about ${ALBUM}` });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await b.reload();
  await expect(b.getByText(`deleted “${ALBUM}”`)).toHaveCount(0);
});
