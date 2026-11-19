/**
 * Three phones, one story: Ada adds a photo and Ben joins and gets it. Cy asks to join and reaches Ada's phone, but is not let in.
 * Proves that Ada's photo reached Ben's phone and not Cy's, that every address a phone's peer network used is a phone of this
 * test network, and that no phone's page asked for anything outside its own phone.
 *
 *   pnpm test:e2e-p2p -g "no server"
 *
 * A new network dependency fails here: change `addresses.mjs` only with the owner's yes and the privacy page.
 */
// @ts-nocheck: the hub fixtures are untyped .mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { expect, test } from "../hub/fixtures.mjs";
import { addressReport } from "../hub/addresses.mjs";
import { noisePng } from "../add-photos.js";
import {
  askToJoin,
  closePhoto,
  copyInviteLink,
  createAlbum,
  setName,
  skipIntro,
  words,
} from "./steps";

const FILE = "no-server.png";

/** Every URL the phone's page asked for, or was stopped from asking for, outside its own phone. */
async function watchPage(page, instance) {
  const own = new URL(instance.url).host;
  const outside = [];
  const note = (url) => {
    if (!/^(https?|wss?):/.test(url)) return; // data:, blob:, about:, and CSP's "inline"/"eval"
    if (new URL(url).host !== own) outside.push(url);
  };
  page.context().on("request", (r) => note(r.url()));
  page.on("websocket", (ws) => note(ws.url()));
  await page.context().exposeFunction("__justusBlocked", note);
  await page
    .context()
    .addInitScript(() =>
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__justusBlocked(e.blockedURI),
      ),
    );
  return outside;
}

/** True when any file under `dir` contains `mark`. */
function holds(dir, mark) {
  return readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return holds(path, mark);
    return entry.isFile() && statSync(path).size > 0 && readFileSync(path).includes(mark);
  });
}

async function addressesOf(page, instance) {
  const res = await page.context().request.get(new URL("/__state", instance.url).href);
  return (await res.json()).addresses;
}

test("runs with no server: Ada's photo stays on Ben's phone and every phone and page stays inside the test network", async ({
  instancePages,
  instances,
}, testInfo) => {
  // 240 s: three phones, an invite, an ask.
  test.setTimeout(240_000);
  const since = Date.now();
  const ALBUM = `No server trip ${testInfo.repeatEachIndex + 1}`;
  const [a, b, c] = instancePages;
  const outsidePages = await Promise.all(instancePages.map((p, i) => watchPage(p, instances[i])));

  await skipIntro([a, b, c]);
  await setName(a, "Ada");
  await setName(b, "Ben");
  await setName(c, "Cy");
  await createAlbum(a, ALBUM, "no-server-cover.png", 71);
  await a.setInputFiles("input[type=file]", {
    name: FILE,
    mimeType: "image/png",
    buffer: noisePng(64, 64),
  });
  // 20 s: the photo is encoded and added.
  await expect(
    a.getByRole("button", { name: words("gallery.view", { name: FILE }) }).locator("img"),
  ).toBeAttached({ timeout: 20_000 });

  // 32 bytes of the display copy: noise, so found nowhere else.
  await a.getByRole("button", { name: words("gallery.view", { name: FILE }) }).click();
  const src = await a.locator("[data-lightbox] img[src]").last().getAttribute("src");
  // The page reads it: the phone's photo route answers Playwright's own client with a doubled Content-Length.
  const copy = Buffer.from(
    await a.evaluate(async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
    }, src),
    "base64",
  );
  const mark = copy.subarray(Math.floor(copy.length / 2), Math.floor(copy.length / 2) + 32);
  await closePhoto(a);

  const link = await copyInviteLink(a);
  await askToJoin(b, link, ALBUM);
  // 60 s: the ask travels over the hub to Ada's phone.
  await expect(
    a.getByText(words("album.wants_to_join", { folderName: ALBUM })).first(),
  ).toBeVisible({ timeout: 60_000 });
  await a.getByRole("button", { name: words("album.accept_as_collaborator"), exact: true }).click();
  await a.getByRole("link", { name: words("album.see_photos_in_this_album") }).click();
  const benPhoto = b.getByRole("button", { name: words("gallery.view", { name: FILE }) });
  // 60 s: the album and its photo sync to Ben's phone after Ada accepts.
  await expect(benPhoto).toBeVisible({ timeout: 60_000 });
  await benPhoto.click();

  await askToJoin(c, link, ALBUM);
  await a
    .getByRole("link", { name: words("gallery.invite_members") })
    .first()
    .click();
  // 60 s: Cy's ask (Ben's is answered) reaches Ada's phone, so Cy's phone was connected to hers.
  await expect(
    a.getByText(words("album.wants_to_join", { folderName: ALBUM })),
    "Cy's ask reached Ada's phone",
  ).toHaveCount(1, { timeout: 60_000 });

  await expect
    .poll(() => holds(instances[1].storageDir, mark), {
      message: "Ben's phone holds the photo's bytes (the search itself works)",
      // 20 s: his spool and store write the file just after his phone shows it.
      timeout: 20_000,
    })
    .toBe(true);
  expect(
    holds(instances[2].storageDir, mark),
    "Cy's phone is connected and asked, but holds none of the photo's bytes",
  ).toBe(false);

  function read() {
    return Promise.all(instancePages.map((p, i) => addressesOf(p, instances[i])));
  }
  const first = await read();
  const second = await read();
  const here = new Set([
    "127.0.0.1",
    "::1",
    ...Object.values(networkInterfaces())
      .flat()
      .map((i) => i.address),
  ]);
  const names = ["Ada", "Ben", "Cy"];
  const outside = addressReport({
    since,
    here,
    phones: names.map((name, i) => ({
      name,
      log: { ...second[i], bound: { ...first[i].bound, ...second[i].bound } },
    })),
  });
  expect(
    outside,
    "every address a phone used is a lookup packet or a phone of the test network",
  ).toEqual([]);
  for (const [i, name] of names.entries()) {
    expect(
      Object.values(second[i].streams).some((last) => last >= since),
      `${name}'s phone has a connection this run checks`,
    ).toBe(true);
  }
  for (const [i, name] of names.entries()) {
    expect(outsidePages[i], `${name}'s page asked for nothing outside its phone`).toEqual([]);
  }

  // Clean-up, so later specs meet no open ask.
  await a.getByRole("button", { name: words("album.decline"), exact: true }).click();
  // 20 s: the decline reaches the card and removes it.
  await expect(a.getByText(words("album.wants_to_join", { folderName: ALBUM }))).toHaveCount(0, {
    timeout: 20_000,
  });
});
