import { describe, expect, it } from "vite-plus/test";
import { readTakenAt } from "./exif-date";

/** A minimal TIFF with IFD0 → Exif IFD holding the given ASCII tags. */
function tiff(tags: Record<number, string>, little = true): Uint8Array {
  const entries = Object.entries(tags).map(([tag, value]) => [Number(tag), `${value}\0`] as const);
  const exifIfdAt = 8 + 2 + 12 + 4; // after header + IFD0 (one entry)
  const dataAt = exifIfdAt + 2 + entries.length * 12 + 4;
  const size = dataAt + entries.reduce((n, [, v]) => n + v.length, 0);
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  buf.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 1, little);
  view.setUint16(10, 0x8769, little);
  view.setUint16(12, 4, little);
  view.setUint32(14, 1, little);
  view.setUint32(18, exifIfdAt, little);
  view.setUint16(exifIfdAt, entries.length, little);
  let data = dataAt;
  entries.forEach(([tag, value], k) => {
    const e = exifIfdAt + 2 + k * 12;
    view.setUint16(e, tag, little);
    view.setUint16(e + 2, 2, little);
    view.setUint32(e + 4, value.length, little);
    view.setUint32(e + 8, data, little);
    for (let i = 0; i < value.length; i++) buf[data + i] = value.charCodeAt(i);
    data += value.length;
  });
  return buf;
}

function jpeg(t: Uint8Array): Uint8Array {
  const header = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
  const len = 2 + header.length + t.length;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    len >> 8,
    len & 0xff,
    ...header,
    ...t,
    0xff,
    0xda,
  ]);
}

function png(t: Uint8Array): Uint8Array {
  const n = t.length;
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    n >>> 24,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
    0x65,
    0x58,
    0x49,
    0x66, // "eXIf"
    ...t,
    0,
    0,
    0,
    0,
  ]);
}

describe("readTakenAt", () => {
  it("reads DateTimeOriginal from a JPEG as zone-less wall-clock time", () => {
    expect(readTakenAt(jpeg(tiff({ 0x9003: "2026:06:20 15:30:05" })))).toBe("2026-06-20T15:30:05");
  });

  it("appends the recorded UTC offset, and reads big-endian TIFF", () => {
    const t = tiff({ 0x9003: "2026:06:20 15:30:05", 0x9011: "+02:00" }, false);
    expect(readTakenAt(jpeg(t))).toBe("2026-06-20T15:30:05+02:00");
  });

  it("falls back to DateTimeDigitized", () => {
    expect(readTakenAt(jpeg(tiff({ 0x9004: "2019:01:02 03:04:05" })))).toBe("2019-01-02T03:04:05");
  });

  it("reads a PNG eXIf chunk", () => {
    expect(readTakenAt(png(tiff({ 0x9003: "2024:12:31 23:59:59" })))).toBe("2024-12-31T23:59:59");
  });

  it("returns undefined for no EXIF, blank dates and garbage", () => {
    expect(readTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda]))).toBeUndefined();
    expect(readTakenAt(jpeg(tiff({ 0x9003: "0000:00:00 00:00:00" })))).toBeUndefined();
    expect(readTakenAt(jpeg(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))).toBeUndefined();
    expect(readTakenAt(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
