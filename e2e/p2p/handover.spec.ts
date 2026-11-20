/**
 * Three real bare instances, one story: Ada makes an album, Ben joins it, Cy asks with Ada's link,
 * Ada leaves by handing the album to Ben, and Ada's phone goes off. Ben's phone is the Admin from
 * then on: he sees the notice, accepts Cy, and Cy's phone lists Ben as the Admin and not Ada.
 * A second story has Cy already in the album as a Viewer: his page reads that Ada handed it to
 * Ben, in place of "You're now in", whether it was open at the handover or his phone was off.
 *
 * A second-and-a-half story has Ben join as a Viewer: Ada taps Hand over on his Members row, and his
 * phone is the Admin from then on.
 *
 * A third story has all three phones read every photo's holders line and every Members row before and
 * after the handover: Ada's photos stop naming her phone once the album has left it.
 *
 *   pnpm test:e2e-p2p e2e/p2p/handover.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import {
  askToJoin,
  closePhoto,
  copyInviteLink,
  createAlbum,
  pattern,
  pausePhone,
  restartPhone,
  resumeAll,
  skipIntro,
  words,
} from "./steps";

const NAMES = ["Ada", "Ben", "Cy"];
const PHOTOS = ["handover-ada.png", "handover-ada-2.png"];

async function expectLoaded(page, name) {
  const img = page.getByRole("button", { name: `View ${name}` }).locator("img");
  await expect(img).toBeAttached({ timeout: 60_000 });
  await expect
    .poll(() => img.evaluate((i) => i.naturalWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);
}
const before = [];

async function setName(page, name) {
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Your name", exact: true });
  const was = await field.inputValue();
  // A phone named by an earlier run (--repeat-each) keeps its name; filling it again appends.
  if (was === name) return was;
  await field.fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toHaveValue(name);
  return was;
}

async function leaveAlbum(page, album, instance) {
  // A run that failed before Cy got in has nothing to leave. Ask the backend: a page that has not loaded shows no albums either.
  const res = await page.context().request.get(new URL("/__state", instance.url).href);
  if ((await res.json()).folders.length === 0) return;
  await page.goto("/sharing");
  await page.getByRole("link", { name: `Invite & members of ${album}` }).click();
  const more = page.getByRole("button", { name: "More options" });
  await expect(more).toBeEnabled({ timeout: 30_000 });
  await more.click();
  await page.getByRole("menuitem", { name: words("album.leave_album") }).click();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page).toHaveURL(/\/sharing$/, { timeout: 30_000 });
}

test.afterEach(() => resumeAll());

test("Ada hands the album to Ben and leaves; Ben is the Admin, accepts Cy, and Cy's people list names Ben", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(360_000);
  const [a, b, c] = instancePages;
  const album = `Handover ${Date.now().toString(36)}`;
  try {
    await skipIntro([a, b, c]);
    for (const [i, page] of instancePages.entries()) before[i] = await setName(page, NAMES[i]);

    await createAlbum(a, album, "handover-ada.png", 91);
    await a.setInputFiles("input[type=file]", {
      name: "handover-ada-2.png",
      mimeType: "image/png",
      buffer: pngOf(...runColour(92)),
    });
    await expect(
      a.getByRole("button", { name: "View handover-ada-2.png" }).locator("img"),
    ).toBeAttached({
      timeout: 20_000,
    });
    const link = await copyInviteLink(a);
    const wants = words("album.wants_to_join", { folderName: album });

    // Ben joins as a Collaborator.
    await askToJoin(b, link, album);
    // 60 s: the join request travels over the hub to Ada's phone.
    await expect(a.getByText(wants)).toBeVisible({ timeout: 60_000 });
    await a
      .getByRole("button", { name: words("album.accept_as_collaborator"), exact: true })
      .click();
    // 60 s: the album reaches Ben's phone after Ada accepts.
    await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    const benAlbumPath = new URL(b.url()).pathname;

    // Cy asks with the same link and waits.
    await askToJoin(c, link, album);
    const cyDialog = c.getByRole("dialog", { name: pattern("invite.waiting_for_to_let_you_in") });
    // The three words show once the stored ask has them.
    await expect(cyDialog.locator(".text-lg")).toBeVisible({ timeout: 20_000 });
    const cyWords = await cyDialog.innerText();
    await c.goto("/sharing");
    await expect(
      c.getByRole("button", { name: `${words("albums.waiting_for_the_admin")}: ${album}` }),
      "Cy waits for the album's Admin",
    ).toBeVisible({ timeout: 20_000 });
    // 60 s: Cy's request travels over the hub to Ada's phone.
    await expect(a.getByText(wants).first()).toBeVisible({ timeout: 60_000 });

    // Ada hands the album to Ben. Her phone lists Ben as a Collaborator before Leave album shows.
    await a.goto("/sharing");
    await a.getByRole("link", { name: `Invite & members of ${album}` }).click();
    await expect(
      a
        .locator("li[data-member-key]")
        .filter({ hasText: "Ben" })
        .getByText(words("member.role_collaborator")),
    ).toBeVisible({ timeout: 60_000 });
    const id = new URL(a.url()).pathname.split("/").pop();
    await a.getByRole("button", { name: "More options" }).click();
    await a.getByRole("menuitem", { name: words("album.leave_album") }).click();
    const confirm = a.getByRole("dialog", {
      name: words("album.hand_over_title", { album, name: "Ben" }),
    });
    await expect(confirm, "Ada's confirm names Ben").toBeVisible();
    await a.getByRole("button", { name: words("album.hand_over_confirm"), exact: true }).click();

    // 90 s: Ben's phone has to take the album before it leaves Ada's. Her list is read from her
    // backend: a page that has not loaded yet shows no albums either.
    await expect
      .poll(
        async () => {
          const res = await a.context().request.get(new URL("/__state", instances[0].url).href);
          return (await res.json()).folders.some((f) => f.id === id);
        },
        { message: "the album leaves Ada's phone", timeout: 90_000, intervals: [200] },
      )
      .toBe(false);
    // Ada's open page follows without a reload: it leaves the album page, and the waiting line goes.
    await expect(a, "Ada's page leaves the album she handed on").toHaveURL(/\/sharing$/, {
      timeout: 30_000,
    });
    await expect(a.getByText(words("album.handing_over", { album, name: "Ben" }))).toHaveCount(0);
    await expect(a.getByRole("link", { name: `Invite & members of ${album}` })).toHaveCount(0);
    await pausePhone(instances[0]);

    // Ben reads the notice and sees Cy's request with the same three words.
    await b.goto(benAlbumPath.replace("/albums/", "/sharing/"));
    await expect(b.getByText(words("notices.made_admin", { fromName: "Ada", album }))).toBeVisible({
      timeout: 60_000,
    });
    await b.goto("/sharing");
    await b.getByRole("link", { name: `Invite & members of ${album}` }).click();
    const card = b.locator(".ui-request-card").filter({ hasText: "Cy" });
    // 60 s: Cy's request reaches Ben's phone with the album's lists.
    await expect(card.getByText(words("album.check_code"))).toBeVisible({ timeout: 60_000 });
    const code = (await card.locator(".text-lg").innerText()).trim();
    expect(cyWords, "Cy's screen shows the words on Ben's card").toContain(code);
    await card
      .getByRole("button", { name: words("album.accept_as_collaborator"), exact: true })
      .click();

    // Cy gets in; the people list names Ben as the Admin and does not list Ada.
    await expect(c).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    // Each phone gives the album its own id, so Cy's page has its own path.
    const cyAlbumPath = new URL(c.url()).pathname;
    await c.goto("/sharing");
    await c.getByRole("link", { name: `Invite & members of ${album}` }).click();
    const rows = c.locator("li[data-member-key]");
    await expect(
      rows
        .filter({ hasText: "Ben" })
        .getByText(words("member.handed_to", { fromName: "Ada", album, name: "Ben" })),
      "Cy's list: Ada left and handed the album to Ben",
    ).toBeVisible({ timeout: 60_000 });
    await expect(rows, "Cy's list: only Cy and Ben").toHaveCount(2);

    // Ben's phone took a copy of each of Ada's photos first: after a restart, both open on Ben's
    // phone with hers off.
    await restartPhone(b, instances[1]);
    await b.goto(benAlbumPath);
    for (const name of PHOTOS) await expectLoaded(b, name);

    // Cy sees and opens Ada's photos while Ada's phone is off.
    await c.goto(cyAlbumPath);
    for (const name of PHOTOS) await expectLoaded(c, name);

    // Ben, the Admin, deletes one of Ada's photos; it leaves Cy's phone too.
    await b.goto(benAlbumPath);
    await b.getByRole("button", { name: `View ${PHOTOS[0]}` }).click();
    await b.getByRole("button", { name: "More options" }).click();
    await b.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = b.locator("wa-dialog[open]", { hasText: `Delete “${PHOTOS[0]}”?` });
    await dialog.getByRole("button", { name: "Delete" }).click();
    for (const page of [b, c]) {
      await expect(page.getByRole("button", { name: `View ${PHOTOS[0]}` })).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(page.getByRole("button", { name: `View ${PHOTOS[1]}` })).toHaveCount(1);
    }
  } finally {
    // Instances keep their state across specs; later specs find rows by name. A name never set cannot be saved empty.
    resumeAll();
    // join-flow's first-run phone is this one: it must start without an album.
    await leaveAlbum(c, album, instances[2]);
    for (const [i, page] of instancePages.entries()) {
      if (before[i]) await setName(page, before[i]);
    }
  }
});

for (const cyOff of [false, true]) {
  test(`Cy, already in the album as a Viewer${cyOff ? " with his phone off at the handover" : ""}, reads that Ada handed it to Ben`, async ({
    instancePages,
    instances,
  }) => {
    test.setTimeout(360_000);
    const [a, b, c] = instancePages;
    const album = `Handover viewer ${Date.now().toString(36)}`;
    const beforeNames = [];
    try {
      await skipIntro([a, b, c]);
      for (const [i, page] of instancePages.entries())
        beforeNames[i] = await setName(page, NAMES[i]);

      await createAlbum(a, album, "handover-viewer.png", 93);
      const link = await copyInviteLink(a);
      const wants = words("album.wants_to_join", { folderName: album });

      await askToJoin(b, link, album);
      await expect(a.getByText(wants)).toBeVisible({ timeout: 60_000 });
      await a
        .getByRole("button", { name: words("album.accept_as_collaborator"), exact: true })
        .click();
      await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });

      await askToJoin(c, link, album);
      await expect(a.getByText(wants)).toBeVisible({ timeout: 60_000 });
      await a.getByRole("button", { name: words("album.accept_as_viewer"), exact: true }).click();
      await expect(c).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
      const cyAlbumPath = new URL(c.url()).pathname;
      await expect(c.getByText(words("notices.now_in_album", { albumName: album }))).toBeVisible();
      await expect(c.getByText(words("gallery.you_re_a_viewer_you", { who: "Ada" }))).toBeVisible();

      await a.goto("/sharing");
      await a.getByRole("link", { name: `Invite & members of ${album}` }).click();
      await expect(
        a
          .locator("li[data-member-key]")
          .filter({ hasText: "Ben" })
          .getByText(words("member.role_collaborator")),
      ).toBeVisible({ timeout: 60_000 });
      const id = new URL(a.url()).pathname.split("/").pop();
      const resumeCy = cyOff ? await pausePhone(instances[2]) : () => {};
      await a.getByRole("button", { name: "More options" }).click();
      await a.getByRole("menuitem", { name: words("album.leave_album") }).click();
      await a.getByRole("button", { name: words("album.hand_over_confirm"), exact: true }).click();
      await expect
        .poll(
          async () => {
            const res = await a.context().request.get(new URL("/__state", instances[0].url).href);
            return (await res.json()).folders.some((f) => f.id === id);
          },
          { message: "the album leaves Ada's phone", timeout: 90_000, intervals: [200] },
        )
        .toBe(false);
      resumeCy();
      if (cyOff) await c.goto(cyAlbumPath);

      const line = c.getByText(
        words("notices.admin_changed", { fromName: "Ada", album, name: "Ben" }),
      );
      await expect(line).toBeVisible({ timeout: 60_000 });
      await expect(c.getByText(words("notices.now_in_album", { albumName: album }))).toHaveCount(0);
      await expect(c.getByText(words("gallery.you_re_a_viewer_you", { who: "Ben" }))).toBeVisible();

      await c.getByRole("button", { name: `Dismiss notice about ${album}` }).click();
      await expect(line).toHaveCount(0);
      await c.goto(cyAlbumPath);
      await expect(c.getByText(words("gallery.you_re_a_viewer_you", { who: "Ben" }))).toBeVisible();
      await expect(line).toHaveCount(0);
    } finally {
      resumeAll();
      await leaveAlbum(c, album, instances[2]);
      for (const [i, page] of instancePages.entries()) {
        if (beforeNames[i]) await setName(page, beforeNames[i]);
      }
    }
  });
}

test("Ada hands the album to Ben, a Viewer, from his Members row; Ben's phone is the Admin", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(360_000);
  const [a, b] = instancePages;
  const album = `Handover row ${Date.now().toString(36)}`;
  const beforeNames = [];
  try {
    await skipIntro([a, b]);
    for (const [i, page] of [a, b].entries()) beforeNames[i] = await setName(page, NAMES[i]);

    await createAlbum(a, album, "handover-row.png", 94);
    const link = await copyInviteLink(a);
    await askToJoin(b, link, album);
    await expect(a.getByText(words("album.wants_to_join", { folderName: album }))).toBeVisible({
      timeout: 60_000,
    });
    await a.getByRole("button", { name: words("album.accept_as_viewer"), exact: true }).click();
    await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    const benAlbumPath = new URL(b.url()).pathname;
    await a.goto("/sharing");
    await a.getByRole("link", { name: `Invite & members of ${album}` }).click();
    const id = new URL(a.url()).pathname.split("/").pop();
    const row = a.locator("li[data-member-key]").filter({ hasText: "Ben" });
    await expect(row.getByText(words("member.role_viewer"))).toBeVisible({ timeout: 60_000 });

    const hand = row.getByRole("button", {
      name: words("album.hand_over_to", { album, name: "Ben" }),
      exact: true,
    });
    await expect(hand, "Ben's row offers the handover").toBeVisible();
    await hand.click();
    const confirm = a.getByRole("dialog", {
      name: words("album.hand_over_title", { album, name: "Ben" }),
    });
    await expect(confirm, "Ada's confirm names Ben").toBeVisible();
    await a.getByRole("button", { name: words("album.hand_over_confirm"), exact: true }).click();
    await expect
      .poll(
        async () => {
          const res = await a.context().request.get(new URL("/__state", instances[0].url).href);
          return (await res.json()).folders.some((f) => f.id === id);
        },
        { message: "the album leaves Ada's phone", timeout: 90_000, intervals: [200] },
      )
      .toBe(false);
    await expect(a).toHaveURL(/\/sharing$/, { timeout: 30_000 });

    await b.goto(benAlbumPath.replace("/albums/", "/sharing/"));
    await expect(b.getByText(words("notices.made_admin", { fromName: "Ada", album }))).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    resumeAll();
    for (const [i, page] of [a, b].entries()) {
      if (beforeNames[i]) await setName(page, beforeNames[i]);
    }
  }
});

/** Opens the photo, expects its holders line to read exactly `text`, and closes it. */
async function expectHoldersLine(page, step, phone, file, text) {
  await page.getByRole("button", { name: `View ${file}` }).click();
  // 60 s: the full photo can take that long to arrive on a loaded runner; the wait ends when the text matches.
  await expect(
    page.locator(".justus-holders-text"),
    `${step} · ${phone}'s phone: ${file}`,
  ).toHaveText(text, { timeout: 60_000 });
  await closePhoto(page);
}

async function addPhoto(page, file, colour) {
  await page.setInputFiles("input[type=file]", {
    name: file,
    mimeType: "image/png",
    buffer: pngOf(...runColour(colour)),
  });
  await expect(page.getByRole("button", { name: `View ${file}` }).locator("img")).toBeAttached({
    timeout: 20_000,
  });
}

async function expectMembers(page, album, step, phone, rows, inFull) {
  await page.goto("/sharing");
  await page.getByRole("link", { name: `Invite & members of ${album}` }).click();
  const list = page.locator("li[data-member-key]");
  // 60 s: the people list follows the handover over the hub.
  await expect(list, `${step} · ${phone}'s phone: Members rows`).toHaveCount(rows, {
    timeout: 60_000,
  });
  for (const row of await list.all()) {
    await expect(row, `${step} · ${phone}'s phone: Members row`).toContainText(
      words("members.n_in_full", { n: inFull }),
      { timeout: 60_000 },
    );
  }
}

test("after Ada hands the album to Ben, every holders line and Members row on all three phones is right", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(480_000);
  const [a, b, c] = instancePages;
  const album = `Handover holders ${Date.now().toString(36)}`;
  const ADA = "handover-holders-ada.png";
  const BEN = "handover-holders-ben.png";
  const BEN2 = "handover-holders-ben-2.png";
  const beforeNames = [];
  const line = (names) => words("holders.on_and_your_phone", { names });
  try {
    await skipIntro([a, b, c]);
    for (const [i, page] of instancePages.entries()) beforeNames[i] = await setName(page, NAMES[i]);

    await createAlbum(a, album, ADA, 94);
    const adaPath = new URL(a.url()).pathname;
    const link = await copyInviteLink(a);
    const wants = words("album.wants_to_join", { folderName: album });

    await askToJoin(b, link, album);
    await expect(a.getByText(wants)).toBeVisible({ timeout: 60_000 });
    await a
      .getByRole("button", { name: words("album.accept_as_collaborator"), exact: true })
      .click();
    await expect(b).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    const benPath = new URL(b.url()).pathname;

    await askToJoin(c, link, album);
    await expect(a.getByText(wants)).toBeVisible({ timeout: 60_000 });
    await a.getByRole("button", { name: words("album.accept_as_viewer"), exact: true }).click();
    await expect(c).toHaveURL(/\/albums\/[^/]+$/, { timeout: 60_000 });
    const cyPath = new URL(c.url()).pathname;

    await addPhoto(b, BEN, 95);
    await a.goto(adaPath);
    await expectLoaded(a, BEN);
    await expectLoaded(c, ADA);
    await expectLoaded(c, BEN);

    await a.goto(adaPath);
    await b.goto(benPath);
    await c.goto(cyPath);
    for (const file of [ADA, BEN]) {
      // Opening a photo gives that phone the full copy, so every line waits on the other phones' opens.
      await Promise.all([
        expectHoldersLine(c, "before", "Cy", file, line("Ada's, Ben's")),
        expectHoldersLine(b, "before", "Ben", file, line("Ada's, Cy's")),
        expectHoldersLine(a, "before", "Ada", file, line("Ben's, Cy's")),
      ]);
    }

    // Ada hands the album to Ben.
    await a.goto("/sharing");
    await a.getByRole("link", { name: `Invite & members of ${album}` }).click();
    await expect(
      a
        .locator("li[data-member-key]")
        .filter({ hasText: "Ben" })
        .getByText(words("member.role_collaborator")),
    ).toBeVisible({ timeout: 60_000 });
    const id = new URL(a.url()).pathname.split("/").pop();
    await a.getByRole("button", { name: "More options" }).click();
    await a.getByRole("menuitem", { name: words("album.leave_album") }).click();
    await a.getByRole("button", { name: words("album.hand_over_confirm"), exact: true }).click();
    await expect
      .poll(
        async () => {
          const res = await a.context().request.get(new URL("/__state", instances[0].url).href);
          return (await res.json()).folders.some((f) => f.id === id);
        },
        { message: "the album leaves Ada's phone", timeout: 90_000, intervals: [200] },
      )
      .toBe(false);

    // Ada's phone is still on: her photos no longer name it.
    for (const [page, phone] of [
      [b, "Ben"],
      [c, "Cy"],
    ]) {
      await expectMembers(page, album, "after, Ada on", phone, 2, 2);
    }
    await b.goto(benPath);
    await c.goto(cyPath);
    for (const file of [ADA, BEN]) {
      await Promise.all([
        expectHoldersLine(c, "after, Ada on", "Cy", file, line("Ben's")),
        expectHoldersLine(b, "after, Ada on", "Ben", file, line("Cy's")),
      ]);
    }

    // Ada's phone off: Ben adds a photo and all three lines still read the same.
    await pausePhone(instances[0]);
    await b.goto(benPath);
    await addPhoto(b, BEN2, 96);
    await expectLoaded(c, BEN2);
    await b.goto(benPath);
    await c.goto(cyPath);
    for (const file of [ADA, BEN, BEN2]) {
      await Promise.all([
        expectHoldersLine(c, "after, Ada off", "Cy", file, line("Ben's")),
        expectHoldersLine(b, "after, Ada off", "Ben", file, line("Cy's")),
      ]);
    }
    // Each phone has opened every photo by now, so the rows say all three are in full.
    for (const [page, phone] of [
      [b, "Ben"],
      [c, "Cy"],
    ]) {
      await expectMembers(page, album, "after, Ada off", phone, 2, 3);
    }
  } finally {
    resumeAll();
    await leaveAlbum(c, album, instances[2]);
    for (const [i, page] of instancePages.entries()) {
      if (beforeNames[i]) await setName(page, beforeNames[i]);
    }
  }
});
