import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUTS, STORES } from "./stores.mjs";

const CONFIG = "store-listing/images.json";
const PLAIN_NAME = /^[A-Za-z0-9_-]+$/;
const PLAIN_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function fail(message) {
  return { ok: false, message };
}

function lineOf(text, needle) {
  const where = text.indexOf(needle);
  return where < 0 ? "" : ` (line ${text.slice(0, where).split("\n").length})`;
}

function pngSize(path) {
  if (!existsSync(path)) return { ok: true, size: undefined };
  const bytes = readFileSync(path);
  const head = bytes.subarray(0, 24);
  const ended = bytes.subarray(-8, -4).toString("latin1") === "IEND";
  const signature = head.length === 24 && head.subarray(1, 4).toString("latin1") === "PNG" && ended;
  if (!signature) return fail(`${path}: not a PNG image`);
  return { ok: true, size: { width: head.readUInt32BE(16), height: head.readUInt32BE(20) } };
}

function capturesFor(root, name) {
  const found = {};
  for (const store of Object.values(STORES)) {
    const read = pngSize(join(root, "store-listing/captures", store.captureDir, `${name}.png`));
    if (!read.ok) return read;
    found[store.name] = read.size;
  }
  return { ok: true, found };
}

function readImage(root, text, image) {
  const label = `${CONFIG}: image ${JSON.stringify(image?.id)}`;
  if (typeof image !== "object" || image === null)
    return fail(`${CONFIG}: each image must be an object`);
  if (typeof image.id !== "string" || !PLAIN_NAME.test(image.id)) {
    return fail(`${CONFIG}: image id ${JSON.stringify(image.id)} must be letters, digits, _ or -`);
  }
  if (!LAYOUTS.includes(image.layout)) {
    const where = lineOf(text, `"layout": ${JSON.stringify(image.layout)}`);
    return fail(
      `${label}: layout ${JSON.stringify(image.layout)} is not one of ${LAYOUTS.join(", ")}${where}`,
    );
  }
  if (typeof image.headline !== "string" || image.headline.trim() === "") {
    return fail(`${label}: headline must be a non-empty string`);
  }
  const where = lineOf(text, `"capture": ${JSON.stringify(image.capture)}`);
  if (typeof image.capture !== "string" || !PLAIN_NAME.test(image.capture)) {
    return fail(
      `${label}: capture ${JSON.stringify(image.capture)} must be a plain file name${where}`,
    );
  }
  const captures = capturesFor(root, image.capture);
  if (!captures.ok) return captures;
  return { ok: true, image: { ...image, captures: captures.found } };
}

// Parses and validates images.json and finds each image's captures.
export function readListing(root) {
  const path = join(root, CONFIG);
  if (!existsSync(path)) return fail(`${CONFIG}: file not found`);
  const text = readFileSync(path, "utf8");
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return fail(`${CONFIG}: invalid JSON, ${error.message}`);
  }
  const flow = config?.flowPhoto;
  const where = lineOf(text, `"flowPhoto"`);
  if (typeof flow !== "string" || !PLAIN_FILE.test(flow)) {
    return fail(`${CONFIG}: flowPhoto ${JSON.stringify(flow)} must be a plain file name${where}`);
  }
  if (!existsSync(join(root, "assets/sample-photos", flow))) {
    return fail(`${CONFIG}: flowPhoto "${flow}" is not in assets/sample-photos${where}`);
  }
  if (!Array.isArray(config.images) || config.images.length === 0) {
    return fail(`${CONFIG}: images must be a non-empty list`);
  }
  const images = [];
  for (const raw of config.images) {
    const read = readImage(root, text, raw);
    if (!read.ok) return read;
    if (images.some((seen) => seen.id === read.image.id)) {
      return fail(`${CONFIG}: image id ${JSON.stringify(read.image.id)} is used twice`);
    }
    images.push(read.image);
  }
  return { ok: true, flowPhoto: flow, images };
}

const TEXT_FILES = {
  play: {
    dir: "apps/android/fastlane/metadata/android/en-US",
    files: {
      title: "title",
      shortDescription: "short_description",
      description: "full_description",
    },
    icon: "apps/android/fastlane/metadata/android/en-US/images/icon.png",
  },
  ios: {
    dir: "apps/ios/fastlane/metadata/en-US",
    files: {
      name: "name",
      subtitle: "subtitle",
      promotionalText: "promotional_text",
      description: "description",
      keywords: "keywords",
    },
    icon: "apps/ios/app/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png",
  },
};

// Reads each store's listing text (read only). A missing file is an error naming it.
export function readStoreText(root) {
  const text = {};
  for (const [store, { dir, files, icon }] of Object.entries(TEXT_FILES)) {
    text[store] = { icon: `/${icon}` };
    for (const [key, file] of Object.entries(files)) {
      const path = join(root, dir, `${file}.txt`);
      if (!existsSync(path)) return fail(`${dir}/${file}.txt: file not found`);
      text[store][key] = readFileSync(path, "utf8").trim();
    }
  }
  return { ok: true, text };
}

// Everything the mock page shows: images.json and the store text, or the first problem.
export function readMock(root) {
  const listing = readListing(root);
  if (!listing.ok) return listing;
  const text = readStoreText(root);
  if (!text.ok) return text;
  return { ok: true, flowPhoto: listing.flowPhoto, images: listing.images, text: text.text };
}
