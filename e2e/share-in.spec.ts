/**
 * A host hands the web app photos shared from another app: it writes a batch into the
 * worklet's inbox and nudges the page with `justus:shared`. The worklet lists the batch
 * and serves each original's bytes.
 *
 *   pnpm test:e2e e2e/share-in.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
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
