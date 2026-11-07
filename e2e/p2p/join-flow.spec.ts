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
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

const ALBUM = "Hub trip";
const FRIEND_ALBUM = "Friends trip";
const PHOTO = "hub-join.png";

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
  await expect(ask).toBeVisible();
  await expect(b.locator("img")).toHaveCount(0);
  await ask.getByRole("button", { name: "Ask to join" }).click();
  await expect(b.getByRole("dialog", { name: /^Waiting for / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0);
}

test("B asks to join A's album by link, A accepts, B sees the photo", async ({ instancePages }) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, ALBUM, PHOTO, 11);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);

  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept" }).click();

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
  await a.getByRole("button", { name: "Accept" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const row = members
    .locator("li", { hasText: "connected" })
    .filter({ hasNot: a.getByText("(you)") });
  const tap = row.getByRole("button").first();
  await expect(tap).toBeVisible({ timeout: 60_000 });
  const ownName = ((await tap.locator("p").first().innerText()) ?? "").trim();
  await tap.click();
  await a.getByRole("button", { name: "Add to friends" }).click();
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

test("B asks to join A's album by link, A declines, B sees no photo", async ({ instancePages }) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, ALBUM, PHOTO, 23);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);

  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Decline" }).click();

  await expect(b.getByText(/didn.t accept your request/)).toBeVisible({ timeout: 60_000 });
  await expect(b.locator("img")).toHaveCount(0);
  await b.getByRole("button", { name: "OK" }).click();
  await b.goto("/sharing");
  await expect(b.getByText("Not accepted")).toBeVisible();
  await expect(b.locator("img")).toHaveCount(0);
  await expect(b.getByRole("button", { name: `View ${PHOTO}` })).toHaveCount(0);
});
