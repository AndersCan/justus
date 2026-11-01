/**
 * When a photo was taken, read from its EXIF block (JPEG `APP1` or PNG
 * `eXIf`). Pure and bounded: only the first `MAX_SCAN` bytes are looked at,
 * and any malformed structure yields `undefined` rather than throwing.
 *
 * The result is the camera's wall-clock time as `YYYY-MM-DDTHH:MM:SS`, with
 * `±HH:MM` appended when the camera recorded its UTC offset. Without an offset
 * the time is deliberately left zone-less: "taken at 15:30" stays 15:30.
 */

const MAX_SCAN = 256 * 1024;

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

/** `YYYY-MM-DDTHH:MM:SS` with an optional `±HH:MM` offset. */
export const TAKEN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2})?$/;

export function readTakenAt(bytes: Uint8Array): string | undefined {
  try {
    const tiff = findTiff(bytes.subarray(0, MAX_SCAN));
    return tiff ? takenAtFromTiff(tiff) : undefined;
  } catch {
    return undefined;
  }
}

/** The raw TIFF structure inside a JPEG's Exif APP1 segment or a PNG eXIf chunk. */
function findTiff(b: Uint8Array): Uint8Array | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      if (marker === 0xda || marker === 0xd9) return undefined; // image data: no EXIF
      const len = (b[i + 2] << 8) | b[i + 3];
      const start = i + 4;
      if (
        marker === 0xe1 &&
        ascii(b, start, 4) === "Exif" &&
        b[start + 4] === 0 &&
        b[start + 5] === 0
      ) {
        return b.subarray(start + 6, i + 2 + len);
      }
      i += 2 + len;
    }
    return undefined;
  }
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    let i = 8;
    while (i + 8 <= b.length) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = ascii(b, i + 4, 4);
      if (type === "eXIf") return b.subarray(i + 8, i + 8 + len);
      if (type === "IDAT" || type === "IEND") return undefined;
      i += 12 + len;
    }
  }
  return undefined;
}

function takenAtFromTiff(t: Uint8Array): string | undefined {
  const order = ascii(t, 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const little = order === "II";
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(2) !== 42) return undefined;

  /** tag → value offset (or inline value for LONG) for one IFD. */
  const readIfd = (offset: number) => {
    const entries = new Map<number, { type: number; count: number; at: number }>();
    const n = u16(offset);
    for (let k = 0; k < n; k++) {
      const e = offset + 2 + k * 12;
      entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return entries;
  };
  const text = (entry: { type: number; count: number; at: number } | undefined) => {
    if (!entry || entry.type !== 2) return undefined; // ASCII
    const at = entry.count > 4 ? u32(entry.at) : entry.at;
    const raw = ascii(t, at, entry.count);
    const nul = raw.indexOf("\0");
    return nul === -1 ? raw : raw.slice(0, nul);
  };

  const ifd0 = readIfd(u32(4));
  const exifPointer = ifd0.get(TAG_EXIF_IFD);
  if (!exifPointer) return undefined;
  const exif = readIfd(u32(exifPointer.at));
  const when = text(exif.get(TAG_DATETIME_ORIGINAL)) ?? text(exif.get(TAG_DATETIME_DIGITIZED));
  const m = when && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(when);
  if (!m || m[1] === "0000") return undefined;
  const offset = text(exif.get(TAG_OFFSET_TIME_ORIGINAL));
  const zone = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`;
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
