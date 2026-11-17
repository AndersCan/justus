/**
 * A phone that holds only the invite link never gets the album key, a photo or another
 * member's key, in what it stored, in every answer message that reached it, or on its disk.
 * The stranger is instance 2; instances keep earlier specs' state, so every secret is per album.
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

const keyOf = (hex) => ({ label: "album key", hex });

test("a link holder who opens, asks, waits, is declined, asks again and cancels never gets the key, the photo or the member list", async ({
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
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
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
    { label: "photo bytes", bytes: pngOf(...runColour(71)) },
  ];
  const t0 = Date.now();

  // Opens the tapped link and does not ask.
  await b.goto("/");
  await b.evaluate(
    (l) => window.dispatchEvent(new CustomEvent("justus:invite", { detail: l })),
    link,
  );
  const sheet = b.getByRole("dialog", { name: words("invite.ask_to_join", { album }) });
  await expect(sheet).toBeVisible({ timeout: 60_000 });
  await staysClean(b, bInst, secrets, "opened the link");
  await sheet.getByRole("button", { name: words("invite.not_now"), exact: true }).click();

  // Asks and waits.
  await askToJoin(b, link, album);
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  expect((await stateOf(b, bInst)).asks.some((x) => x.status === "waiting")).toBe(true);
  await staysClean(b, bInst, secrets, "waiting");

  // Declined.
  await a.getByRole("button", { name: words("album.decline"), exact: true }).click();
  await expect(b.getByText(pattern("invite.didn_t_accept_your_request"))).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => answerSince(b, bInst, "declined", t0), { timeout: 30_000 }).toBe(true);
  await staysClean(b, bInst, secrets, "declined");

  // Asks again.
  await b.getByRole("button", { name: words("invite.ask_again"), exact: true }).click();
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await staysClean(b, bInst, secrets, "asks again");

  // Cancels.
  await b.goto("/join");
  await b.getByRole("button", { name: new RegExp(`^Waiting for .+ to accept: ${album}$`) }).click();
  await b.getByRole("button", { name: words("invite.cancel_request"), exact: true }).click();
  await expect(b.getByRole("button", { name: new RegExp(album) })).toHaveCount(0);
  await staysClean(b, bInst, secrets, "cancelled");
  await expect(b.locator("img")).toHaveCount(0);
});

test("a stranger who was let in, removed and uses the old link never gets the new key or a later photo", async ({
  instancePages,
  instances,
}) => {
  test.setTimeout(240_000);
  const [a, b] = instancePages;
  const [aInst, bInst] = instances;
  await skipIntro([a, b]);
  const album = `Link removed ${Date.now().toString(36)}`;
  await createAlbum(a, album, "link-removed-1.png", 73);
  const id = new URL(a.url()).pathname.split("/").pop();
  const link = await copyInviteLink(a);

  await askToJoin(b, link, album);
  await expect(a.getByText(`wants to join “${album}”`)).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: "Accept, can add photos", exact: true }).click();
  await expect(b.getByRole("button", { name: `Add photos to ${album}` })).toBeVisible({
    timeout: 60_000,
  });
  const oldKey = (await folderOf(a, aInst, id)).shareKey;
  // The scanner must find a key the stranger really holds, in the store and on disk.
  const held = await leaksOn(b, bInst, [keyOf(oldKey)]);
  expect(held.some((h) => h.startsWith("store:"))).toBe(true);
  expect(held.some((h) => h.startsWith("disk:"))).toBe(true);

  const members = a.locator("section", { has: a.getByRole("heading", { name: "Members" }) });
  await members.getByRole("button", { name: /^Remove /, exact: false }).click();
  await a.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(
    a.getByText(`is no longer in ${album}. Links you sent stopped working.`),
  ).toBeVisible({ timeout: 60_000 });
  await expect(b.getByText(pattern("gallery.you_re_no_longer_in")).first()).toBeVisible({
    timeout: 60_000,
  });

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
  const secrets = [
    { label: "new album key", hex: newKey },
    { label: "later photo bytes", bytes: pngOf(...runColour(79)) },
  ];
  await staysClean(b, bInst, secrets, "removed");

  // Uses the old link again.
  await b.goto("/join");
  await b.getByLabel("Invite link").fill(link);
  await b.getByRole("button", { name: "Ask to join", exact: true }).click();
  // B's phone learned of the replacement when it was removed, so it answers by itself.
  await expect(b.getByRole("alert")).toContainText(
    words("join_request.owner_replaced_this_link").replace("{owner} ", ""),
    { timeout: 30_000 },
  );
  await staysClean(b, bInst, secrets, "old link");
});
