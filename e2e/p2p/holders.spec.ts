/**
 * Two real bare instances, one story: Ada adds a photo, Ben joins, his phone has the preview, he opens it, Ben's phone is
 * taken off and back, Ada reads his row say Phone off and count up, Ada adds a photo while Ben's phone is off and its line names him, Ada adds two more photos and Members says what Ben's phone holds, both phones reload, each phone restarts while the other is off, Ada removes Ben, Ada deletes the photo. After each step the "who has this
 * photo" line is read on the phones that have one; a wrong line fails with the step, the phone,
 * and both texts.
 *
 *   pnpm test:e2e-p2p e2e/p2p/holders.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import {
  askToJoin,
  copyInviteLink,
  closePhoto,
  createAlbum,
  pausePhone,
  restartPhone,
  resumeAll,
  setName,
  skipIntro,
  words,
} from "./steps";

const ALBUM = "Holders trip";
const QUIET_ALBUM = "Holders quiet";
const FILE = "holders-ada.png";
/** Photos Ada adds after Ben joined; Ben never opens them, so his phone has only their previews. */
const MORE = ["holders-ada-2.png", "holders-ada-3.png"];
/** Added while Ben's phone is off. */
const LATER = "holders-ada-later.png";

test.afterEach(() => resumeAll());

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

/** Opens the open photo's sheet, expects its last lines to say no server keeps a copy and then that outside copies aren't listed, and closes it. */
async function expectSheetLastLines(page, step, phone) {
  await page.locator("[data-holders-row]").click();
  const sheet = page.getByRole("dialog", { name: words("photo_holders.who_has_this_photo") });
  await expect(
    sheet.locator('p:has([data-copy-id="photo_holders.no_server_keeps_a_copy"])'),
    `${step} · ${phone}'s phone: the sheet's last lines`,
  ).toHaveText(
    `${words("photo_holders.no_server_keeps_a_copy")} ${words("photo_holders.copies_outside_justus_not_listed")}`,
  );
  await sheet.getByRole("button", { name: words("photo_holders.close") }).click();
}

/** The Members row line for a friend whose phone is off. */
function phoneOff(when) {
  return words("people.phone_off_last_seen", { when: words("people.last_seen", { when }) });
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

  // Ben's phone fetches the preview by itself; the full photo comes only when he opens it.
  await expectHoldersLine(
    a,
    "Ben has the preview",
    "Ada",
    words("holders.line_and_preview", {
      line: words("holders.on_your_phone"),
      preview: words("holders.preview_on_names", { names: "Ben's", n: 1 }),
    }),
  );
  await expectHoldersLine(b, "open", "Ben", words("holders.on_and_your_phone", { names: "Ada's" }));
  await expectHoldersLine(a, "open", "Ada", words("holders.on_and_your_phone", { names: "Ben's" }));
}

test("a quiet phone's line says the day it last had it, also after a reload", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(360_000);
  const [a, b] = instancePages;
  await shareAlbum(instancePages, QUIET_ALBUM);
  await closePhoto(a);
  await closePhoto(b);
  const albumPath = new URL(a.url()).pathname;
  const memberRows = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  const benRow = memberRows.locator("[data-member-key]", { hasText: "Ben" });

  const resumeBen = await pausePhone(instances[1]);
  try {
    await a
      .getByRole("link", { name: /Invite & members/ })
      .first()
      .click();
    // 120 s: a frozen phone's connection times out in about 33 s, then the off rule waits 30 s and the clock moves every 15 s.
    await expect(
      benRow.locator("[data-member-presence]"),
      "Ben off · Ada's Members: Ben's row",
    ).toHaveText(phoneOff(words("time.just_now")), { timeout: 120_000 });
    // The row speaks "Phone off" once: the dot's own label is hidden from a screen reader.
    // The row's button line is what a screen reader says; its paragraphs below repeat its name.
    const rowName = (await benRow.ariaSnapshot())
      .split("\n")
      .find((l) => l.includes('button "Ben'));
    expect(
      (rowName ?? "").split(phoneOff(words("time.just_now"))).length - 1,
      "Ben off · Ada's Members: Ben's row says Phone off once",
    ).toBe(1);
    // Ada hears it: the app's status line says Ben's phone went off, in the row's words.
    const saidOff = words("people.presence_changed", {
      name: "Ben",
      presence: phoneOff(words("time.just_now")),
    });
    await expect(a.locator("[data-announce]"), "Ben off · Ada's status line").toHaveText(saidOff);
    // 60 s: the line appears 30-45 s after Ada's phone lost Ben and reads 1 min at 60-75 s; this proves the clock moves without a push.
    await expect(
      benRow.locator("[data-member-presence]"),
      "Ben off 1 min · Ada's Members: Ben's row",
    ).toHaveText(phoneOff(words("time.min_ago", { min: 1 })), { timeout: 60_000 });
    // Said once: the minute tick does not say it again.
    await expect(a.locator("[data-announce]"), "Ben off 1 min · Ada's status line").toHaveText(
      saidOff,
    );

    await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben off · Ada's phone: still connected",
    ).toHaveCount(0);

    // Ben holds the photo already: being off over a minute does not change Ada's line.
    await expectHoldersLine(
      a,
      "Ben off",
      "Ada",
      words("holders.on_and_your_phone", { names: "Ben's" }),
    );
    await closePhoto(a);

    // Ben's record reached Ada before he went off, so her new photo is waiting for his phone, not unknown.
    await a.setInputFiles("input[type=file]", {
      name: LATER,
      mimeType: "image/png",
      buffer: pngOf(...runColour(65)),
    });
    await a.getByRole("button", { name: `View ${LATER}` }).click({ timeout: 20_000 });
    await expect(
      a.locator(".justus-holders-text"),
      "Ben off, new photo · Ada's phone: holders line",
    ).toHaveText(
      words("holders.line_and_waiting", {
        line: words("holders.on_your_phone"),
        waiting: words("holders.waiting_for_names", { names: "Ben's", n: 1 }),
      }),
      { timeout: 60_000 },
    );
    await closePhoto(a);

    await a
      .getByRole("link", { name: /Invite & members/ })
      .first()
      .click();
    // 60 s: Ada's phone re-reads Ben's record after each of his changes.
    await expect(
      benRow.locator("[data-member-photos]"),
      "Ben off, new photo · Ada's Members: Ben's count",
    ).toHaveText(
      `${words("members.n_in_full", { n: 1 })}, ${words("members.n_waiting", { n: 1 })}`,
      { timeout: 60_000 },
    );
    await a.goto(albumPath);

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
    await expect(
      sheet.locator('[data-copy-id="photo_holders.copies_outside_justus_not_listed"]'),
      "sheet · Ada's phone: copies outside Justus line",
    ).toHaveText(words("photo_holders.copies_outside_justus_not_listed"));
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

  // Ben's phone fetches the waiting photo's preview after it reconnects.
  await closePhoto(a);
  await a.getByRole("button", { name: `View ${LATER}` }).click();
  // 60 s: Ben's phone fetches the preview after reconnecting.
  await expect(
    a.locator(".justus-holders-text"),
    "Ben back · Ada's phone: the new photo's line",
  ).toHaveText(
    words("holders.line_and_preview", {
      line: words("holders.on_your_phone"),
      preview: words("holders.preview_on_names", { names: "Ben's", n: 1 }),
    }),
    { timeout: 60_000 },
  );
  await closePhoto(a);
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  await expect(
    benRow.locator("[data-member-presence]"),
    "Ben back · Ada's Members: no Phone off line",
  ).toHaveCount(0);
  // 60 s: Ada's phone re-reads Ben's record once his preview lands.
  await expect(
    benRow.locator("[data-member-photos]"),
    "Ben back · Ada's Members: Ben's count",
  ).toHaveText(
    `${words("members.n_in_full", { n: 1 })}, ${words("members.n_previews", { n: 1 })}`,
    { timeout: 60_000 },
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

  // Ada adds two more photos; Ben's phone fetches their previews by itself and he opens neither.
  await a.setInputFiles(
    "input[type=file]",
    MORE.map((name, i) => ({ name, mimeType: "image/png", buffer: pngOf(...runColour(62 + i)) })),
  );
  for (const name of MORE) {
    await expect(b.getByRole("button", { name: `View ${name}` })).toBeVisible({ timeout: 60_000 });
  }
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const rows = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  // 60 s: Ada's phone re-reads Ben's record after each of his changes.
  await expect(
    rows.locator("[data-member-key]", { hasText: "Ben" }).locator("[data-member-photos]"),
    "Ben has 1 photo and 2 previews · Members: Ben's row",
  ).toHaveText(
    `${words("members.n_in_full", { n: 1 })}, ${words("members.n_previews", { n: 2 })}`,
    {
      timeout: 60_000,
    },
  );
  await expect(
    rows.locator("[data-member-key]", { hasText: "Ada" }).locator("[data-member-photos]"),
    "Ben has 1 photo and 2 previews · Members: Ada's row",
  ).toHaveText(words("members.n_in_full", { n: 3 }));
  await b
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();
  const bRows = b.locator("section", { has: b.getByRole("heading", { name: "Members" }) });
  await expect(
    bRows.locator("[data-member-key]", { hasText: "Ben" }).locator("[data-member-photos]"),
    "Ben has 1 photo and 2 previews · Ben's Members: Ben's own row",
  ).toHaveText(
    `${words("members.n_in_full", { n: 1 })}, ${words("members.n_previews", { n: 2 })}`,
    {
      timeout: 60_000,
    },
  );
  await b.getByRole("link", { name: "See photos in this album" }).click();
  await a.getByRole("link", { name: "See photos in this album" }).click();

  const resume = await pausePhone(instances[1]);
  try {
    await expect(
      a.getByText(words("gallery.connected_now", { connected: 1 })),
      "Ben off · Ada's phone: still connected",
    ).toHaveCount(0, { timeout: 120_000 });
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
  await expectSheetLastLines(a, "reload", "Ada");
  await expectSheetLastLines(b, "reload", "Ben");
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
