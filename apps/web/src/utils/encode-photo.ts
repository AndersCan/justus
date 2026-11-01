import { DISPLAY_EDGE, RENDITION_EXT, THUMB_EDGE, fitWithin, readTakenAt } from "@justus/core";

/**
 * Makes the copies an album shares from a photo picked in the browser (drag
 * and drop, paste, the desktop app). The native hosts do the same natively;
 * the original never leaves this device either way.
 */

const DISPLAY_QUALITY = 0.85;
const THUMB_QUALITY = 0.78;

/** `IMG_1234.HEIC` → `IMG_1234.jpg`. */
export function renamed(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return `${(dot > 0 ? name.slice(0, dot) : name) || "photo"}${ext}`;
}

/** A decoded photo, upright, and how to release it. */
type Decoded = { image: CanvasImageSource; width: number; height: number; close(): void };

async function decode(file: File): Promise<Decoded> {
  try {
    // Applies the EXIF orientation, so the copies are upright without it.
    const bitmap = await createImageBitmap(file);
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    // Some files an <img> shows, createImageBitmap refuses (Chromium and
    // arithmetic-coded JPEG). An <img> drawn to a canvas is upright too.
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("This photo's format can't be opened on this device");
    }
    return {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  }
}

async function scaled(photo: Decoded, edge: number, quality: number): Promise<Blob> {
  const { width, height } = fitWithin(photo.width, photo.height, edge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device can't resize photos");
  // JPEG has no transparency: put see-through pixels on white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo.image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (!blob) throw new Error("This device can't save photos as JPEG");
  return blob;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
  // `crypto.subtle` needs a secure context; loopback and localhost are.
  if (!globalThis.crypto?.subtle) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type EncodedPhoto = {
  /** The original's name with the display copy's extension. */
  filename: string;
  display: Blob;
  thumb: Blob;
  /** Of the original, so re-adding the same file dedupes. */
  sha256?: string;
  takenAt?: string;
};

export async function encodePhoto(file: File): Promise<EncodedPhoto> {
  const photo = await decode(file);
  try {
    const display = await scaled(photo, DISPLAY_EDGE, DISPLAY_QUALITY);
    const thumb = await scaled(photo, THUMB_EDGE, THUMB_QUALITY);
    const original = await file.arrayBuffer();
    const sha256 = await sha256Hex(original);
    const takenAt = readTakenAt(new Uint8Array(original));
    return {
      filename: renamed(file.name, RENDITION_EXT),
      display,
      thumb,
      ...(sha256 ? { sha256 } : {}),
      ...(takenAt ? { takenAt } : {}),
    };
  } finally {
    photo.close();
  }
}
