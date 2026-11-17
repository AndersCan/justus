import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

export const MIN_PHOTO_PIXELS = 2000;

export function isMarker(red, green, blue) {
  return red >= 180 && blue >= 180 && green <= Math.min(red, blue) - 120;
}

export function markerPixels(png) {
  let count = 0;
  for (let offset = 0; offset < png.width * png.height * 4; offset += 4) {
    if (isMarker(png.data[offset], png.data[offset + 1], png.data[offset + 2])) count++;
  }
  return count;
}

export function photoPixels(file) {
  return markerPixels(PNG.sync.read(readFileSync(file)));
}

export function writeMarker(file) {
  const png = new PNG({ width: 1200, height: 900 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([255, 0, 255, 255], offset);
  }
  writeFileSync(file, PNG.sync.write(png));
}

function main(args) {
  const [command, file, expected] = args;
  if (command === "write" && file) {
    writeMarker(file);
    return 0;
  }
  if (command === "check" && file && (expected === "shows" || expected === "hidden")) {
    let count;
    try {
      count = photoPixels(file);
    } catch (error) {
      console.error(`Can't read ${file}: ${error.message}`);
      return 2;
    }
    const shows = count >= MIN_PHOTO_PIXELS;
    console.log(`${file}: ${count} photo pixels (expected ${shows ? "shows" : "none"})`);
    return shows === (expected === "shows") ? 0 : 1;
  }
  console.error("usage: photo-marker.mjs write <file.png> | check <file.png> shows|hidden");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
