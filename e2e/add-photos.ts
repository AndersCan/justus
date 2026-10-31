import type { Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

type FilePayload = { name: string; mimeType: string; buffer: Buffer };

/**
 * Picks files with the Photos page's hidden file input, then answers the
 * "Add … to which album?" sheet with its first (suggested) album when it
 * appears: from the All tab it asks whenever more than one album takes
 * photos, which depends on what earlier specs created.
 */
export async function pickPhotos(page: Page, files: FilePayload | FilePayload[]) {
  await page.setInputFiles("input[type=file]", files);
  const sheet = page.getByRole("dialog", { name: /to which album\?$/ });
  const asked = await sheet.waitFor({ timeout: 2_000 }).then(
    () => true,
    () => false,
  );
  if (asked) await sheet.getByRole("listitem").first().getByRole("button").click();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real, decodable 1x1 RGB PNG of the given colour: distinct bytes per
 * colour, so content dedupe doesn't fold one test's photos into another's. */
export function pngOf(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A per-run colour, so reruns against one worklet still add new photos. */
export function runColour(salt: number): [number, number, number] {
  const t = (Date.now() + salt * 7919) % 0xffffff;
  return [(t >> 16) & 0xff, (t >> 8) & 0xff, t & 0xff];
}
