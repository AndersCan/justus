/**
 * Two real bare instances, driven through the real UI: only the adder or the
 * album's Admin can delete a photo, and a delete reaches the other phone (its
 * open view closes by itself).
 *
 *   pnpm test:e2e-p2p -g "deletes only their own photo"
 *
 * A delete also reaches a phone that was off, Ada's album page names Ben's phone until it drops the
 * photo, also after her own restart, and her phone says so when it does. Opened from Photos > All with
 * another album open, the photo reads the same sheet and its delete toast names Ben:
 *
 *   pnpm test:e2e-p2p e2e/p2p/delete-photo.spec.ts -g "while Ben's phone is off"
 *
 * Ben, a Collaborator, deletes his own photo while Ada's phone is off: his album page names her phone
 * until it drops the photo, also after his restart, and his phone says so when it does:
 *
 *   pnpm test:e2e-p2p e2e/p2p/delete-photo.spec.ts -g "while Ada's phone is off"
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import type { Page } from "@playwright/test";
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import {
  askToJoin,
  copyInviteLink,
  createAlbum,
  pausePhone,
  restartPhone,
  setName,
  skipIntro,
  words,
} from "./steps";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ALBUM = "Delete trip";
const ANA = "del-ana.png";
const BEN = "del-ben.png";
const BEN2 = "del-ben2.png";

// The local DHT needs 5 nodes (apps/backend/scripts/local-dht.mjs): on 3, an idle
// album creator cannot NAT-sample enough nodes, aborts the joiner's holepunch,
// and the joiner times out. On failure the fixture attaches each instance's
// /__state and /__logs.
// Photo ids in one album's photo cache on an instance (spool names are base64url "driveKey:id:ext").
async function stateOf(page, instance) {
  const res = await page.context().request.get(new URL("/__state", instance.url).href);
  return res.json();
}

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
  return [...ids].sort((x, y) => x.localeCompare(y));
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

// Each row of the open "Who has this photo" sheet: its name and its badge's colour ("outline" when it has none).
async function sheetRows(page, name) {
  await page.getByRole("button", { name: words("gallery.view", { name }) }).click();
  await page.locator("[data-holders-row]").click();
  const sheet = page.getByRole("dialog", { name: words("photo_holders.who_has_this_photo") });
  const rows = await sheet
    .locator("li")
    .evaluateAll((lis) =>
      lis.map((li) => [
        li.querySelector(".text-fg")?.textContent?.trim(),
        li.querySelector("span[aria-hidden]")?.getAttribute("style") ?? "outline",
      ]),
    );
  await sheet.getByRole("button", { name: words("photo_holders.close") }).click();
  await page.getByRole("button", { name: words("lightbox.close") }).click();
  return rows;
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

  await expectBenLine(a, words("member.role_collaborator"));

  // Ana opens her photo: Ben's phone has only its preview. Her line then changes by itself, and the photo stays put, once Ben opens it.
  await a.getByRole("button", { name: `View ${ANA}` }).click();
  const anaLine = a.getByRole("button", { name: /show who has this photo$/ });
  await expect(anaLine).toContainText(/On your phone\. Preview on .+'s phone/, {
    timeout: 60_000,
  });
  const lightboxImage = a.locator('div.fixed [data-part="photo"] > img:not([data-part])');
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
    /.+'s phones? stops? showing it and drops? (its|their) cop(y|ies) once (it's|they're) connected\. Copies saved outside Justus can.t be taken back\./,
  );
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(a.getByRole("button", { name: "Close" })).toHaveCount(0, { timeout: 20_000 });
  await expect(a.getByRole("button", { name: `View ${ANA}` })).toHaveCount(0, { timeout: 20_000 });
  await expect(a.locator(".justus-toast", { hasText: `Deleted “${ANA}”.` })).toHaveText(
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
  await expect(sheet.locator('[data-copy-id="full_photo.only_preview"]')).toBeVisible({
    timeout: 60_000,
  });
  await b.keyboard.press("Escape");

  // Ben deletes his own photo through the menu; it leaves both phones.
  await b.getByRole("button", { name: "More options" }).click();
  await b.getByRole("menuitem", { name: "Delete" }).click();
  const benDialog = b.locator("wa-dialog[open]", { hasText: `Delete “${BEN}”?` });
  await expect(benDialog).toContainText(
    /.+'s phones? stops? showing it and drops? (its|their) cop(y|ies) once (it's|they're) connected\./,
  );
  await benDialog.getByRole("button", { name: "Delete" }).click();
  await expect(b.locator(".justus-toast", { hasText: `Deleted “${BEN}”.` })).toHaveText(
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
    .getByRole("button", { name: "Delete" })
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

test("a photo the Admin deletes while Ben's phone is off leaves his phone when it comes back", async ({
  instancePages,
  instances,
}) => {
  // +30 s over the off-wait: a second album and two sheet reads.
  test.setTimeout(270_000);
  const [a, b] = instancePages;
  const AWAY_ALBUM = "Away trip";
  const KEEP = "away-keep.png";
  const GONE = "away-gone.png";
  const view = (name) => a.getByRole("button", { name: words("gallery.view", { name }) });
  const viewB = (name) => b.getByRole("button", { name: words("gallery.view", { name }) });
  const stillLine = a.locator('[data-copy-id="gallery.still_to_drop"]');
  const stillWords = words("gallery.still_to_drop", { list: "Ben's", n: 1, photos: 1 });

  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, AWAY_ALBUM, KEEP, 51);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, AWAY_ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(words("album.wants_to_join", { folderName: AWAY_ALBUM }))).toBeVisible({
    timeout: 60_000,
  });
  await a.getByRole("button", { name: words("album.accept_as_collaborator"), exact: true }).click();
  await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
  // 60 s: the album and its photo sync to Ben's phone after Ada accepts.
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(viewB(KEEP)).toBeVisible({ timeout: 60_000 });
  const benFolder = new URL(b.url()).pathname.split("/").filter(Boolean)[1];

  // Ben opens each photo so his phone holds the full copy.
  async function benOpens(name) {
    await viewB(name).click();
    // 60 s: the full photo can take that long to arrive on a loaded runner.
    await expect(b.locator(".justus-holders-text"), `Ben opens ${name}`).toHaveText(
      words("holders.on_and_your_phone", { names: "Ada's" }),
      { timeout: 60_000 },
    );
    await b.getByRole("button", { name: words("lightbox.close") }).click();
    await expect(b.locator(".justus-holders-text")).toHaveCount(0);
  }
  await benOpens(KEEP);
  const keepIds = spoolIds(instances[1].storageDir, benFolder);
  expect(keepIds, "Ben's phone holds the kept photo").toHaveLength(1);

  await a.setInputFiles("input[type=file]", {
    name: GONE,
    mimeType: "image/png",
    buffer: pngOf(...runColour(53)),
  });
  // 60 s: the new photo syncs to Ben's phone.
  await expect(viewB(GONE)).toBeVisible({ timeout: 60_000 });
  await benOpens(GONE);
  expect(
    spoolIds(instances[1].storageDir, benFolder),
    "Ben's phone holds both photos",
  ).toHaveLength(2);

  // Ada's phone learns Ben has the full photo before he goes off; its delete warning names him only then.
  await view(GONE).click();
  // 60 s: Ben's phone tells Ada's phone it holds the photo.
  await expect(a.locator(".justus-holders-text"), "Ben on · Ada's phone: holders line").toHaveText(
    words("holders.on_and_your_phone", { names: "Ben's" }),
    { timeout: 60_000 },
  );
  await a.getByRole("button", { name: words("lightbox.close") }).click();
  await expect(a.locator(".justus-holders-text")).toHaveCount(0);

  // 60 s: Ada's phone shows Ben connected before he goes off; without this the off-wait below can pass at once.
  await expect(
    a.getByText(words("gallery.connected_now", { connected: 1 })),
    "Ben on · Ada's phone: connected",
  ).toBeVisible({ timeout: 60_000 });
  await expect(stillLine, "Ben on · Ada's album page: no line").toHaveCount(0);

  const benState = await stateOf(b, instances[1]);
  const benKey = benState.folders.find((f) => f.id === benFolder).selfDrive.key;
  const adaFolder = (await stateOf(a, instances[0])).folders.find(
    (f) => f.shareKey === benState.folders.find((x) => x.id === benFolder).shareKey,
  ).id;
  const stillToDropOnAda = async () =>
    (await stateOf(a, instances[0])).folders.find((f) => f.id === adaFolder).stillToDrop[benKey] ??
    [];
  const goneId = spoolIds(instances[1].storageDir, benFolder).find((id) => !keepIds.includes(id));

  let albumB = "";
  let aToasts;
  const resumeBen = await pausePhone(instances[1]);
  try {
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben off · Ada's phone: still connected",
    ).toHaveCount(0, { timeout: 120_000 });

    const albumA = new URL(a.url()).pathname;
    const inAlbum = await sheetRows(a, GONE);
    expect(inAlbum, "Ben off · Ada's sheet in its album").toEqual([
      ["You", expect.stringMatching(/^background:/)],
      ["Ben", expect.stringMatching(/^background:/)],
    ]);
    // Ada's last album is now another one, as when she browses Photos > All after opening it.
    await createAlbum(a, "Other trip", "other.png", 55);
    await a.getByRole("link", { name: words("gallery.all"), exact: true }).click();
    expect(await sheetRows(a, GONE), "Ben off · Photos > All, other album open").toEqual(inAlbum);
    const toastsBefore = await recordToasts(a);

    await view(GONE).click();
    await a.getByRole("button", { name: words("lightbox.more_options") }).click();
    await a.getByRole("menuitem", { name: words("lightbox.delete_2") }).click();
    const dialog = a.locator("wa-dialog[open]", {
      hasText: words("lightbox.delete", { name: GONE }),
    });
    await expect(dialog, "Ben off · Ada's dialog names Ben").toContainText(
      words("lightbox.phones_drop_copy", { list: "Ben's", n: 1 }),
    );
    await dialog.getByRole("button", { name: words("lightbox.delete_2") }).click();
    // 20 s: a local delete.
    await expect(view(GONE)).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(toastsBefore, {
        message: "Ben off · Photos > All: the delete toast says Ben sees it later",
      })
      .toContainEqual(
        expect.stringContaining(words("lightbox.will_see_it_when_connected", { list: "Ben" })),
      );
    // Back to Away trip: the still-to-drop line is on its page.
    await a.goto(albumA);
    // 20 s: the album list reloads after the page loads.
    await expect(view(KEEP)).toBeVisible({ timeout: 20_000 });
    // 20 s: the status read after the delete.
    await expect(stillLine, "Ben off · Ada's album page: Ben's phone still has it").toHaveText(
      stillWords,
      { timeout: 20_000 },
    );
    // 20 s: the next listing on Ada's phone after the delete.
    await expect
      .poll(stillToDropOnAda, {
        message: "Ben off · Ada's phone: Ben still has to drop it",
        timeout: 20_000,
      })
      .toEqual([goneId]);

    await restartPhone(a, instances[0]);
    await a.goto(albumA);
    // 60 s: Ada's phone starts again and reads Ben's record from its own copy while he is off.
    await expect(view(KEEP)).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(stillToDropOnAda, {
        message: "Ada restarted · Ada's phone: Ben still has to drop it",
        timeout: 60_000,
      })
      .toEqual([goneId]);
    await expect(
      stillLine,
      "Ada restarted · Ada's album page: Ben's phone still has it",
    ).toHaveText(stillWords, { timeout: 60_000 });
    aToasts = await recordToasts(a);

    albumB = new URL(b.url()).pathname;
    // Justus in the background: no screen asks Ben's phone to list the album.
    await b.goto("about:blank");
  } finally {
    resumeBen();
  }

  // 60 s: Ben's phone reconnects (2-16 s) and drops the deleted photo's cached copy.
  await expect
    .poll(() => spoolIds(instances[1].storageDir, benFolder), {
      message: "Ben back · Ben's phone: the deleted photo's cached copy is gone",
      timeout: 60_000,
    })
    .toEqual(keepIds);

  // 60 s: Ada's phone re-reads Ben's record once his phone has dropped the photo.
  await expect
    .poll(stillToDropOnAda, {
      message: "Ben back, Justus in the background · Ada's phone: read that Ben's phone dropped it",
      timeout: 60_000,
    })
    .toEqual([]);
  // 60 s: Ada's phone re-reads the status once Ben's record changes.
  await expect(stillLine, "Ben back · Ada's album page: the line is gone").toHaveCount(0, {
    timeout: 60_000,
  });
  // 20 s: the toast comes with the same re-read.
  await expect
    .poll(aToasts, {
      message: "Ben back · Ada's phone: Removed from Ben's phone.",
      timeout: 20_000,
    })
    .toContain(words("lightbox.removed_from_phones", { list: "Ben's", n: 1 }));

  await b.goto(albumB);
  // 60 s: Ben's app opens the album again.
  await expect(viewB(KEEP)).toBeVisible({ timeout: 60_000 });

  // Both phones read the kept photo's holders line and the other's presence dot.
  for (const [page, name, other, names] of [
    [a, KEEP, "Ben", "Ben's"],
    [b, KEEP, "Ada", "Ada's"],
  ]) {
    const who = page === a ? "Ada" : "Ben";
    await page.getByRole("button", { name: words("gallery.view", { name }) }).click();
    // 60 s: the full photo can take that long to arrive.
    await expect(page.locator(".justus-holders-text"), `${who}'s phone: holders line`).toHaveText(
      words("holders.on_and_your_phone", { names }),
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: words("lightbox.close") }).click();
    await page
      .getByRole("link", { name: new RegExp(words("gallery.invite_members")) })
      .first()
      .click();
    // 60 s: the phones find each other again after the resume.
    await expect(
      page
        .locator("li[data-member-key]", { hasText: other })
        .getByRole("img", { name: words("people.connected"), exact: true }),
      `${who}'s phone: ${other}'s presence dot`,
    ).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole("link", { name: words("album.see_photos_in_this_album") })
      .first()
      .click();
  }
});

test("a photo Ben deletes while Ada's phone is off leaves her phone when it comes back, and his page says so", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  const OWN_ALBUM = "Own delete trip";
  const KEEP = "own-keep.png";
  const GONE = "own-gone.png";
  const viewA = (name) => a.getByRole("button", { name: words("gallery.view", { name }) });
  const viewB = (name) => b.getByRole("button", { name: words("gallery.view", { name }) });
  const stillLine = b.locator('[data-copy-id="gallery.still_to_drop"]');
  const stillWords = words("gallery.still_to_drop", { list: "Ada's", n: 1, photos: 1 });

  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, OWN_ALBUM, KEEP, 61);
  const link = await copyInviteLink(a);
  await askToJoin(b, link, OWN_ALBUM);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(words("album.wants_to_join", { folderName: OWN_ALBUM }))).toBeVisible({
    timeout: 60_000,
  });
  await a.getByRole("button", { name: words("album.accept_as_collaborator"), exact: true }).click();
  await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
  // 60 s: the album and its photo sync to Ben's phone after Ada accepts.
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(viewB(KEEP)).toBeVisible({ timeout: 60_000 });
  // 60 s: Ben is a Viewer until the Admin's enrolment reaches his phone; adds before that are refused.
  await expect(
    b.getByRole("button", { name: words("gallery.add_photos_to", { name: OWN_ALBUM }) }),
  ).toBeVisible({
    timeout: 60_000,
  });
  const adaFolder = new URL(a.url()).pathname.split("/").filter(Boolean)[1];

  await b.setInputFiles("input[type=file]", {
    name: GONE,
    mimeType: "image/png",
    buffer: pngOf(...runColour(63)),
  });
  // 60 s: the new photo syncs to Ada's phone.
  await expect(viewA(GONE)).toBeVisible({ timeout: 60_000 });

  // Ada opens it, so her phone holds the full copy and her record names it.
  // Thumbnails already carry the photo's id, so count files: the full copy is one more file.
  const cacheOf = () => {
    try {
      return readdirSync(join(instances[0].storageDir, "cache", "photos", adaFolder)).length;
    } catch {
      return 0;
    }
  };
  const filesBefore = cacheOf();
  await viewA(GONE).click();
  // 60 s: Ben's phone tells Ada's phone it holds the photo, and the full photo arrives.
  await expect(a.locator(".justus-holders-text"), "Ada on · Ada's phone: holders line").toHaveText(
    words("holders.on_and_your_phone", { names: "Ben's" }),
    { timeout: 60_000 },
  );
  await a.getByRole("button", { name: words("lightbox.close") }).click();
  // 20 s: the full photo is written to Ada's cache.
  await expect
    .poll(cacheOf, {
      message: "Ada's cache · Ben's full photo",
      timeout: 20_000,
    })
    .toBeGreaterThan(filesBefore);

  // Ben's phone reads Ada's record naming the photo before she goes off; its delete warning and line name her only then.
  await viewB(GONE).click();
  // 60 s: Ada's phone tells Ben's phone it holds the full photo.
  await expect(b.locator(".justus-holders-text"), "Ada on · Ben's phone: Ada has it").toHaveText(
    words("holders.on_and_your_phone", { names: "Ada's" }),
    { timeout: 60_000 },
  );
  await b.getByRole("button", { name: words("lightbox.close") }).click();

  // 60 s: Ben's phone shows Ada connected before she goes off; without this the off-wait below can pass at once.
  await expect(
    b.getByText(words("gallery.connected_now", { connected: 1 })),
    "Ada on · Ben's phone: connected",
  ).toBeVisible({ timeout: 60_000 });

  // Ada's app in the background, cache wiped as every app shutdown does: her record still names the photo, her cache no longer has it.
  await a.goto("about:blank");
  rmSync(join(instances[0].storageDir, "cache", "photos", adaFolder), {
    recursive: true,
    force: true,
  });

  let bToasts;
  const resumeAda = await pausePhone(instances[0]);
  try {
    await expect(
      b.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ada off · Ben's phone: still connected",
    ).toHaveCount(0, { timeout: 120_000 });

    await viewB(GONE).click();
    await b.getByRole("button", { name: words("lightbox.more_options") }).click();
    await b.getByRole("menuitem", { name: words("lightbox.delete_2") }).click();
    const dialog = b.locator("wa-dialog[open]", {
      hasText: words("lightbox.delete", { name: GONE }),
    });
    await expect(dialog, "Ada off · Ben's dialog names Ada").toContainText(
      words("lightbox.phones_drop_copy", { list: "Ada's", n: 1 }),
    );
    await dialog.getByRole("button", { name: words("lightbox.delete_2") }).click();
    // 20 s: a local delete.
    await expect(viewB(GONE)).toHaveCount(0, { timeout: 20_000 });
    // 20 s: the status read after the delete.
    await expect(stillLine, "Ada off · Ben's album page: Ada's phone still has it").toHaveText(
      stillWords,
      { timeout: 20_000 },
    );

    const albumB = new URL(b.url()).pathname;
    await restartPhone(b, instances[1]);
    await b.goto(albumB);
    // 60 s: Ben's phone starts again.
    await expect(viewB(KEEP)).toBeVisible({ timeout: 60_000 });
    // 60 s: Ben's phone reads his own record of the delete from his drive.
    await expect(
      stillLine,
      "Ben restarted · Ben's album page: Ada's phone still has it",
    ).toHaveText(stillWords, { timeout: 60_000 });
    bToasts = await recordToasts(b);
  } finally {
    resumeAda();
  }

  // 60 s: Ada's phone reconnects (2-16 s), clears the bytes, and takes the photo off her record; Ben's phone reads that.
  await expect(stillLine, "Ada back · Ben's album page: the line is gone").toHaveCount(0, {
    timeout: 60_000,
  });
  // 20 s: the toast comes with the same read; the line hides while Ada is connected, so this is what proves the sweep.
  await expect
    .poll(bToasts, {
      message: "Ada back · Ben's phone: Removed from Ada's phone.",
      timeout: 20_000,
    })
    .toContain(words("lightbox.removed_from_phones", { list: "Ada's", n: 1 }));
});
