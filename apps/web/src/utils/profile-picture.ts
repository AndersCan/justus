import { atom } from "nanostores";

const STORAGE_KEY = "justus:profile-picture";
const SIZE = 192;

/** The picture is local to this device (a small data URL); "" means none. */
export function readProfilePicture(): string {
  try {
    const value = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return value?.startsWith("data:image/") ? value : "";
  } catch {
    return "";
  }
}

/** Persist (best-effort). Returns false when storage refused the picture. */
export function writeProfilePicture(dataUrl: string): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    if (dataUrl) localStorage.setItem(STORAGE_KEY, dataUrl);
    else localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export const $profilePicture = atom<string>(readProfilePicture());

/** Centre-crop to a square and downscale, so a 12 MP photo becomes ~10 KB. */
export async function pictureFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      SIZE,
      SIZE,
    );
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

export async function setProfilePictureFromFile(file: File): Promise<boolean> {
  const dataUrl = await pictureFromFile(file);
  if (!writeProfilePicture(dataUrl)) return false;
  $profilePicture.set(dataUrl);
  return true;
}

export function clearProfilePicture(): void {
  writeProfilePicture("");
  $profilePicture.set("");
}
