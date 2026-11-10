// An unreadable flowPhoto must fail the render, not export an empty white card.
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repo = join(import.meta.dirname, "..");
const configFile = join(repo, "store-listing/images.json");
const broken = join(repo, "assets/sample-photos/zz-not-a-photo.jpg");
const captures = join(repo, "store-listing/captures/android");
const names = ["album", "invite", "photo", "settings", "help"];

// Pushes each name into `written` right after its screenshot, so a throw midway still lets the caller clean up.
async function writeCaptures(written: string[], dir = captures) {
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 2160 } });
    for (const name of names) {
      if (existsSync(join(dir, `${name}.png`))) continue;
      await page.setContent(`<body style="margin:0;background:#3a3"></body>`);
      await page.screenshot({ path: join(dir, `${name}.png`) });
      written.push(name);
    }
  } finally {
    await browser.close();
  }
}

function removeWritten(written: string[]) {
  for (const name of written) rmSync(join(captures, `${name}.png`), { force: true });
}

describe("flow photo", () => {
  it("fails the render when flowPhoto exists but is not an image", async () => {
    const original = readFileSync(configFile, "utf8");
    const written: string[] = [];
    try {
      await writeCaptures(written);
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
      removeWritten(written);
    }
  }, 60_000);

  it("draws the coral path in each of the first three images", async () => {
    const written: string[] = [];
    try {
      await writeCaptures(written);
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
      removeWritten(written);
    }
  }, 120_000);

  it("keeps a capture that already exists when it fills in the missing ones", async () => {
    const album = join(captures, "album.png");
    const saved = existsSync(album) ? readFileSync(album) : undefined;
    const written: string[] = [];
    try {
      mkdirSync(captures, { recursive: true });
      const real = readFileSync(join(repo, "assets/brand/justus-wordmark-dark.png"));
      writeFileSync(album, real);
      await writeCaptures(written);
      expect(readFileSync(album).equals(real)).toBe(true);
    } finally {
      removeWritten(written);
      if (saved) writeFileSync(album, saved);
      else rmSync(album, { force: true });
    }
  }, 60_000);

  it("reports only the captures it wrote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "captures-"));
    const written: string[] = [];
    try {
      writeFileSync(join(dir, "invite.png"), "real");
      writeFileSync(join(dir, "help.png"), "real");
      await writeCaptures(written, dir);
      expect(written).toEqual(["album", "photo", "settings"]);
      expect(readFileSync(join(dir, "invite.png"), "utf8")).toBe("real");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("still reports what it wrote when a screenshot fails midway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "captures-"));
    const written: string[] = [];
    try {
      symlinkSync(join(dir, "no-such-dir/x.png"), join(dir, "photo.png"));
      await expect(writeCaptures(written, dir)).rejects.toThrow();
      expect(written).toEqual(["album", "invite"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
