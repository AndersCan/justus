/**
 * Two real bare instances, driven through the real UI: only the adder or the
 * album's Admin can delete a photo, and a delete reaches the other phone (its
 * open view closes by itself).
 *
 *   pnpm test:e2e-p2p -g "deletes only their own photo"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import type { Page } from "@playwright/test";
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ALBUM = "Delete trip";
const ANA = "del-ana.png";
const BEN = "del-ben.png";
const BEN2 = "del-ben2.png";

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

// Photo ids in one album's photo cache on an instance (spool names are base64url "driveKey:id:ext").
function spoolIds(storageDir, folderId) {
  let names = [];
  try {
    names = readdirSync(join(storageDir, "cache", "photos", folderId));
  } catch {
    return [];
  }
  const ids = new Set();
  for (const name of names) {
    const token = name.split(".")[0] ?? "";
    const raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parts = raw.split(":");
    if (parts.length >= 3) ids.add(parts[1]);
  }
  return [...ids];
}

// Every toast a page shows, each counted once.
async function recordToasts(page) {
  await page.evaluate(() => {
    window.__toasts = window.__toasts ?? [];
    const seen = new Set();
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          const found = n.matches(".justus-toast") ? [n] : [...n.querySelectorAll(".justus-toast")];
          for (const t of found) {
            const key = t.getAttribute("data-motion-key");
            if (seen.has(key)) continue;
            seen.add(key);
            window.__toasts.push(t.textContent?.trim() ?? "");
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => window.__toasts ?? []);
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
  await expect(b.locator("img")).toHaveCount(0, { timeout: 20_000 });
  await ask.getByRole("button", { name: "Ask to join" }).click();
  await expect(b.getByRole("dialog", { name: /^You're done\. / })).toBeVisible({ timeout: 20_000 });
  await expect(b.locator("img")).toHaveCount(0, { timeout: 20_000 });
}

async function expectBenLine(a: Page, text: string | RegExp) {
  const original = a.viewportSize();
  await a.setViewportSize({ width: 360, height: 800 });
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const line = a
    .locator('[data-copy-id="member.role_collaborator"]')
    .locator("xpath=ancestor::p[1]");
  await expect(line).toContainText(text, { timeout: 60_000 });
  expect(
    await line.evaluate(
      (el) => el.offsetHeight < 1.5 * parseFloat(getComputedStyle(el).lineHeight),
    ),
  ).toBe(true);
  await a
    .getByRole("link", { name: /See photos in this album/ })
    .first()
    .click();
  if (original) await a.setViewportSize(original);
}

test("a member deletes only their own photo, the Admin's delete closes Ben's open view, and both deletes leave both phones", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(200_000);
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await createAlbum(a, ALBUM, ANA, 41);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  await expect(a.getByText(`wants to join “${ALBUM}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  // Accepting happens on the members page; the photos are one tap away.
  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${ANA}` })).toBeVisible({ timeout: 60_000 });
  // Ben is a Viewer until the Admin's enrolment reaches his phone; adds before that are refused.
  await expect(b.getByRole("button", { name: `Add photos to ${ALBUM}` })).toBeVisible({
    timeout: 60_000,
  });

  for (const [file, colour] of [
    [BEN, 43],
    [BEN2, 47],
  ]) {
    await b.setInputFiles("input[type=file]", {
      name: file,
      mimeType: "image/png",
      buffer: pngOf(...runColour(colour)),
    });
    await expect(a.getByRole("button", { name: `View ${file}` })).toBeVisible({ timeout: 60_000 });
  }

  await expectBenLine(a, "Adds photos · has 2 in full");

  // Ana opens her photo: only her phone has it. Her line then changes by itself, and the photo stays put, once Ben opens it.
  await a.getByRole("button", { name: `View ${ANA}` }).click();
  const anaLine = a.getByRole("button", { name: /show who has this photo$/ });
  await expect(anaLine).toContainText("On its way to the people you let in", {
    timeout: 20_000,
  });
  const lightboxImage = a.locator("div.fixed img");
  const before = await lightboxImage.boundingBox();

  // Ben (a member) has no menu on Ana's photo.
  await b.getByRole("button", { name: `View ${ANA}` }).click();
  await expect(b.getByRole("button", { name: /show who has this photo$/ })).toContainText(
    /On .+'s and your phone/,
    { timeout: 60_000 },
  );
  await expect(b.locator('[data-copy-id="lightbox.who_deletes_adder_admin"]')).toBeVisible();
  await expect(anaLine).toContainText(/On .+'s and your phone/, { timeout: 60_000 });
  expect(await lightboxImage.boundingBox()).toEqual(before);
  await a.getByRole("button", { name: "Close" }).click();

  // Ben opened every photo: Ana's members page says his phone has all of them.
  await expectBenLine(a, "Adds photos · has every photo in full");

  await expect(b.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(b.getByRole("button", { name: "More options" })).toHaveCount(0, { timeout: 20_000 });

  const aToasts = await recordToasts(a);
  const bToasts = await recordToasts(b);
  const benFolder = new URL(b.url()).pathname.split("/").filter(Boolean)[1];
  const benIdsBefore = spoolIds(instances[1].storageDir, benFolder);
  expect(benIdsBefore.length).toBeGreaterThan(0);

  // The Admin deletes Ana's photo: Ben's open view closes by itself.
  await a.getByRole("button", { name: `View ${ANA}` }).click();
  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = a.locator("wa-dialog[open]", { hasText: `Delete “${ANA}”?` });
  await expect(a.getByText(`Delete “${ANA}”?`)).toBeVisible();
  await expect(dialog).toContainText(
    /.+ has the full photo\. It's removed from their phone the next time they open Justus\. Copies saved outside Justus can.t be taken back\./,
  );
  await dialog.locator("wa-button", { hasText: "Delete" }).click();
  await expect(a.getByRole("button", { name: "Close" })).toHaveCount(0, { timeout: 20_000 });
  await expect(a.getByRole("button", { name: `View ${ANA}` })).toHaveCount(0, { timeout: 20_000 });
  await expect(a.getByRole("status").filter({ hasText: `Deleted “${ANA}”.` })).toHaveText(
    /^\s*Deleted “del-ana\.png”\. .+ (has|have) the full photo\.\s*$/,
  );
  await expect(b.getByRole("button", { name: "Close" })).toHaveCount(0, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${ANA}` })).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(async () =>
      (await bToasts()).filter((t) =>
        /^.+ deleted “del-ana\.png” from Delete trip\. It's removed from your phone\.$/.test(t),
      ),
    )
    .toHaveLength(1);
  // Ben's photo cache has one photo fewer: the note's "removed from your phone" holds.
  await expect
    .poll(() => spoolIds(instances[1].storageDir, benFolder).length, { timeout: 60_000 })
    .toBe(benIdsBefore.length - 1);

  // Ana's phone shows Ben's photo as a preview only once its thumbnail has loaded.
  await expect
    .poll(() =>
      a
        .getByRole("button", { name: `View ${BEN}` })
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);

  // Ben's sheet learns that Ana's phone only showed the preview.
  await b.getByRole("button", { name: `View ${BEN}` }).click();
  await b.getByRole("button", { name: /show who has this photo$/ }).click();
  const sheet = b.getByRole("dialog", { name: "Who has this photo" });
  await expect(sheet).toContainText("Only has a preview", { timeout: 60_000 });
  await b.keyboard.press("Escape");

  // Ben deletes his own photo through the menu; it leaves both phones.
  await b.getByRole("button", { name: "More options" }).click();
  await b.getByRole("menuitem", { name: "Delete" }).click();
  const benDialog = b.locator("wa-dialog[open]", { hasText: `Delete “${BEN}”?` });
  await expect(benDialog).toContainText(
    /The photo no longer shows for .+\. It's removed from their phones? the next time they open Justus\./,
  );
  await benDialog.locator("wa-button", { hasText: "Delete" }).click();
  await expect(b.getByRole("status").filter({ hasText: `Deleted “${BEN}”.` })).toHaveText(
    /^\s*Deleted “del-ben\.png”\. The photo no longer shows for .+\.\s*$/,
  );
  await expect(b.getByRole("button", { name: `View ${BEN}` })).toHaveCount(0, { timeout: 20_000 });
  await expect(a.getByRole("button", { name: `View ${BEN}` })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect
    .poll(async () =>
      (await aToasts()).filter((t) =>
        /^.+ deleted “del-ben\.png” from Delete trip\. It's removed from your phone\.$/.test(t),
      ),
    )
    .toHaveLength(1);

  // The Admin deletes another member's photo; it leaves both phones.
  await a.getByRole("button", { name: `View ${BEN2}` }).click();
  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete" }).click();
  await a
    .locator("wa-dialog[open]", { hasText: `Delete “${BEN2}”?` })
    .locator("wa-button", { hasText: "Delete" })
    .click();
  await expect(a.getByRole("button", { name: `View ${BEN2}` })).toHaveCount(0, { timeout: 20_000 });
  await expect(b.getByRole("button", { name: `View ${BEN2}` })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect
    .poll(async () =>
      (await bToasts()).filter((t) =>
        /^.+ deleted your photo “del-ben2\.png” from Delete trip\. It's removed from your phone\.$/.test(
          t,
        ),
      ),
    )
    .toHaveLength(1);
  // Neither phone is told about a delete it made itself.
  expect((await aToasts()).filter((t) => /“del-(ana|ben2)\.png” from Delete trip/.test(t))).toEqual(
    [],
  );
  expect((await bToasts()).filter((t) => /“del-ben\.png” from Delete trip/.test(t))).toEqual([]);
});
