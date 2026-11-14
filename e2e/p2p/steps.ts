// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";

export async function skipIntro(pages) {
  for (const page of pages) {
    await page.addInitScript(() => localStorage.setItem("justus:welcome-seen", "1"));
  }
}

export async function createAlbum(a, name, file, colour) {
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

export async function copyInviteLink(a) {
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

export async function askToJoin(b, link, _album) {
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(link);
  await b.getByRole("button", { name: "Ask to join", exact: true }).click();
  await expect(b.getByRole("dialog", { name: /^You're done\. / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0, { timeout: 20_000 });
}
