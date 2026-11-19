/**
 * Two real bare instances: Ben's phone is paused, Ada adds 3 photos and her album page says
 * they wait for Ben's phone; when Ben's phone is back it fetches the previews by itself
 * (Ben stays on Settings) and Ada's line goes.
 *
 *   pnpm test:e2e-p2p e2e/p2p/photo-wait.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import {
  askToJoin,
  copyInviteLink,
  createAlbum,
  pausePhone,
  resumeAll,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Wait trip";

test.afterEach(() => resumeAll());

async function setName(page, name) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Your name", exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveValue(name);
}

test("Ada's waiting line appears while Ben's phone is paused and goes without a tap from Ben", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(300_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, "wait-first.png", 51);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: "View wait-first.png" })).toBeVisible({
    timeout: 60_000,
  });
  await b.goto("/settings");

  // Ada has read Ben's record (he has the first preview) before his phone goes away, so a new photo reads as missing from it.
  await a.getByRole("button", { name: "View wait-first.png" }).click();
  await a.getByRole("button", { name: /show who has this photo$/ }).click();
  await expect(a.locator('[data-copy-id="full_photo.only_preview"]')).toBeVisible({
    timeout: 60_000,
  });
  await a.keyboard.press("Escape");
  await a.keyboard.press("Escape");
  await expect(a.getByRole("button", { name: /show who has this photo$/ })).toHaveCount(0);

  const resume = await pausePhone(instances[1]);
  await a.setInputFiles(
    "input[type=file]",
    [52, 53, 54].map((colour) => ({
      name: `wait-${colour}.png`,
      mimeType: "image/png",
      buffer: pngOf(...runColour(colour)),
    })),
  );
  // 30 s: three adds and their listing on a loaded runner.
  await expect(
    a.locator('[data-copy-id="gallery.photos_wait_for_one"]'),
    "Ada's line while Ben is paused",
  ).toHaveText(words("gallery.photos_wait_for_one", { count: 3, name: "Ben" }), {
    timeout: 30_000,
  });

  // 100 s: Ada's phone needs about 14 s to see Ben is gone, the strip keeps him connected for 30 s more, and its clock ticks every 15 s; resuming sooner never cuts the link.
  await expect(
    a.getByText(words("gallery.connecting_to", { name: "Ben" }), { exact: true }),
    "Ada sees Ben's link drop",
  ).toBeVisible({ timeout: 100_000 });

  resume();
  // 60 s: reconnecting after a resume took 2-16 s, then three previews.
  await expect(
    a.locator('[data-copy-id^="gallery.photos_wait"]'),
    "Ada's line after Ben is back",
  ).toHaveCount(0, { timeout: 60_000 });
  await expect(b).toHaveURL(/\/settings$/);
});
