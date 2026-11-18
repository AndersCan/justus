/**
 * Two real bare instances, driven through the real UI: B archives and restores
 * A's album without A noticing; A deletes it and it leaves B's phone, with a
 * notice that stays until B dismisses it.
 *
 *   pnpm test:e2e-p2p -g "archives and restores"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { askToJoin, copyInviteLink, createAlbum, skipIntro, words } from "./steps";

const ALBUM = "Hytta";
const PHOTO = "lifecycle.png";

// The local DHT needs 5 nodes (apps/backend/scripts/local-dht.mjs): on 3, an idle
// album creator cannot NAT-sample enough nodes, aborts the joiner's holepunch,
// and the joiner times out. On failure the fixture attaches each instance's
// /__state and /__logs.
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

test("B joins A's album and is told so; B leaves: B reads that he left and A reads that B left", async ({
  instancePages,
}) => {
  test.setTimeout(150_000);
  const [a, b] = instancePages;
  const name = "Sommer";
  await skipIntro([a, b]);
  await createAlbum(a, name, PHOTO, 12);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, name);
  await expect(a.getByText(`wants to join “${name}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(
    b.getByRole("status").filter({ hasText: words("notices.now_in_album", { albumName: name }) }),
  ).toBeVisible({ timeout: 30_000 });

  const members = (page) =>
    page.locator("section", { has: page.getByRole("heading", { name: "Members" }) });
  await openAlbumPage(a, name);
  await expect(members(a).locator("li")).toHaveCount(2, { timeout: 60_000 });

  await openAlbumPage(b, name);
  await expect(members(b).locator("li")).toHaveCount(2, { timeout: 60_000 });
  const more = b.getByRole("button", { name: "More options" });
  await expect(more).toBeEnabled({ timeout: 30_000 });
  await more.click();
  await b.getByRole("menuitem", { name: "Leave album" }).click();
  await b.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(b).toHaveURL(/\/sharing$/, { timeout: 30_000 });
  await expect(
    b.getByRole("status").filter({ hasText: words("notices.you_left", { albumName: name }) }),
  ).toBeVisible();

  await expect(members(a).locator("li")).toHaveCount(1, { timeout: 60_000 });
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(a).toHaveURL(/\/albums\/[^/]+$/);
  const leftLine = a.getByRole("status").filter({ hasText: /left this album\./ });
  await expect(leftLine).toBeVisible({ timeout: 60_000 });
  await a.reload();
  await expect(leftLine).toBeVisible({ timeout: 30_000 });
  await a.getByRole("button", { name: `Dismiss notice about ${name}` }).click();
  await expect(leftLine).toHaveCount(0);
  await a.reload();
  await expect(a.getByRole("button", { name: `View ${PHOTO}` })).toBeVisible({ timeout: 30_000 });
  await expect(leftLine).toHaveCount(0);
});
