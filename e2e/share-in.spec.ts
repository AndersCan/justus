/**
 * A host hands the web app photos shared from another app: it writes a batch into the
 * worklet's inbox and nudges the page with `justus:shared`. The worklet lists the batch
 * and serves each original's bytes.
 *
 *   pnpm test:e2e e2e/share-in.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openAlbum, pngOf, runColour } from "./add-photos.js";
import { writeSharedBatch } from "./share-in-helper.js";

const CACHE = resolve(".dev-e2e/cache");
const fixture = (n: string) => resolve("e2e/fixtures/share-in", n);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("photos shared from another app are listed and their bytes served", async ({ page }) => {
  const frames: string[] = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) =>
      frames.push(
        typeof f.payload === "string" ? f.payload : Buffer.from(f.payload).toString("latin1"),
      ),
    ),
  );
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });

  const { id } = writeSharedBatch(CACHE, [
    { path: fixture("share-a.jpg"), name: "share-a.jpg" },
    { path: fixture("share-b.png"), name: "share-b.png" },
  ]);
  try {
    await page.evaluate(() => dispatchEvent(new CustomEvent("justus:shared")));
    await expect.poll(() => frames.some((f) => f.includes(id)), { timeout: 10_000 }).toBe(true);

    const frame = frames.find((f) => f.includes(id)) ?? "";
    const batches: { id: string; photos: { name: string; type: string; url: string }[] }[] =
      JSON.parse(frame.slice(frame.indexOf("{"))).result?.batches ?? [];
    const photos = batches.find((b) => b.id === id)?.photos ?? [];
    expect(photos.map((p) => p.name)).toEqual(["share-a.jpg", "share-b.png"]);
    expect(photos.map((p) => p.type)).toEqual(["image/jpeg", "image/png"]);

    const want = [
      sha(readFileSync(fixture("share-a.jpg"))),
      sha(readFileSync(fixture("share-b.png"))),
    ];
    for (const [i, p] of photos.entries()) {
      const got = await page.evaluate(async (url) => {
        const r = await fetch(url);
        const bytes = new Uint8Array(await r.arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return {
          status: r.status,
          type: r.headers.get("content-type"),
          sha: [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join(""),
        };
      }, p.url);
      expect(got).toEqual({ status: 200, type: p.type, sha: want[i] });
    }
  } finally {
    rmSync(resolve(CACHE, "shared-in", id), { recursive: true, force: true });
  }
});

/** Two per-run PNGs on disk, shared as a batch. */
function shareTwo(salt: number, names: [string, string]) {
  const dir = mkdtempSync(join(tmpdir(), "share-in-"));
  const files = names.map((name, i) => {
    const path = join(dir, name);
    writeFileSync(path, pngOf(...runColour(salt + i)));
    return { path, name };
  });
  const { id } = writeSharedBatch(CACHE, files);
  const batchDir = resolve(CACHE, "shared-in", id);
  return {
    batchDir,
    cleanup: () => (
      rmSync(dir, { recursive: true, force: true }),
      rmSync(batchDir, { recursive: true, force: true })
    ),
  };
}

test("photos shared from another app go into the album tapped on the sheet", async ({ page }) => {
  const album = await openAlbum(page);
  const albumUrl = page.url();
  const before = await page.locator("figure img").count();
  await page.goto("/");
  const shared = shareTwo(21, ["share-c.png", "share-d.png"]);
  try {
    await page.evaluate(() => dispatchEvent(new CustomEvent("justus:shared")));
    const sheet = page.getByRole("dialog", { name: "Add 2 photos to" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: `Add 2 photos to ${album}` }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(albumUrl);
    await expect(page.locator("figure img")).toHaveCount(before + 2, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "View share-c.png" })).toBeVisible();
    await expect.poll(() => existsSync(shared.batchDir), { timeout: 10_000 }).toBe(false);
  } finally {
    shared.cleanup();
  }
});

test("Not now removes the shared photos from the inbox and adds nothing", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("figure img").first()).toBeAttached({ timeout: 20_000 });
  const shared = shareTwo(23, ["share-e.png", "share-f.png"]);
  try {
    await page.evaluate(() => dispatchEvent(new CustomEvent("justus:shared")));
    const sheet = page.getByRole("dialog", { name: "Add 2 photos to" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Not now" }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => existsSync(shared.batchDir), { timeout: 10_000 }).toBe(false);
  } finally {
    shared.cleanup();
  }
});

test.describe("a phone start, which passes through the welcome", () => {
  // The Android shell changes the page origin each launch, so the seen flag is gone and the
  // start goes through /welcome until the albums arrive (welcome.ts leavesWelcomeForSavedProfile).
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the sheet opens once the welcome has gone", async ({ page }) => {
    const shared = shareTwo(25, ["share-g.png", "share-h.png"]);
    try {
      await page.goto("/");
      await expect(page).not.toHaveURL(/\/welcome$/, { timeout: 20_000 });
      const sheet = page.getByRole("dialog", { name: "Add 2 photos to" });
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: "Not now" }).click();
      await expect.poll(() => existsSync(shared.batchDir), { timeout: 10_000 }).toBe(false);
    } finally {
      shared.cleanup();
    }
  });
});
