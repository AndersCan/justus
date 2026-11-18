/**
 * Two real bare instances, one story: Ada adds a photo, Ben joins and opens it, Ben's phone is
 * taken off and back, both phones reload, each phone restarts while the other is off, Ada removes Ben, Ada deletes the photo. After each step the "who has this
 * photo" line is read on the phones that have one; a wrong line fails with the step, the phone,
 * and both texts.
 *
 *   pnpm test:e2e-p2p e2e/p2p/holders.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../hub/fixtures.mjs";
import {
  askToJoin,
  copyInviteLink,
  createAlbum,
  pausePhone,
  restartPhone,
  resumeAll,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Holders trip";
const QUIET_ALBUM = "Holders quiet";
const FILE = "holders-ada.png";

test.afterEach(() => resumeAll());

async function setName(page, name) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Your name", exact: true });
  await field.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveValue(name);
}

/** Opens the photo if none is open, then expects its holders line to read exactly `text`. */
async function expectHoldersLine(page, step, phone, text) {
  const line = page.locator(".justus-holders-text");
  if ((await line.count()) === 0) {
    await page.getByRole("button", { name: `View ${FILE}` }).click();
  }
  // 60 s: the full photo can take that long to arrive on a loaded runner; the wait ends when the text matches.
  await expect(line, `${step} · ${phone}'s phone: holders line`).toHaveText(text, {
    timeout: 60_000,
  });
}

async function stateOf(page, instance) {
  const res = await page.context().request.get(new URL("/__state", instance.url).href);
  return res.json();
}

/** Polls until `from`'s phone lists `to`'s current swarm key among its connections. */
async function connected(from, fromInstance, toInstance, label) {
  // 60 s: reconnecting took 2-16 s, plus ~30 s for a stale connection to close.
  await expect
    .poll(
      async () => {
        const [f, t] = await Promise.all([stateOf(from, fromInstance), stateOf(from, toInstance)]);
        return f.connections.some((c) => c.noiseKey === t.swarmKey);
      },
      { message: label, timeout: 60_000, intervals: [100] },
    )
    .toBe(true);
}

async function closePhoto(page) {
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".justus-holders-text")).toHaveCount(0);
}

/** Ada adds a photo, Ben joins and opens it; both phones read their "On … phone" line. */
async function shareAlbum(instancePages, album) {
  const [a, b] = instancePages;
  await skipIntro([a, b]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await createAlbum(a, album, FILE, 61);

  await expectHoldersLine(a, "add", "Ada", words("holders.only_on_your_phone"));
  await closePhoto(a);

  const link = await copyInviteLink(a);
  await askToJoin(b, link, album);
  // 60 s: the join request travels over the hub to Ada's phone.
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();
  // 60 s: the album and its photo sync to Ben's phone after Ada accepts.
  await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
  await expect(b.getByRole("button", { name: `View ${FILE}` })).toBeVisible({ timeout: 60_000 });

  await expectHoldersLine(a, "join", "Ada", words("holders.only_on_your_phone_so"));
  await expectHoldersLine(b, "open", "Ben", words("holders.on_and_your_phone", { names: "Ada's" }));
  await expectHoldersLine(a, "open", "Ada", words("holders.on_and_your_phone", { names: "Ben's" }));
}

test("a quiet phone's line says the day it last had it, also after a reload", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await shareAlbum(instancePages, QUIET_ALBUM);
  await closePhoto(a);
  await closePhoto(b);
  const albumPath = new URL(a.url()).pathname;

  const resumeBen = await pausePhone(instances[1]);
  try {
    // 90 s: Ada's phone drops a gone peer when its connection times out, about 33 s.
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben off · Ada's phone: still connected",
    ).toHaveCount(0, { timeout: 90_000 });

    // Ben has been away for seconds: Ada's line stays calm.
    await expectHoldersLine(
      a,
      "Ben off",
      "Ada",
      words("holders.on_and_your_phone", { names: "Ben's" }),
    );

    // Ada's phone remembers Ben was last seen 5 days ago, across a restart.
    const at = Date.now() - 5 * 24 * 3600 * 1000;
    await restartPhone(a, instances[0], {
      beforeKill: () => {
        const file = join(instances[0].storageDir, "presence.json");
        const seen = JSON.parse(readFileSync(file, "utf8"));
        const keys = Object.keys(seen);
        expect(keys.length, "Ben off · Ada's phone: presence.json has Ben's key").toBeGreaterThan(
          0,
        );
        writeFileSync(file, JSON.stringify(Object.fromEntries(keys.map((k) => [k, at]))));
      },
    });
    await a.goto(albumPath);

    const weekday = await a.evaluate(
      (t) => new Date(t).toLocaleDateString("en-US", { weekday: "long" }),
      at,
    );
    const quietLine = words("holders.line_and_quiet", {
      line: words("holders.on_your_phone"),
      quiet: words("holders.quiet_one_when", { name: "Ben's", when: weekday }),
    });
    await expectHoldersLine(a, "Ada restarted, Ben away 5 days", "Ada", quietLine);

    await a.locator("[data-holders-row]").click();
    const sheet = a.getByRole("dialog", { name: words("photo_holders.who_has_this_photo") });
    await expect(
      sheet.getByRole("heading", { name: words("photo_holders.last_had_full_photo") }),
      "sheet · Ada's phone: Last had the full photo heading",
    ).toBeVisible();
    await expect(
      sheet
        .getByRole("heading", { name: words("full_photo.has"), exact: true })
        .locator("xpath=following-sibling::ul[1]/li"),
      "sheet · Ada's phone: Has the full photo lists only You",
    ).toHaveText([new RegExp(`\\b${words("photo_holders.you")}\\b`)]);
    await expect(
      sheet.getByText(words("photo_holders.last_confirmed", { when: weekday })),
      "sheet · Ada's phone: Ben's day",
    ).toBeVisible();
    await expect(
      sheet.getByText(words("photo_holders.off_or_wiped", { names: "Ben" })),
      "sheet · Ada's phone: the note",
    ).toBeVisible();
    await sheet.getByRole("button", { name: words("photo_holders.close") }).click();
    await closePhoto(a);

    await a.reload();
    await expectHoldersLine(a, "reload", "Ada", quietLine);
    await closePhoto(a);
  } finally {
    resumeBen();
  }

  // 60 s: reconnecting after a resume took 2-16 s.
  await expect(
    a.getByText(words("gallery.connected_now", { connected: 1 })),
    "Ben back: Ada's phone connected",
  ).toBeVisible({ timeout: 60_000 });
  await expectHoldersLine(
    a,
    "Ben back",
    "Ada",
    words("holders.on_and_your_phone", { names: "Ben's" }),
  );
});

test("every holders line reads right on both phones from add to delete, across a reload and app restarts", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  await shareAlbum(instancePages, ALBUM);
  await closePhoto(a);
  await closePhoto(b);

  const resume = await pausePhone(instances[1]);
  try {
    // 90 s: Ada's phone drops a gone peer when its connection times out, about 33 s.
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben off · Ada's phone: still connected",
    ).toHaveCount(0, { timeout: 90_000 });
    await expectHoldersLine(
      a,
      "Ben off",
      "Ada",
      words("holders.on_and_your_phone", { names: "Ben's" }),
    );
    await closePhoto(a);
  } finally {
    resume();
  }
  // 60 s: reconnecting after a resume took 2-16 s; the removal must reach Ben.
  for (const page of [a, b]) {
    await expect(
      page.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben back: both phones connected",
    ).toBeVisible({ timeout: 60_000 });
  }

  const albumPath = { a: new URL(a.url()).pathname, b: new URL(b.url()).pathname };
  const albumId = albumPath.a.split("/").pop();
  // Both phones reload.
  await a.reload();
  await b.reload();
  await expectHoldersLine(
    a,
    "reload",
    "Ada",
    words("holders.on_and_your_phone", { names: "Ben's" }),
  );
  await expectHoldersLine(
    b,
    "reload",
    "Ben",
    words("holders.on_and_your_phone", { names: "Ada's" }),
  );
  await closePhoto(a);
  await closePhoto(b);

  // Ada restarts while Ben is off: her phone writes its boot record, which Ben will hear of.
  const resumeBen = await pausePhone(instances[1]);
  try {
    await restartPhone(a, instances[0]);
  } finally {
    resumeBen();
  }
  // Wait until Ada is connected to Ben and Ben's copy of her album knows her newest write, then
  // take Ada off before Ben's 400 ms read fetches it.
  await expect
    .poll(
      async () => {
        const [ada, ben] = await Promise.all([stateOf(a, instances[0]), stateOf(b, instances[1])]);
        const adaAlbum = ada.folders.find((f) => f.id === albumId);
        const benAlbum = ben.folders.find((f) => f.shareKey === adaAlbum?.shareKey);
        return (
          ada.connections.some((c) => c.noiseKey === ben.swarmKey) &&
          benAlbum?.folderDrive.length === adaAlbum.folderDrive.length
        );
      },
      // 60 s: reconnecting took 2-16 s, plus ~30 s for a stale connection to close.
      { message: "Ben heard of Ada's restart", timeout: 60_000, intervals: [50] },
    )
    .toBe(true);

  // Ben restarts while Ada is off: his phone opens and reads her album with nobody to ask.
  const resumeAda = await pausePhone(instances[0]);
  try {
    await restartPhone(b, instances[1]);
    await expectHoldersLine(
      b,
      "Ben restarted, Ada off",
      "Ben",
      words("holders.on_and_your_phone", { names: "Ada's" }),
    );
    await closePhoto(b);
  } finally {
    resumeAda();
  }
  await connected(a, instances[0], instances[1], "Ada's phone: connected to Ben's restarted phone");
  await connected(b, instances[1], instances[0], "Ben's phone: connected to Ada's phone");
  // The restarted phones start at /index.html; open the album again.
  await a.goto(albumPath.a);
  await b.goto(albumPath.b);

  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const people = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await people.getByRole("button", { name: /^Remove /, exact: false }).click();
  await a.getByRole("button", { name: "Remove", exact: true }).last().click();
  // 60 s: the removal syncs to both phones over the hub.
  await expect(a.getByText(`is no longer in ${ALBUM}`)).toBeVisible({ timeout: 60_000 });
  await expect(b.getByText(words("gallery.you_re_no_longer_in", { name: ALBUM }))).toBeVisible({
    timeout: 60_000,
  });

  await a.getByRole("link", { name: "See photos in this album" }).click();
  await expectHoldersLine(
    a,
    "remove",
    "Ada",
    words("holders.on_your_phone_name_removed", { name: "Ben" }),
  );
  await expectHoldersLine(b, "remove", "Ben", words("holders.on_your_phone_removed"));
  await closePhoto(b);

  await a.getByRole("button", { name: "More options" }).click();
  await a.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = a.locator("wa-dialog[open]", { hasText: `Delete “${FILE}”?` });
  await expect(dialog, "delete · Ada's phone: dialog").toContainText(
    words("full_photo.name_removed_keeps", { name: "Ben" }),
  );
  await dialog.getByRole("button", { name: "Delete" }).click();
  // 20 s: a local delete.
  await expect(a.getByRole("button", { name: `View ${FILE}` })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expectHoldersLine(b, "delete", "Ben", words("holders.on_your_phone_removed"));
});

const VIEWERS_ALBUM = "Holders viewers";

/** Opens the photo if none is open, then its "Who has this photo" sheet. */
async function openSheet(page) {
  if ((await page.locator(".justus-holders-text").count()) === 0) {
    await page.getByRole("button", { name: `View ${FILE}` }).click();
  }
  await page.locator("[data-holders-row]").click();
  return page.getByRole("dialog", { name: words("photo_holders.who_has_this_photo") });
}

/** The names listed under the sheet heading with copy id `id`. */
const namesUnder = (sheet, id) => sheet.locator(`h4:has([data-copy-id="${id}"]) + ul li .text-fg`);

/** Expects the sheet to list `full` under "Has the full photo", `preview` under "Has the preview", and nobody under "Hasn't said yet". */
async function expectSheet(page, step, phone, { full, preview }) {
  const sheet = await openSheet(page);
  // 60 s: the other phone's record replicates over the hub.
  await expect(
    namesUnder(sheet, "full_photo.has"),
    `${step} · ${phone}'s sheet: full photo`,
  ).toHaveText(full, { timeout: 60_000 });
  await expect(
    namesUnder(sheet, "full_photo.only_preview"),
    `${step} · ${phone}'s sheet: preview`,
  ).toHaveText(preview, { timeout: 60_000 });
  await expect(
    sheet.locator('[data-copy-id="photo_holders.hasn_t_said_yet"]'),
    `${step} · ${phone}'s sheet: hasn't said yet`,
  ).toHaveCount(0);
  await sheet.locator('[data-copy-id="photo_holders.close"]').click();
  await expect(sheet).toHaveCount(0);
  await closePhoto(page);
}

test("a Viewer's sheet names what another Viewer's phone has, as the Admin's does, also after a reload", async ({
  instancePages,
}) => {
  test.setTimeout(180_000);
  const [a, b, c] = instancePages;
  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, VIEWERS_ALBUM, FILE, 71);
  for (const page of [b, c]) {
    const link = await copyInviteLink(a);
    await askToJoin(page, link, VIEWERS_ALBUM);
    // 60 s: the join request travels over the hub to Ada's phone.
    await expect(a.getByText(`wants to join “${VIEWERS_ALBUM}”`)).toBeVisible({ timeout: 60_000 });
    await a.getByRole("button", { name: "Accept, can only look", exact: true }).click();
    await a.getByRole("link", { name: "See photos in this album" }).click();
    // 60 s: the album and its photo sync to the joiner after Ada accepts.
    await expect(page).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    await expect(page.getByRole("button", { name: `View ${FILE}` })).toBeVisible({
      timeout: 60_000,
    });
  }
  const you = words("photo_holders.you");
  await expectSheet(b, "Cy previewed", "Ben", { full: [you, "Ada"], preview: ["Cy"] });
  await expectSheet(a, "Cy previewed", "Ada", { full: [you, "Ben"], preview: ["Cy"] });
  await b.reload();
  await expectSheet(b, "Ben reloaded", "Ben", { full: [you, "Ada"], preview: ["Cy"] });
});
