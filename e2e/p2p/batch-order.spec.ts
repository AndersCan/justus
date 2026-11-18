/**
 * Two real bare instances: Ada adds 6 photos to an album Ben has open; both phones list them
 * in the order she picked, Ada's phone says they were added, and Ben's album says they are new.
 *
 *   pnpm test:e2e-p2p e2e/p2p/batch-order.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { askToJoin, copyInviteLink, createAlbum, setName, skipIntro, words } from "./steps";

const ALBUM = "Batch order trip";
const PICKED = [1, 2, 3, 4, 5, 6].map((n) => `order-${n}.png`);

test("a batch lands in the order picked on both phones, Ada is told, Ben's album says who added them", async ({
  instancePages,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, ALBUM, "order-first.png", 81);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: "View order-first.png" })).toBeVisible({
    timeout: 60_000,
  });
  // Ben has looked at the first photo, so only the batch is new.
  await b.waitForTimeout(2_500);

  await a.setInputFiles(
    "input[type=file]",
    PICKED.map((name, i) => ({
      name,
      mimeType: "image/png",
      buffer: pngOf(...runColour(82 + i)),
    })),
  );

  await expect(
    a
      .locator("[data-toast-host]")
      .getByText(words("add_photos.added_photos_to", { added: 6, album: ALBUM })),
    "Ada's end toast",
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    a.locator("[data-toast-host]").getByRole("button", { name: "Dismiss" }),
  ).toBeVisible();

  const expected = [...PICKED, "order-first.png"].map((name) => `View ${name}`);
  for (const [who, page] of [
    ["Ada", a],
    ["Ben", b],
  ]) {
    await expect
      .poll(
        () =>
          page
            .locator("[data-photo-tile]")
            .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))),
        { message: `${who}'s photos in picked order`, timeout: 60_000 },
      )
      .toEqual(expected);
  }

  await expect(b.locator("[data-new-photos-line]"), "Ben's line").toHaveText(
    words("gallery.new_photos_from_one", { count: 6, name: "Ada" }),
    { timeout: 60_000 },
  );
});
