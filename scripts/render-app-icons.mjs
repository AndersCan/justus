// Renders the iOS and desktop app icons from assets/brand/justus-icon.svg, using
// the Playwright Chromium the e2e suite already installs. Outputs are committed;
// rerun after changing the brand icon: node scripts/render-app-icons.mjs
// (macOS only: the .icns step needs `iconutil`). Android's launcher icon is a
// vector drawable and the Play art has its own script
// (apps/android/scripts/render-store-art.mjs).
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(path.join(root, "assets/brand/justus-icon.svg"), "utf8");
// The icon's drawing without its <svg> wrapper: a 1024 tile with rounded corners.
const inner = source.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${body}</svg>`;

// iOS masks the corners itself and rejects icons with transparency: square tile.
const iosSvg = svg(inner.replace(/ rx="[^"]*"/, ""));
// macOS applies no mask: Apple's grid puts an 824px rounded tile in a 1024 canvas.
const macSvg = svg(`<g transform="translate(100 100) scale(0.8046875)">${inner}</g>`);

const browser = await chromium.launch();

/** PNG with alpha, drawn through a canvas (page screenshots drop the alpha). */
async function pngWithAlpha(markup, size) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(
    async ({ markup, size }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      await img.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
      canvas.getContext("2d").drawImage(img, 0, 0, size, size);
      return canvas.toDataURL("image/png");
    },
    { markup, size },
  );
  await page.close();
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/** Opaque PNG (no alpha channel), as App Store Connect requires. */
async function pngOpaque(markup, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
  );
  const png = await page.locator("svg").screenshot();
  await page.close();
  return png;
}

// iOS: a single-size app icon (Xcode 14+ derives the other sizes).
const iconset = path.join(root, "apps/ios/app/Assets.xcassets/AppIcon.appiconset");
mkdirSync(iconset, { recursive: true });
writeFileSync(path.join(iconset, "AppIcon-1024.png"), await pngOpaque(iosSvg, 1024));
writeFileSync(
  path.join(iconset, "Contents.json"),
  `${JSON.stringify(
    {
      images: [
        { filename: "AppIcon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      ],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  path.join(root, "apps/ios/app/Assets.xcassets/Contents.json"),
  `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`,
);

// Desktop: Linux window icon, and the macOS .icns.
const desktop = path.join(root, "apps/desktop/assets");
mkdirSync(desktop, { recursive: true });
writeFileSync(path.join(desktop, "justus.png"), await pngWithAlpha(source, 512));

if (process.platform === "darwin") {
  const work = mkdtempSync(path.join(tmpdir(), "justus-icns-"));
  const set = path.join(work, "Justus.iconset");
  mkdirSync(set);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(path.join(set, `icon_${base}x${base}.png`), await pngWithAlpha(macSvg, base));
    writeFileSync(
      path.join(set, `icon_${base}x${base}@2x.png`),
      await pngWithAlpha(macSvg, base * 2),
    );
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(desktop, "Justus.icns")]);
  rmSync(work, { recursive: true, force: true });
} else {
  console.warn("Skipped Justus.icns: iconutil runs on macOS only.");
}

await browser.close();
console.log("Rendered iOS and desktop app icons.");
