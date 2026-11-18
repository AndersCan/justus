/**
 * Two real bare instances: Ada archives her album, Cy asks to join with her
 * link, and Ada answers him from the Archived row without restoring it.
 *
 *   pnpm test:e2e-p2p -g "Ada archives Summer"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { askToJoin, copyInviteLink, createAlbum, skipIntro, words } from "./steps";

const ALBUM = "Summer";

test("Ada archives Summer, Cy asks with her link, Ada opens Cy's request from Archived and accepts without restoring", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, c] = instancePages;
  await skipIntro([a, c]);
  await createAlbum(a, ALBUM, "archived-request.png", 13);
  const link = await copyInviteLink(a);
  await a.goto("/sharing");
  await a.getByRole("link", { name: words("albums.invite_members_of", { name: ALBUM }) }).click();

  // The page may still be loading when a tap lands; open the menu and tap again until it sticks.
  await expect(async () => {
    if (a.url().endsWith("/sharing")) return;
    await a.getByRole("button", { name: "More options" }).click({ timeout: 5_000 });
    const archive = a.getByRole("menuitem", { name: words("album.archive") });
    await expect(archive).toContainText(words("album.archive_hint", { name: ALBUM }), {
      timeout: 5_000,
    });
    await archive.click({ timeout: 5_000 });
    await expect(a).toHaveURL(/\/sharing$/, { timeout: 5_000 });
  }).toPass({ timeout: 40_000 });

  await askToJoin(c, link, ALBUM);

  await a.locator("summary", { hasText: /Archived \(\d+\)/ }).click();
  // Earlier runs leave their own archived Summer on the shared hub: the row with a waiting request is this one.
  const row = a.locator("li", {
    has: a.getByRole("link", { name: new RegExp(ALBUM) }),
    hasText: words("albums.n_waiting", { waiting: 1 }),
  });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.getByRole("link", { name: new RegExp(ALBUM) }).click();

  await expect(a).toHaveURL(/\/sharing\/[^/]+$/);
  await expect(a.getByText(words("album.this_album_isn_t_showing"))).toHaveCount(0);
  await expect(
    a.getByText(words("album.wants_to_join", { folderName: ALBUM }), { exact: true }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await a.getByRole("button", { name: words("album.accept_as_collaborator"), exact: true }).click();
  await expect(c).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
});
