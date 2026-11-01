/**
 * Two real bare instances (own storage, own worklet, one local DHT), driven
 * through the real UI end to end: A creates an album and adds a photo, B joins
 * with the invite, A approves the request, B sees the photo and may add its own.
 *
 *   pnpm test:e2e-p2p
 *
 * Set JUSTUS_HUB_DHT_PORT / JUSTUS_HUB_BASE_PORT when the defaults are taken.
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

const ALBUM = "Hub trip";
const PHOTO = "hub-join.png";

// The local DHT needs 5 nodes (apps/backend/scripts/local-dht.mjs): on 3, an idle
// album creator cannot NAT-sample enough nodes, aborts the joiner's holepunch,
// and the joiner times out. On failure the fixture attaches each instance's
// /__state and /__logs.
test("B joins A's album by invite, A approves, B sees the photo", async ({ instancePages }) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  // Skip the first-run intro on both instances.
  for (const page of [a, b]) {
    await page.addInitScript(() => localStorage.setItem("justus:welcome-seen", "1"));
  }

  // --- A: create the album and add a photo ---
  await a.goto("/sharing");
  await a.getByLabel("Album name").fill(ALBUM);
  await a.getByRole("button", { name: "Create album" }).click();
  await expect(a).toHaveURL(/\/albums\/[^/]+$/, { timeout: 20_000 });
  await a.setInputFiles("input[type=file]", {
    name: PHOTO,
    mimeType: "image/png",
    buffer: pngOf(...runColour(11)),
  });
  const aImg = a.getByRole("button", { name: `View ${PHOTO}` }).locator("img");
  await expect(aImg).toBeAttached({ timeout: 20_000 });

  // --- A: read the share key off the album's Advanced section ---
  // (Nested paths can't be loaded directly: assets are relative. Navigate in-app.)
  await a.goto("/sharing");
  await a.getByRole("link", { name: `Invite & members of ${ALBUM}` }).click();
  await a.getByText("Advanced", { exact: true }).click();
  await a.getByLabel("Show share key").check({ force: true });
  const shareKey = (await a.locator("dd.group span.break-all").first().innerText()).trim();
  expect(shareKey).toMatch(/^[0-9a-f]{64}$/);

  // --- B: join with the invite link ---
  await b.goto("/join");
  await b
    .getByLabel("Invite link")
    .fill(`justus://join/${shareKey}?n=${encodeURIComponent(ALBUM)}`);
  await b.getByRole("button", { name: "Join", exact: true }).click();
  await b.getByRole("dialog").getByRole("button", { name: "Join album" }).click();

  // --- A: the request shows up in the UI; approve it ---
  await expect(a.getByText("wants to add photos")).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Let them add" }).click();

  // --- B: the album and its photo arrive, decodable ---
  await b.goto("/albums");
  await b
    .getByRole("list", { name: "Albums" })
    .getByRole("link", { name: new RegExp(`^${ALBUM}, `) })
    .click();
  const bImg = b.getByRole("button", { name: `View ${PHOTO}` }).locator("img");
  await expect(bImg).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => bImg.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);

  // --- B: approval landed in-session; B can now add photos ---
  await expect(b.getByText("You can look, but not add photos yet.")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(b.getByRole("button", { name: `Add photos to ${ALBUM}` })).toBeVisible({
    timeout: 60_000,
  });
});
