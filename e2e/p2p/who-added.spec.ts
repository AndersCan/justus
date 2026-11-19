/**
 * Three real bare instances: Ada makes an album, lets Ben in to look and Cy in to add photos. Cy
 * adds a photo; Ben's tiles then read who added each photo, and each tile's dot has the colour of
 * that person's row in Members.
 *
 *   pnpm test:e2e-p2p -g "who added"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { pngOf, runColour } from "../add-photos.js";
import { expect, test } from "../hub/fixtures.mjs";
import { askToJoin, copyInviteLink, createAlbum, setName, skipIntro, words } from "./steps";

const ADA_FILE = "who-added-ada.png";
const CY_FILE = "who-added-cy.png";

async function letIn(a, joiner, album, button) {
  const link = await copyInviteLink(a);
  await askToJoin(joiner, link, album);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: button, exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album syncs to the joiner after Ada accepts.
  await expect(joiner).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
}

function fill(locator) {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

test("who added: Ben's tiles carry Ada's and Cy's Members colours and say who added each photo", async ({
  instancePages,
}) => {
  test.setTimeout(330_000);
  const [a, b, c] = instancePages;
  const album = `Who added ${Date.now().toString(36)}`;
  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, album, ADA_FILE, 41);
  await letIn(a, b, album, "Accept, can only look");
  await letIn(a, c, album, "Accept, can add photos");

  await c.setInputFiles("input[type=file]", {
    name: CY_FILE,
    mimeType: "image/png",
    buffer: pngOf(...runColour(97)),
  });

  function tile({ name, adder }) {
    return b.getByRole("button", {
      name: words("gallery.view_added_by", { name, adder }),
      exact: true,
    });
  }
  // 60 s: Cy's photo and his colour cross the hub to Ben's phone.
  const cyDot = tile({ name: CY_FILE, adder: "Cy" }).locator('[data-adder-dot="filled"]');
  const adaDot = tile({ name: ADA_FILE, adder: "Ada" }).locator('[data-adder-dot="filled"]');
  await expect(cyDot).toBeVisible({ timeout: 60_000 });
  await expect(adaDot).toBeVisible({ timeout: 60_000 });

  const cyTile = await fill(cyDot);
  const adaTile = await fill(adaDot);

  await b
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const members = b.locator("section", { has: b.getByRole("heading", { name: "Members" }) });
  function row(name) {
    return members.locator("[data-member-key]", { hasText: name }).locator(".ui-avatar");
  }
  await expect(row("Cy")).toBeVisible({ timeout: 60_000 });
  expect(cyTile, "Cy's tile dot matches his Members row").toBe(await fill(row("Cy")));
  expect(adaTile, "Ada's tile dot matches her Members row").toBe(await fill(row("Ada")));
  expect(adaTile, "Ada and Cy have different colours").not.toBe(cyTile);
});
