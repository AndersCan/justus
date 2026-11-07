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
test("B asks to join A's album by link, A accepts, B sees the photo", async ({ instancePages }) => {
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

  // --- A: open the invite panel and copy the link ---
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const copyButton = a.getByRole("button", { name: /^(Copy invite link|Copy link)$/ });
  await expect(copyButton).toBeVisible({ timeout: 20_000 });
  const link = await a.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("invite link was never copied")), 10_000);
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text: string) => {
              clearTimeout(timer);
              resolve(text);
            },
          },
          configurable: true,
        });
        const button = [...document.querySelectorAll("button")].find((el) =>
          /^(Copy invite link|Copy link)$/.test(el.textContent?.trim() ?? ""),
        );
        if (!button) {
          clearTimeout(timer);
          reject(new Error("no copy button on the page"));
          return;
        }
        button.click();
      }),
  );
  expect(link).toMatch(/^justus:\/\/join\?/);

  // --- B: open the link, see the ask, send it ---
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(link);
  await b.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(b.getByRole("dialog", { name: `Ask to join “${ALBUM}”?` })).toBeVisible();
  await b.getByRole("dialog").getByRole("button", { name: "Ask to join" }).click();
  await expect(b.getByRole("dialog", { name: /^Waiting for / })).toBeVisible({ timeout: 20_000 });

  // --- A: the request shows up in the UI; accept it ---
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept" }).click();

  // --- B: the album opens on its own ---
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  // --- B: the album and its photo arrive, decodable ---
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
