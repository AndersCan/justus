// An unreadable flowPhoto must fail the render, not export an empty white card.
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repo = join(import.meta.dirname, "..");
const configFile = join(repo, "store-listing/images.json");
const broken = join(repo, "assets/sample-photos/zz-not-a-photo.jpg");
const captures = join(repo, "store-listing/captures/android");
const names = ["album", "invite", "photo", "settings", "help"];

async function writeCaptures(missing: string[]) {
  mkdirSync(captures, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 2160 } });
  for (const name of missing) {
    await page.setContent(`<body style="margin:0;background:#3a3"></body>`);
    await page.screenshot({ path: join(captures, `${name}.png`) });
  }
  await browser.close();
}

describe("flow photo", () => {
  it("fails the render when flowPhoto exists but is not an image", async () => {
    const original = readFileSync(configFile, "utf8");
    const hadCaptures = names.map((name) => existsSync(join(captures, `${name}.png`)));
    try {
      await writeCaptures(names.filter((_, at) => !hadCaptures[at]));
      writeFileSync(broken, "not a jpeg");
      writeFileSync(
        configFile,
        original.replace(/"flowPhoto": "[^"]*"/, `"flowPhoto": "zz-not-a-photo.jpg"`),
      );
      const run = spawnSync("node", ["store-listing/render.mjs", "--store", "play"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/flowPhoto|zz-not-a-photo/);
    } finally {
      writeFileSync(configFile, original);
      rmSync(broken, { force: true });
      names.forEach((name, at) => {
        if (!hadCaptures[at]) rmSync(join(captures, `${name}.png`), { force: true });
      });
    }
  }, 60_000);

  it("draws the coral path in each of the first three images", async () => {
    const hadCaptures = names.map((name) => existsSync(join(captures, `${name}.png`)));
    try {
      await writeCaptures(names.filter((_, at) => !hadCaptures[at]));
      const run = spawnSync("node", ["store-listing/render.mjs", "--store", "play"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      const browser = await chromium.launch();
      const page = await browser.newPage();
      const counts: number[] = [];
      for (const file of ["01_private", "02_you_choose", "03_phone_to_phone"]) {
        const data = readFileSync(join(repo, "store-listing/out/play", `${file}.png`)).toString(
          "base64",
        );
        counts.push(
          await page.evaluate(async (src) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let n = 0;
            for (let i = 0; i < px.length; i += 4) {
              if (
                Math.abs(px[i] - 255) < 20 &&
                Math.abs(px[i + 1] - 138) < 20 &&
                Math.abs(px[i + 2] - 91) < 20
              )
                n++;
            }
            return n;
          }, `data:image/png;base64,${data}`),
        );
      }
      await browser.close();
      for (const n of counts) expect(n).toBeGreaterThan(1000);
    } finally {
      names.forEach((name, at) => {
        if (!hadCaptures[at]) rmSync(join(captures, `${name}.png`), { force: true });
      });
    }
  }, 120_000);

  it("keeps a capture that already exists when it fills in the missing ones", async () => {
    const album = join(captures, "album.png");
    const saved = existsSync(album) ? readFileSync(album) : undefined;
    const hadCaptures = names.map((name) => existsSync(join(captures, `${name}.png`)));
    try {
      mkdirSync(captures, { recursive: true });
      const real = readFileSync(join(repo, "assets/brand/justus-wordmark-dark.png"));
      writeFileSync(album, real);
      await writeCaptures(names.filter((name) => !existsSync(join(captures, `${name}.png`))));
      expect(readFileSync(album).equals(real)).toBe(true);
    } finally {
      names.forEach((name, at) => {
        if (!hadCaptures[at]) rmSync(join(captures, `${name}.png`), { force: true });
      });
      if (saved) writeFileSync(album, saved);
      else rmSync(album, { force: true });
    }
  }, 60_000);
});
