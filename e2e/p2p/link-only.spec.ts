/**
 * A phone that holds only the invite link never gets the album key, a photo or another
 * member's key, in what it stored, in every answer message that reached it, or on its disk.
 * The stranger is instance 2; instances keep earlier specs' state, so every secret is per album.
 * The removed test adds Cleo (instance 3), who stays in and follows the move.
 *
 *   pnpm test:e2e-p2p e2e/p2p/link-only.spec.ts
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../hub/fixtures.mjs";
import { pngOf, runColour } from "../add-photos.js";
import { askToJoin, copyInviteLink, createAlbum, skipIntro } from "./steps";

const catalogue = JSON.parse(
  readFileSync(new URL("../../apps/web/src/copy/en.json", import.meta.url), "utf8"),
);
const words = (id, params = {}) =>
  catalogue[id].text.replace(/\{(\w+)\}/g, (whole, k) => String(params[k] ?? whole));
// The text of an id as a pattern, a name or number standing for each placeholder.
const pattern = (id) =>
  new RegExp(
    catalogue[id].text
      .split(/\{\w+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+"),
  );

async function stateOf(page, inst) {
  const res = await page.context().request.get(new URL("/__state", inst.url).href);
  return res.json();
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) out.push(...filesUnder(path));
      else out.push(path);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return out;
}

/** Where on the stranger's phone each secret shows up: store, network (answers received), disk. */
async function leaksOn(page, inst, secrets) {
  const state = await stateOf(page, inst);
  if (!Array.isArray(state.answersIn)) {
    throw new Error("answersIn missing: /__state has no recorder");
  }
  const { answersIn, ...store } = state;
  const storeText = JSON.stringify(store).toLowerCase();
  const found = [];
  for (const s of secrets) {
    if (s.hex && storeText.includes(s.hex)) found.push(`store: ${s.label}`);
    for (const m of answersIn) {
      if (s.hex && m.text.toLowerCase().includes(s.hex)) {
        found.push(`network: ${s.label} (conn ${m.conn}, at ${m.at})`);
      }
    }
  }
  let sawFile = false;
  for (const file of filesUnder(inst.storageDir)) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    sawFile = true;
    const rel = file.slice(inst.storageDir.length + 1);
    for (const s of secrets) {
      if (s.hex) {
        if (bytes.includes(s.hex) || bytes.includes(Buffer.from(s.hex, "hex"))) {
          found.push(`disk: ${rel}: ${s.label}`);
        }
      }
      if (s.bytes && bytes.includes(s.bytes)) found.push(`disk: ${rel}: ${s.label}`);
    }
  }
  // A wrong storage dir would scan nothing and pass; fail instead.
  if (!sawFile) throw new Error(`no files under ${inst.storageDir}`);
  return found;
}

/** A negative check has no event to wait for: hold for `ms`, failing at the first leak. */
async function staysClean(page, inst, secrets, step, ms = 5_000) {
  const end = Date.now() + ms;
  do {
    expect(await leaksOn(page, inst, secrets), step).toEqual([]);
    await page.waitForTimeout(500);
  } while (Date.now() < end);
}

async function folderOf(page, inst, id) {
  const folder = (await stateOf(page, inst)).folders.find((f) => f.id === id);
  expect(folder, `folder ${id} in /__state`).toBeTruthy();
  return folder;
}

async function answerSince(page, inst, word, t0) {
  return (await stateOf(page, inst)).answersIn.some((m) => m.at >= t0 && m.text.includes(word));
}

/** Flags in `window.__photoSeen` any node or attribute on `page` that shows one of `names`: a photo file or a name only the link carries. */
async function watchNames(page, names) {
  const watch = (list) => {
    const hit = (text) => list.some((n) => text.includes(n));
    // The warning block names the link's album next to the real one on purpose.
    const inWarning = (node) =>
      (node.nodeType === 1 ? node : node.parentElement)?.closest("[data-link-named-other]") !==
      null;
    const scan = (node) => {
      if (inWarning(node)) return;
      if (node.nodeType === 3 && hit(node.data)) window.__photoSeen = true;
      if (node.nodeType !== 1) return;
      for (const attr of node.attributes) if (hit(attr.value)) window.__photoSeen = true;
      node.childNodes.forEach(scan);
    };
    window.__photoSeen = false;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") scan(r.target);
        else if (r.type === "characterData") scan(r.target);
        else r.addedNodes.forEach(scan);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    scan(document.documentElement);
  };
  await page.addInitScript(watch, names);
  await page.evaluate(watch, names);
}

const photoSeen = (page) => page.evaluate(() => window.__photoSeen === true);

const keyOf = (hex) => ({ label: "album key", hex });

/** The photo files Ada's phone keeps for album `id`: what a phone holding the photo has on disk. */
function photosOf(inst, id) {
  const dir = join(inst.storageDir, "cache", "photos", id);
  return readdirSync(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)) }));
}

test("a link holder with an edited link who opens, asks, waits, is declined, asks again and cancels sees the link's album only in the warning beside the real one, never the key, the photo or the member list", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b, c] = instancePages;
  const [aInst, bInst, cInst] = instances;
  await skipIntro([a, b, c]);
  const album = `Link only ${Date.now().toString(36)}`;
  const P1 = "link-only-1.png";
  await createAlbum(a, album, P1, 71);
  const id = new URL(a.url()).pathname.split("/").pop();
  const link = await copyInviteLink(a);

  await askToJoin(c, link, album);
  await expect(a.getByText(words("album.wants_to_join", { folderName: album }))).toBeVisible({
    timeout: 60_000,
  });
  // An unedited link names the same album: no warning.
  await expect(c.locator("[data-link-named-other]")).toHaveCount(0);
  await a.getByRole("button", { name: words("album.accept_as_collaborator"), exact: true }).click();
  await expect(c.getByRole("button", { name: `Add photos to ${album}` })).toBeVisible({
    timeout: 60_000,
  });
  const shareKey = (await folderOf(a, aInst, id)).shareKey;
  const cFolder = (await stateOf(c, cInst)).folders.find((f) => f.shareKey === shareKey);
  expect(cFolder, "C holds the album").toBeTruthy();
  const cKey = cFolder.selfDrive.key;
  expect(shareKey).toMatch(/^[0-9a-f]{64}$/);
  expect(cKey).toMatch(/^[0-9a-f]{64}$/);
  const secrets = [
    { label: "album key", hex: shareKey },
    { label: "other member's key", hex: cKey },
    ...photosOf(aInst, id).map((p) => ({ label: "photo bytes", bytes: p.bytes })),
  ];
  expect(secrets.length, "Ada keeps the photo").toBeGreaterThan(2);
  const t0 = Date.now();
  const tag = Date.now().toString(36);
  const hash = new URLSearchParams(new URL(link).hash.slice(1));
  const hintAlbum = `Holiday ${tag}`;
  const hintOwner = `Mallory ${tag}`;
  const adaName = hash.get("a");
  expect(adaName, "the link carries Ada's name").toBeTruthy();
  hash.set("n", hintAlbum);
  hash.set("a", hintOwner);
  const edited = `${link.split("#")[0]}#${hash.toString()}`;
  await watchNames(b, [P1, hintAlbum, hintOwner]);

  // Opens the tapped link and does not ask.
  await b.goto("/");
  await b.evaluate(
    (l) => window.dispatchEvent(new CustomEvent("justus:invite", { detail: l })),
    edited,
  );
  const sheet = b.getByRole("dialog", { name: words("invite.ask_to_join_unnamed") });
  await expect(sheet).toBeVisible({ timeout: 60_000 });
  await staysClean(b, bInst, secrets, "opened the link");
  expect(await photoSeen(b), "photo name on screen: opened the link").toBe(false);
  await sheet.getByRole("button", { name: words("invite.not_now"), exact: true }).click();

  // Asks and waits.
  const asked = Date.now();
  await askToJoin(b, edited, album);
  await expect(a.getByText(words("album.wants_to_join", { folderName: album }))).toBeVisible({
    timeout: 60_000,
  });
  const waiting = b.getByRole("dialog", {
    name: words("invite.waiting_for_to_let_you_in", { owner: adaName }),
  });
  await expect(waiting).toContainText(album, { timeout: 60_000 });
  await expect(waiting.locator("[data-link-named-other]")).toContainText(
    words("invite.link_named_other_album", { linkAlbum: hintAlbum, album, owner: adaName }),
  );
  await expect(
    waiting.getByRole("button", { name: words("invite.cancel_request"), exact: true }),
  ).toHaveClass(/ui-btn-primary/);
  await expect.poll(() => answerSince(b, bInst, "received", asked), { timeout: 30_000 }).toBe(true);
  expect((await stateOf(b, bInst)).asks.some((x) => x.status === "waiting")).toBe(true);
  await staysClean(b, bInst, secrets, "waiting");
  expect(await photoSeen(b), "photo name on screen: waiting").toBe(false);

  // Declined.
  await a.getByRole("button", { name: words("album.decline"), exact: true }).click();
  await expect(b.getByText(pattern("invite.didn_t_accept_your_request"))).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => answerSince(b, bInst, "declined", t0), { timeout: 30_000 }).toBe(true);
  await staysClean(b, bInst, secrets, "declined");
  expect(await photoSeen(b), "photo name on screen: declined").toBe(false);

  // Asks again.
  await b.getByRole("button", { name: words("invite.ask_again"), exact: true }).click();
  await expect(a.getByText(words("album.wants_to_join", { folderName: album }))).toBeVisible({
    timeout: 60_000,
  });
  await staysClean(b, bInst, secrets, "asks again");
  expect(await photoSeen(b), "photo name on screen: asks again").toBe(false);

  // Cancels.
  await b.goto("/join");
  await b
    .getByRole("button", {
      name: new RegExp(`^${pattern("albums.waiting_for_the_admin").source}: ${album}$`),
    })
    .click();
  await b.getByRole("button", { name: words("invite.cancel_request"), exact: true }).click();
  await expect(b.getByRole("button", { name: new RegExp(album) })).toHaveCount(0);
  await staysClean(b, bInst, secrets, "cancelled");
  expect(await photoSeen(b), "photo name on screen: cancelled").toBe(false);
  await expect(b.locator("img")).toHaveCount(0);
});

async function nameIs(page, name) {
  await page.goto("/settings");
  const box = page.getByRole("textbox", { name: words("settings.your_name"), exact: true });
  await box.fill(name);
  await page.getByRole("button", { name: words("settings.save"), exact: true }).click();
  await expect(box).toHaveValue(name);
}

test("a removed person never gets the new key or a later photo, even after a Collaborator followed the move and a reload; the old link does not let them back", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b, c] = instancePages;
  const [aInst, bInst, cInst] = instances;
  await skipIntro([a, b, c]);
  await nameIs(b, "Ben");
  await nameIs(c, "Cleo");
  const album = `Link removed ${Date.now().toString(36)}`;
  await createAlbum(a, album, "link-removed-1.png", 73);
  const id = new URL(a.url()).pathname.split("/").pop();
  const link = await copyInviteLink(a);

  for (const joiner of [b, c]) {
    await askToJoin(joiner, link, album);
    await expect(a.getByText(words("album.wants_to_join", { folderName: album }))).toBeVisible({
      timeout: 60_000,
    });
    await a
      .getByRole("button", { name: words("album.accept_as_collaborator"), exact: true })
      .click();
    await expect(
      joiner.getByRole("button", { name: words("gallery.add_photos_to", { name: album }) }),
    ).toBeVisible({ timeout: 60_000 });
  }
  const cIdentity = (await stateOf(c, cInst)).identityDrive;
  const oldKey = (await folderOf(a, aInst, id)).shareKey;
  // The scanner must find a key the stranger really holds, in the store and on disk.
  const held = await leaksOn(b, bInst, [keyOf(oldKey)]);
  expect(held.some((h) => h.startsWith("store:"))).toBe(true);
  expect(held.some((h) => h.startsWith("disk:"))).toBe(true);
  // ...and a photo it really holds.
  const p1 = photosOf(aInst, id);
  await expect
    .poll(async () =>
      leaksOn(
        b,
        bInst,
        p1.map((p) => ({ label: "photo", bytes: p.bytes })),
      ),
    )
    .toContainEqual(expect.stringMatching(/^disk: .*: photo$/));

  // Ben opens P1 so it is his in full; he never opens P0.
  await b
    .getByRole("button", { name: words("gallery.view", { name: "link-removed-1.png" }) })
    .click({ timeout: 60_000 });
  await expect(b.locator('div.fixed [data-part="photo"] > img:not([data-part])')).toBeVisible({
    timeout: 30_000,
  });
  await b.keyboard.press("Escape");
  await a.goto(`/albums/${id}`);
  await a.setInputFiles("input[type=file]", {
    name: "link-removed-0.png",
    mimeType: "image/png",
    buffer: pngOf(...runColour(71)),
  });
  const p0Tile = (page) =>
    page.getByRole("button", { name: words("gallery.view", { name: "link-removed-0.png" }) });
  await expect(p0Tile(b)).toBeVisible({ timeout: 60_000 });
  // Ada opens P0 so her phone holds its display copy (not only a preview).
  await a
    .getByRole("button", { name: words("gallery.view", { name: "link-removed-0.png" }) })
    .click({ timeout: 30_000 });
  await expect(a.locator('div.fixed [data-part="photo"] > img:not([data-part])')).toBeVisible({
    timeout: 30_000,
  });
  await a.keyboard.press("Escape");
  const isThumb = (name) => Buffer.from(name, "base64url").toString().includes(":thumb");
  const p0All = () => photosOf(aInst, id).filter((p) => !p1.some((q) => q.bytes.equals(p.bytes)));
  await expect
    .poll(() => p0All().some((p) => !isThumb(p.name)), { message: "Ada keeps the older photo" })
    .toBe(true);
  const p0 = p0All();
  await a
    .getByRole("link", { name: /Invite & members/ })
    .first()
    .click();

  const members = a.locator("section", {
    has: a.getByRole("heading", { name: words("album.members") }),
  });
  await members
    .locator("li", { hasText: "Ben" })
    .getByRole("button", { name: pattern("album.remove_name") })
    .click();
  await a
    .getByRole("button", { name: words("album.remove_2"), exact: true })
    .last()
    .click();
  await expect(a.getByText(`is no longer in ${album}.`)).toBeVisible({ timeout: 60_000 });
  await expect(b.getByText(pattern("gallery.you_re_no_longer_in")).first()).toBeVisible({
    timeout: 60_000,
  });

  await expect(p0Tile(b)).toHaveCount(0, { timeout: 30_000 });
  const newKey = (await folderOf(a, aInst, id)).shareKey;
  expect(newKey).not.toBe(oldKey);
  await a.goto(`/albums/${id}`);
  await a.setInputFiles("input[type=file]", {
    name: "link-removed-2.png",
    mimeType: "image/png",
    buffer: pngOf(...runColour(79)),
  });
  await expect(
    a.getByRole("button", { name: "View link-removed-2.png" }).locator("img"),
  ).toBeAttached({
    timeout: 20_000,
  });
  // The move re-files P1 under the new key, same bytes: only P2's bytes are new.
  const later = () =>
    photosOf(aInst, id).filter((p) => ![...p1, ...p0].some((q) => q.bytes.equals(p.bytes)));
  await expect
    .poll(() => later().length, { message: "Ada keeps the later photo" })
    .toBeGreaterThan(0);
  const adaLater = later();

  // Cleo stays in, follows the album to the new key and opens Ada's later photo.
  const followed = async () =>
    (await stateOf(c, cInst)).folders.find(
      (f) => f.shareKey === newKey && f.role === "member" && !f.pending,
    );
  await expect.poll(followed, { timeout: 90_000, message: "Cleo follows the move" }).toBeTruthy();
  const cNew = await followed();
  await c.goto(`/albums/${cNew.id}`);
  await c
    .getByRole("button", { name: words("gallery.view", { name: "link-removed-2.png" }) })
    .click({
      timeout: 60_000,
    });
  await expect
    .poll(
      () => {
        const dir = join(cInst.storageDir, "cache", "photos", cNew.id);
        return readdirSync(dir).some((name) => {
          const bytes = readFileSync(join(dir, name));
          return adaLater.some((p) => p.bytes.equals(bytes));
        });
      },
      { timeout: 60_000, message: "Cleo holds Ada's later photo" },
    )
    .toBe(true);
  await c.keyboard.press("Escape");

  const secrets = [
    { label: "new album key", hex: newKey },
    { label: "Cleo's new drive key", hex: cNew.selfDrive.key },
    ...adaLater.map((p) => ({ label: "later photo bytes", bytes: p.bytes })),
    ...p0
      .filter((p) => !isThumb(p.name))
      .map((p) => ({ label: "older photo never opened", bytes: p.bytes })),
  ];
  // The route a later photo would take: Ben is connected to Cleo while he is scanned.
  await expect
    .poll(
      async () =>
        (await stateOf(b, bInst)).connections.filter((x) => x.identityKey === cIdentity).length,
      { timeout: 60_000, message: "Ben and Cleo connected (the route a later photo would take)" },
    )
    .toBeGreaterThan(0);
  await watchNames(b, ["link-removed-2.png"]);
  await staysClean(b, bInst, secrets, "removed, Cleo on the new key");
  expect(await photoSeen(b), "later photo name on screen: removed").toBe(false);

  // Reloads: the same checks hold, and the photo he had before is still his.
  await b.reload();
  const bId = (await stateOf(b, bInst)).folders.find((f) => f.shareKey === oldKey).id;
  await b.goto(`/albums/${bId}`);
  await expect(
    b.getByRole("button", { name: words("gallery.view", { name: "link-removed-1.png" }) }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    b.getByRole("button", { name: words("gallery.view", { name: "link-removed-2.png" }) }),
  ).toHaveCount(0);
  await expect(p0Tile(b)).toHaveCount(0);
  await staysClean(b, bInst, secrets, "after reload");
  expect(await photoSeen(b), "later photo name on screen: after reload").toBe(false);

  // Uses the old link again.
  await b.goto("/join");
  await b.getByLabel(words("albums.invite_link")).fill(link);
  await b.getByRole("button", { name: words("albums.ask_to_join"), exact: true }).click();
  // B's phone learned of the replacement when it was removed, so it answers by itself.
  await expect(b.getByRole("alert")).toContainText(
    words("join_request.owner_replaced_this_link").replace("{owner} ", ""),
    { timeout: 30_000 },
  );
  await staysClean(b, bInst, secrets, "old link");
  expect(await photoSeen(b), "later photo name on screen: old link").toBe(false);
});
