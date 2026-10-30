// Renders the Play Store icon (512x512) and feature graphic (1024x500) PNGs from
// their SVG sources, using the Playwright Chromium the e2e suite already installs.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../fastlane/metadata/android/en-US/images/", import.meta.url));
// Play wants the icon as a 32-bit PNG (with alpha) and the feature graphic as a
// 24-bit PNG (no alpha). Both are drawn opaque. Page screenshots drop the alpha
// channel of an opaque image, so the icon is encoded through a canvas instead.
const assets = [
  { name: "icon", width: 512, height: 512, alpha: true },
  { name: "featureGraphic", width: 1024, height: 500, alpha: false },
];

const browser = await chromium.launch();
for (const { name, width, height, alpha } of assets) {
  const svg = readFileSync(`${dir}${name}.svg`, "utf8");
  const path = `${dir}${name}.png`;
  const page = await browser.newPage({ viewport: { width, height } });
  if (alpha) {
    const dataUrl = await page.evaluate(
      async ({ svg, width, height }) => {
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await img.decode();
        const canvas = Object.assign(document.createElement("canvas"), { width, height });
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        return canvas.toDataURL("image/png");
      },
      { svg, width, height },
    );
    writeFileSync(path, Buffer.from(dataUrl.split(",")[1], "base64"));
  } else {
    await page.setContent(`<style>*{margin:0}</style>${svg}`);
    await page.locator("svg").screenshot({ path });
  }
  await page.close();
}
await browser.close();
